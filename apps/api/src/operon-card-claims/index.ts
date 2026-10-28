import { and, eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  activityTable,
  agentCardClaimsTable,
  apikeyTable,
  labelTable,
  projectTable,
  taskRelationTable,
  taskTable,
  timeEntryTable,
  userTable,
  workspaceUserTable,
} from "../database/schema";
import { publishEvent } from "../events";
import type { BaseVariables } from "../openapi";
import { operonKeyKind } from "../operon-agent-liveness";
import { collectDeferred } from "./after-commit";

/**
 * Operon fork addition (agents-first-class Phase 3 D8, docs/fork-discipline.md row 19): an
 * Operon agent's claim on one card, so two agents never work the same card and an agent whose
 * lease ran out cannot keep changing it.
 *
 * `POST /api/operon/card-claims/:taskId {requestId}` — agent keys only. ONE transaction locks
 * the task row, then its claim row (THE lock order everywhere: claim, guard, release and every
 * person's reassignment), and then: the same claimer + requestId on an active claim answers the
 * same generation with nothing written; another live claim is 409 `claimed`; a card assigned to a
 * person is 409 `assigned_elsewhere` (people win, Q8), and so is one assigned to another agent
 * unless that agent's claim on this card exists with an expired lease; otherwise generation + 1,
 * `active`, a 15-minute lease, the assignee set to the caller when it differs, and ONE "On it"
 * comment (the `createComment` activity insert) — the claim, the assignee and the comment commit
 * together or not at all. Events run after commit, once, for a winning claim only.
 *
 * `DELETE /api/operon/card-claims/:taskId?done=true|false` with `X-Operon-Card-Generation` —
 * the claimer releases (or finishes) its claim; a stale generation is 409 `claim_lost`.
 *
 * Logs (`operon.card_claim`, `operon.card_claim_refused`) carry ids, generations and codes.
 */

export const LEASE_MS = 15 * 60 * 1000;
export const CARD_GENERATION_HEADER = "X-Operon-Card-Generation";
const REQUEST_ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
export const ON_IT = "On it";

type Executor = Pick<
  typeof db,
  "select" | "insert" | "update" | "delete" | "execute"
>;
export type CardTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** What a guarded controller runs its reads and writes on: the request's transaction, or `db`. */
export type CardExecutor = typeof db | CardTx;

function log(line: Record<string, unknown>) {
  // Ids, generations and codes only (Operon logging rule): never a title, a comment or a key.
  console.info(JSON.stringify(line));
}

/** The caller's user id when THIS request authenticated with an Operon agent key, else null. */
export async function operonAgentUser(c: Context): Promise<string | null> {
  const apiKey = c.get("apiKey") as
    | { id?: string; userId?: string }
    | undefined;
  if (!apiKey?.id || !apiKey.userId) return null;
  const [row] = await db
    .select({ metadata: apikeyTable.metadata })
    .from(apikeyTable)
    .where(eq(apikeyTable.id, apiKey.id))
    .limit(1);
  return row && operonKeyKind(row.metadata) === "agent" ? apiKey.userId : null;
}

/** A bounded refusal, answered as `{ error: code }` with its status. */
export class CardClaimError extends HTTPException {
  constructor(
    status: 403 | 404 | 409,
    readonly code: string,
  ) {
    super(status, {
      message: code,
      res: new Response(JSON.stringify({ error: code }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    });
  }
}

/** Lock the task row, then its claim row (the one lock order). */
export async function lockTaskThenClaim(tx: Executor, taskId: string) {
  const [task] = await tx
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, taskId))
    .for("update");
  const [claim] = task
    ? await tx
        .select()
        .from(agentCardClaimsTable)
        .where(eq(agentCardClaimsTable.taskId, taskId))
        .for("update")
    : [];
  return { task: task ?? null, claim: claim ?? null };
}

const leaseLive = (claim: { leaseUntil: Date }) =>
  claim.leaseUntil.getTime() > Date.now();

/**
 * A person's reassignment (or unassignment) wins over an active claim: inside the caller's
 * transaction, AFTER `lockTaskThenClaim`, an active claim whose claimer is not the new
 * assignee is revoked. Returns whether one was.
 */
export async function revokeIfReassigned(
  tx: Executor,
  claim: typeof agentCardClaimsTable.$inferSelect | null,
  newAssigneeId: string | null,
) {
  if (claim?.state !== "active" || claim.claimer === newAssigneeId)
    return false;
  await tx
    .update(agentCardClaimsTable)
    .set({ state: "revoked", updatedAt: new Date() })
    .where(eq(agentCardClaimsTable.taskId, claim.taskId));
  log({
    evt: "operon.card_claim_revoked",
    task_id: claim.taskId,
    generation: claim.generation,
  });
  return true;
}

async function workspaceOf(tx: Executor, projectId: string) {
  const [p] = await tx
    .select({ workspaceId: projectTable.workspaceId })
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .limit(1);
  return p?.workspaceId ?? null;
}

async function isWorkspaceMember(
  tx: Executor,
  userId: string,
  workspaceId: string,
) {
  const [m] = await tx
    .select({ userId: workspaceUserTable.userId })
    .from(workspaceUserTable)
    .where(
      and(
        eq(workspaceUserTable.userId, userId),
        eq(workspaceUserTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return Boolean(m);
}

export interface ClaimResult {
  status: 200 | 201;
  generation: number;
  leaseUntil: Date;
}

/**
 * The claim transaction (D8). Answers the result and, for a winning claim, the post-commit
 * events to publish; a refusal throws `CardClaimError` and rolls everything back.
 */
export async function claimCard(
  agentId: string,
  taskId: string,
  requestId: string,
): Promise<ClaimResult> {
  const out = await db.transaction(async (tx) => {
    const { task, claim } = await lockTaskThenClaim(tx, taskId);
    if (!task) throw new CardClaimError(404, "task_not_found");
    const workspaceId = await workspaceOf(tx, task.projectId);
    if (!workspaceId || !(await isWorkspaceMember(tx, agentId, workspaceId)))
      throw new CardClaimError(403, "not_a_workspace_member");
    if (
      claim &&
      claim.state === "active" &&
      claim.claimer === agentId &&
      claim.requestId === requestId
    ) {
      return {
        status: 200 as const,
        generation: claim.generation,
        leaseUntil: claim.leaseUntil,
        events: null,
      };
    }
    if (claim && claim.state === "active" && leaseLive(claim))
      throw new CardClaimError(409, "claimed");
    if (task.userId && task.userId !== agentId) {
      // People win (Q8); another agent's card only once its own claim here has expired.
      const expiredAgentClaim =
        claim && claim.claimer === task.userId && !leaseLive(claim);
      if (!expiredAgentClaim)
        throw new CardClaimError(409, "assigned_elsewhere");
    }
    const generation = (claim?.generation ?? 0) + 1;
    const leaseUntil = new Date(Date.now() + LEASE_MS);
    await tx
      .insert(agentCardClaimsTable)
      .values({
        taskId,
        claimer: agentId,
        generation,
        state: "active",
        requestId,
        leaseUntil,
      })
      .onConflictDoUpdate({
        target: agentCardClaimsTable.taskId,
        set: {
          claimer: agentId,
          generation,
          state: "active",
          requestId,
          leaseUntil,
          claimedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
    const assigneeChanged = task.userId !== agentId;
    if (assigneeChanged) {
      await tx
        .update(taskTable)
        .set({ userId: agentId })
        .where(eq(taskTable.id, taskId));
    }
    // The createComment activity insert, inside this transaction (D8): its events run after commit.
    const [activity] = await tx
      .insert(activityTable)
      .values({ taskId, type: "comment", userId: agentId, content: ON_IT })
      .returning();
    if (!activity) throw new Error("the On it comment was not stored");
    return {
      status: 201 as const,
      generation,
      leaseUntil,
      events: { task, assigneeChanged, activity },
    };
  });
  if (out.events) {
    const { task, assigneeChanged, activity } = out.events;
    const [agent] = await db
      .select({ name: userTable.name })
      .from(userTable)
      .where(eq(userTable.id, agentId))
      .limit(1);
    if (assigneeChanged) {
      await publishEvent("task.assignee_changed", {
        taskId,
        projectId: task.projectId,
        userId: agentId,
        oldAssignee: task.userId,
        newAssignee: agent?.name,
        newAssigneeId: agentId,
        title: task.title,
        type: "assignee_changed",
      });
    }
    await publishEvent("comment.created", {
      ...activity,
      comment: `**${agent?.name}** commented:\n> ${ON_IT}`,
      projectId: task.projectId,
    });
    log({
      evt: "operon.card_claim",
      task_id: taskId,
      generation: out.generation,
    });
  }
  return {
    status: out.status,
    generation: out.generation,
    leaseUntil: out.leaseUntil,
  };
}

/** Release (or finish) the caller's claim at `generation`. */
export async function releaseCard(
  agentId: string,
  taskId: string,
  generation: number,
  done: boolean,
) {
  return db.transaction(async (tx) => {
    const { task, claim } = await lockTaskThenClaim(tx, taskId);
    if (!task) throw new CardClaimError(404, "task_not_found");
    if (
      !claim ||
      claim.claimer !== agentId ||
      claim.generation !== generation ||
      claim.state !== "active"
    )
      throw new CardClaimError(409, "claim_lost");
    const state = done ? "done" : "released";
    await tx
      .update(agentCardClaimsTable)
      .set({ state, updatedAt: new Date() })
      .where(eq(agentCardClaimsTable.taskId, taskId));
    return { state, generation };
  });
}

/**
 * The guard (D8, R13): an agent key's change to an existing card runs in ONE transaction that
 * locks the task row then its claim row and requires `X-Operon-Card-Generation`, an active claim
 * by the caller at that generation with a live lease, and the caller as the task's assignee; the
 * lease is renewed (Q9), then `run(tx)` performs the mutation on that transaction, and the
 * assignee is RE-READ in it: a write that moved the card away from the caller rolls back (409
 * `assignee_not_self`). An agent-key body that names another assignee is refused before `run`
 * (handing a card back is `card_release`). For a delete, the locked precondition and the
 * successful delete stand in for the impossible post-delete read; the claim row goes with the
 * task by the foreign key. Events, notifications and asset cleanup queued during `run` happen only
 * after commit (`after-commit.ts`). A person's request runs `run(db)` unchanged.
 */
export async function withCardClaim<T>(
  c: Context,
  taskId: string | null | undefined,
  run: (executor: CardExecutor) => Promise<T>,
  opts: { deleting?: boolean; assignee?: string | null } = {},
): Promise<T> {
  const agentId = await operonAgentUser(c);
  if (!agentId) return run(db);
  if (!taskId) throw new CardClaimError(404, "task_not_found");
  const generation = Number(c.req.header(CARD_GENERATION_HEADER));
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw refuse(taskId, 409, "claim_required");
  if (opts.assignee !== undefined && opts.assignee !== agentId)
    throw refuse(taskId, 409, "assignee_not_self");
  const { result, flush } = await collectDeferred(() =>
    db.transaction(async (tx) => {
      const { task, claim } = await lockTaskThenClaim(tx, taskId);
      if (!task) throw new CardClaimError(404, "task_not_found");
      if (!claim) throw refuse(taskId, 409, "claim_required");
      if (
        claim.claimer !== agentId ||
        claim.generation !== generation ||
        claim.state !== "active" ||
        !leaseLive(claim) ||
        task.userId !== agentId
      )
        throw refuse(taskId, 409, "claim_lost");
      await tx
        .update(agentCardClaimsTable)
        .set({
          leaseUntil: new Date(Date.now() + LEASE_MS),
          updatedAt: new Date(),
        })
        .where(eq(agentCardClaimsTable.taskId, taskId));
      const out = await run(tx);
      if (!opts.deleting) {
        const [after] = await tx
          .select({ userId: taskTable.userId })
          .from(taskTable)
          .where(eq(taskTable.id, taskId));
        if (after?.userId !== agentId)
          throw refuse(taskId, 409, "assignee_not_self");
      }
      return out;
    }),
  );
  await flush();
  return result;
}

function refuse(taskId: string, status: 409, code: string) {
  log({ evt: "operon.card_claim_refused", task_id: taskId, reason: code });
  return new CardClaimError(status, code);
}

/** Agent keys may not use the routes that change many cards or write a raw activity row (D10). */
export async function refuseAgentRoute(c: Context) {
  if (await operonAgentUser(c)) {
    log({ evt: "operon.card_route_refused", path: c.req.path });
    throw new CardClaimError(403, "agent_route_not_allowed");
  }
}

/** The task a comment (an `activity` row of type comment) belongs to. */
export async function taskOfComment(activityId: string) {
  const [row] = await db
    .select({ taskId: activityTable.taskId })
    .from(activityTable)
    .where(eq(activityTable.id, activityId))
    .limit(1);
  return row?.taskId ?? null;
}
export async function taskOfLabel(labelId: string) {
  const [row] = await db
    .select({ taskId: labelTable.taskId })
    .from(labelTable)
    .where(eq(labelTable.id, labelId))
    .limit(1);
  return row?.taskId ?? null;
}
export async function sourceOfRelation(relationId: string) {
  const [row] = await db
    .select({ taskId: taskRelationTable.sourceTaskId })
    .from(taskRelationTable)
    .where(eq(taskRelationTable.id, relationId))
    .limit(1);
  return row?.taskId ?? null;
}
export async function taskOfTimeEntry(entryId: string) {
  const [row] = await db
    .select({ taskId: timeEntryTable.taskId })
    .from(timeEntryTable)
    .where(eq(timeEntryTable.id, entryId))
    .limit(1);
  return row?.taskId ?? null;
}

/**
 * D10's inventory: every non-GET route of the task-scoped modules and what an agent key gets.
 * `tests/api-integration/operon-card-guard.test.ts` enumerates the app's registered routes and
 * fails on any route under these prefixes that is missing here.
 */
export const CARD_ROUTE_CLASSES: Record<
  string,
  "guarded" | "refused" | "unguarded" | "unchanged" | "label"
> = {
  "PUT /api/task/:id": "guarded",
  "PUT /api/task/move/:id": "guarded",
  "PUT /api/task/status/:id": "guarded",
  "PUT /api/task/priority/:id": "guarded",
  "PUT /api/task/assignee/:id": "guarded",
  "PUT /api/task/due-date/:id": "guarded",
  "PUT /api/task/title/:id": "guarded",
  "PUT /api/task/description/:id": "guarded",
  "DELETE /api/task/:id": "guarded",
  "PUT /api/task/image-upload/:id": "guarded",
  "POST /api/task/image-upload/:id/finalize": "guarded",
  "POST /api/comment/:taskId": "guarded",
  "PUT /api/comment/:id": "guarded",
  "DELETE /api/comment/:id": "guarded",
  "POST /api/activity/comment": "guarded",
  "PUT /api/activity/comment": "guarded",
  "DELETE /api/activity/comment": "guarded",
  "PUT /api/label/:id/task": "guarded",
  "DELETE /api/label/:id/task": "guarded",
  "POST /api/task-relation": "guarded",
  "DELETE /api/task-relation/:id": "guarded",
  "POST /api/time-entry": "guarded",
  "PUT /api/time-entry/:id": "guarded",
  "PUT /api/custom-field/value": "guarded",
  "PATCH /api/task/bulk": "refused",
  "POST /api/task/import/:projectId": "refused",
  "POST /api/activity/create": "refused",
  "POST /api/task/:projectId": "unguarded",
  // "label": a task label (one card's) is guarded by that card's claim; a workspace label's update
  // or delete cascades to every card's copy and is refused for agent keys; creating a workspace
  // label changes no card and stays unguarded.
  "POST /api/label": "label",
  "PUT /api/label/:id": "label",
  "DELETE /api/label/:id": "label",
  "POST /api/custom-field": "unchanged",
  "PUT /api/custom-field/reorder/:projectId": "unchanged",
  "DELETE /api/custom-field/:id": "unchanged",
};

function refusal(c: Context, err: unknown, taskId: string) {
  if (err instanceof CardClaimError) {
    log({
      evt: "operon.card_claim_refused",
      task_id: taskId,
      reason: err.code,
    });
    return c.json({ error: err.code }, err.status);
  }
  throw err;
}

const operonCardClaims = new Hono<{ Variables: BaseVariables }>()
  .post("/card-claims/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const agentId = await operonAgentUser(c);
    if (!agentId) return c.json({ error: "agent_key_required" }, 403);
    const body = (await c.req.json().catch(() => null)) as {
      requestId?: unknown;
    } | null;
    const requestId = body?.requestId;
    if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId))
      return c.json({ error: "requestId is malformed" }, 400);
    try {
      const r = await claimCard(agentId, taskId, requestId);
      return c.json(
        { generation: r.generation, leaseUntil: r.leaseUntil.toISOString() },
        r.status,
      );
    } catch (err) {
      return refusal(c, err, taskId);
    }
  })
  .delete("/card-claims/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const agentId = await operonAgentUser(c);
    if (!agentId) return c.json({ error: "agent_key_required" }, 403);
    const generation = Number(c.req.header(CARD_GENERATION_HEADER));
    if (!Number.isSafeInteger(generation) || generation < 1)
      return c.json({ error: "claim_required" }, 409);
    try {
      const r = await releaseCard(
        agentId,
        taskId,
        generation,
        c.req.query("done") === "true",
      );
      return c.json(r, 200);
    } catch (err) {
      return refusal(c, err, taskId);
    }
  });

export default operonCardClaims;
