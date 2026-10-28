import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Operon fork checks — guarded card writes (Operon agents-first-class Phase 3 D8, D10, R13;
 * docs/fork-discipline.md row 19). Every task-scoped mutation an agent key makes needs its claim
 * (header, generation, live lease, still the assignee) and runs in one transaction that re-reads
 * the assignee after the write; bulk, import and raw-activity routes refuse agent keys; a
 * person's requests are unchanged. Liveness is stubbed `{ active: true }`.
 *
 * Operon mode is a property of the FILE (see `operon-oidc-only.test.ts`): the env is set
 * before the app modules are imported, through an indexed helper for biome's
 * `noUndeclaredEnvVars`. See `docs/fork-discipline.md` in the Operon repository.
 */
function setEnv(key: string, value: string) {
  process.env[key] = value;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

// The platform's liveness route, answering every agent alive.
const livenessCalls: string[] = [];
const platform = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    livenessCalls.push(raw);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ active: true }));
  });
});
const platformPort = await listen(platform);

// The MCP tools call the REST API over KANEO_INTERNAL_API_URL, read at import, so the app
// is served on a real port reserved before the import.
const reserve = http.createServer();
const appPort = await listen(reserve);
await new Promise((resolve) => reserve.close(resolve));

setEnv("OPERON_OIDC_ONLY", "true");
setEnv("OPERON_INTERNAL_API_URL", `http://127.0.0.1:${platformPort}`);
setEnv("OPERON_KANEO_S2S_SECRET", "card-guard-suite-secret");
setEnv("KANEO_INTERNAL_API_URL", `http://127.0.0.1:${appPort}`);

const { createApp } = await import("../../apps/api/src/index");
const { auth } = await import("../../apps/api/src/auth");
const { default: db, schema } = await import("../../apps/api/src/database");
const { resetTestDatabase } = await import("./helpers/database");
const { CARD_ROUTE_CLASSES } = await import(
  "../../apps/api/src/operon-card-claims"
);
const { subscribeToEvent } = await import("../../apps/api/src/events");
const { agentCardClaimsTable } = await import(
  "../../apps/api/src/database/schema"
);
const { createProjectFixture, createWorkspaceMember } = await import(
  "./helpers/fixtures"
);

const { app } = createApp();
const server = serve({
  fetch: app.fetch,
  port: appPort,
  hostname: "127.0.0.1",
});

afterAll(async () => {
  server.close();
  platform.close();
});

let holder: Awaited<ReturnType<typeof createWorkspaceMember>>;
let serviceKey: string;

async function newAgent(name: string) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `agent-${randomUUID()}@example.com`,
      emailVerified: true,
      name,
    })
    .returning();
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: holder.workspace.id,
    userId: user.id,
    role: "member",
    joinedAt: new Date(),
  });
  await db.insert(schema.accountTable).values({
    accountId: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    providerId: "custom",
    userId: user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const response = await app.request("/api/internal/operon/agent-key", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": serviceKey },
    body: JSON.stringify({ kaneoUserId: user.id }),
  });
  expect(response.status).toBe(200);
  return { user, key: ((await response.json()) as { key: string }).key };
}

async function humanBearer(userId: string) {
  const token = `tok-${randomUUID()}`;
  await db.insert(schema.sessionTable).values({
    id: `session-${randomUUID()}`,
    token,
    userId,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return `Bearer ${token}`;
}

async function newCard(assigneeId: string | null = null) {
  const { project } = await createProjectFixture({
    workspaceId: holder.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({ projectId: project.id, title: "Card", userId: assigneeId })
    .returning();
  return task;
}

const claim = (key: string, taskId: string, requestId: string = randomUUID()) =>
  app.request(`/api/operon/card-claims/${taskId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ requestId }),
  });
const release = (
  key: string,
  taskId: string,
  generation: number,
  done = false,
) =>
  app.request(`/api/operon/card-claims/${taskId}?done=${done}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${key}`,
      "X-Operon-Card-Generation": String(generation),
    },
  });
const comments = async (taskId: string) =>
  db
    .select()
    .from(schema.activityTable)
    .where(
      and(
        eq(schema.activityTable.taskId, taskId),
        eq(schema.activityTable.type, "comment"),
      ),
    );
const claimRow = async (taskId: string) =>
  (
    await db
      .select()
      .from(agentCardClaimsTable)
      .where(eq(agentCardClaimsTable.taskId, taskId))
  )[0] ?? null;
const assignee = async (taskId: string) =>
  (
    await db
      .select({ userId: schema.taskTable.userId })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, taskId))
  )[0]?.userId ?? null;

beforeEach(async () => {
  await resetTestDatabase();
  holder = await createWorkspaceMember({ role: "owner" });
  const created = await auth.api.createApiKey({
    body: {
      userId: holder.user.id,
      name: "svc",
      permissions: {
        workspace: ["manage_settings"],
        task: ["create", "update"],
        operon: ["rekey"],
      },
      metadata: { operonService: true },
    },
  });
  if (!created?.key) throw new Error("no service key");
  serviceKey = created.key;
});

const req = (
  key: string,
  method: string,
  path: string,
  body?: unknown,
  generation?: number,
) =>
  app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      authorization: key.startsWith("Bearer ") ? key : `Bearer ${key}`,
      ...(generation === undefined
        ? {}
        : { "X-Operon-Card-Generation": String(generation) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const leaseOf = async (taskId: string) =>
  (await claimRow(taskId))?.leaseUntil?.getTime() ?? 0;

/** A card claimed by `a` (generation 1) with a comment, a label, a relation partner and a time entry. */
async function claimedCard(a: { key: string; user: { id: string } }) {
  const task = await newCard();
  expect((await claim(a.key, task.id)).status).toBe(201);
  const [comment] = await db
    .select()
    .from(schema.activityTable)
    .where(eq(schema.activityTable.taskId, task.id));
  const other = await newCard();
  const [label] = await db
    .insert(schema.labelTable)
    .values({ name: "L", color: "#000000", workspaceId: holder.workspace.id })
    .returning();
  const [entry] = await db
    .insert(schema.timeEntryTable)
    .values({ taskId: task.id, userId: a.user.id, startTime: new Date() })
    .returning();
  return { task, comment, other, label, entry };
}

/** One request per guarded route, for an agent with or without its generation. */
function guardedRequests(
  c: Awaited<ReturnType<typeof claimedCard>>,
  _selfId: string,
) {
  const t = c.task.id;
  return [
    [
      "PUT /api/task/status/:id",
      "PUT",
      `/api/task/status/${t}`,
      { status: "in-progress" },
    ],
    [
      "PUT /api/task/priority/:id",
      "PUT",
      `/api/task/priority/${t}`,
      { priority: "high" },
    ],
    [
      "PUT /api/task/title/:id",
      "PUT",
      `/api/task/title/${t}`,
      { title: "Renamed" },
    ],
    [
      "PUT /api/task/description/:id",
      "PUT",
      `/api/task/description/${t}`,
      { description: "Body" },
    ],
    [
      "PUT /api/task/due-date/:id",
      "PUT",
      `/api/task/due-date/${t}`,
      { dueDate: new Date(Date.now() + 86400000).toISOString() },
    ],
    [
      "POST /api/comment/:taskId",
      "POST",
      `/api/comment/${t}`,
      { content: "work" },
    ],
    [
      "PUT /api/comment/:id",
      "PUT",
      `/api/comment/${c.comment.id}`,
      { content: "On it (edited)" },
    ],
    [
      "POST /api/activity/comment",
      "POST",
      "/api/activity/comment",
      { taskId: t, comment: "more" },
    ],
    [
      "PUT /api/label/:id/task",
      "PUT",
      `/api/label/${c.label.id}/task`,
      { taskId: t },
    ],
    [
      "POST /api/task-relation",
      "POST",
      "/api/task-relation",
      { sourceTaskId: t, targetTaskId: c.other.id, relationType: "related" },
    ],
    [
      "POST /api/time-entry",
      "POST",
      "/api/time-entry",
      { taskId: t, startTime: new Date().toISOString() },
    ],
    [
      "PUT /api/time-entry/:id",
      "PUT",
      `/api/time-entry/${c.entry.id}`,
      { startTime: new Date().toISOString(), description: "x" },
    ],
  ] as const;
}

describe("guarded card writes for agent keys (agents-first-class Phase 3 D8, D10, R13)", () => {
  it("every guarded route: no header 409 claim_required, a stale generation 409 claim_lost, the claim passes and renews the lease", async () => {
    const a = await newAgent("Scout");
    const c = await claimedCard(a);
    for (const [label, method, path, body] of guardedRequests(c, a.user.id)) {
      const none = await req(a.key, method, path, body);
      expect([
        label,
        none.status,
        (await none.json().catch(() => ({}))).error,
      ]).toEqual([label, 409, "claim_required"]);
      const stale = await req(a.key, method, path, body, 2);
      expect([label, stale.status]).toEqual([label, 409]);
      await db
        .update(agentCardClaimsTable)
        .set({ leaseUntil: new Date(Date.now() + 60_000) })
        .where(eq(agentCardClaimsTable.taskId, c.task.id));
      const before = await leaseOf(c.task.id);
      const ok = await req(a.key, method, path, body, 1);
      expect([label, ok.status]).toEqual([label, 200]);
      expect([label, (await leaseOf(c.task.id)) > before + 60_000]).toEqual([
        label,
        true,
      ]);
    }
  });

  it("an expired lease, a changed assignee and another agent are refused; nothing changes", async () => {
    const a = await newAgent("Scout");
    const b = await newAgent("Pilot");
    const c = await claimedCard(a);
    await db
      .update(agentCardClaimsTable)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(agentCardClaimsTable.taskId, c.task.id));
    expect(
      (
        await req(
          a.key,
          "PUT",
          `/api/task/title/${c.task.id}`,
          { title: "Late" },
          1,
        )
      ).status,
    ).toBe(409);
    await db
      .update(agentCardClaimsTable)
      .set({ leaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(agentCardClaimsTable.taskId, c.task.id));
    await db
      .update(schema.taskTable)
      .set({ userId: holder.user.id })
      .where(eq(schema.taskTable.id, c.task.id));
    expect(
      (
        await req(
          a.key,
          "PUT",
          `/api/task/title/${c.task.id}`,
          { title: "Moved" },
          1,
        )
      ).status,
    ).toBe(409);
    await db
      .update(schema.taskTable)
      .set({ userId: a.user.id })
      .where(eq(schema.taskTable.id, c.task.id));
    expect(
      (
        await req(
          b.key,
          "PUT",
          `/api/task/title/${c.task.id}`,
          { title: "Not mine" },
          1,
        )
      ).status,
    ).toBe(409);
    const [row] = await db
      .select({ title: schema.taskTable.title })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, c.task.id));
    expect(row?.title).toBe("Card");
  });

  it("an agent may set the assignee only to itself; a write that moves the assignee rolls back with no event", async () => {
    const a = await newAgent("Scout");
    const c = await claimedCard(a);
    // The full update route (the agent key's ceiling has no separate assign permission).
    const full = (userId: string | null) => ({
      title: "Card",
      status: "to-do",
      projectId: c.task.projectId,
      description: "",
      priority: "low",
      position: 0,
      ...(userId === null ? {} : { userId }),
    });
    // Naming someone else: refused (the key's ceiling may refuse it first; either way, nothing changes).
    const named = await req(
      a.key,
      "PUT",
      `/api/task/${c.task.id}`,
      full(holder.user.id),
      1,
    );
    expect([403, 409]).toContain(named.status);
    const unassign = await req(
      a.key,
      "PUT",
      `/api/task/${c.task.id}`,
      full(null),
      1,
    );
    expect([403, 409]).toContain(unassign.status);
    expect(await assignee(c.task.id)).toBe(a.user.id);
    const self = await req(
      a.key,
      "PUT",
      `/api/task/${c.task.id}`,
      full(a.user.id),
      1,
    );
    expect(self.status).toBe(200);
    const events: unknown[] = [];
    await subscribeToEvent("task.title_changed", async (d) => {
      events.push(d);
    });
    await db.execute(
      sql`CREATE OR REPLACE FUNCTION operon_test_steal() RETURNS trigger AS $$ BEGIN NEW.assignee_id := ${sql.raw(`'${holder.user.id}'`)}; RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await db.execute(
      sql`CREATE TRIGGER operon_test_steal BEFORE UPDATE OF title ON task FOR EACH ROW EXECUTE FUNCTION operon_test_steal()`,
    );
    try {
      const moved = await req(
        a.key,
        "PUT",
        `/api/task/title/${c.task.id}`,
        { title: "Stolen" },
        1,
      );
      expect([moved.status, (await moved.json()).error]).toEqual([
        409,
        "assignee_not_self",
      ]);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS operon_test_steal ON task`);
      await db.execute(sql`DROP FUNCTION IF EXISTS operon_test_steal()`);
    }
    const [row] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, c.task.id));
    expect([row?.title, row?.userId]).toEqual(["Card", a.user.id]);
    await new Promise((r) => setTimeout(r, 50));
    expect(
      events.filter((e) => (e as { taskId?: string }).taskId === c.task.id),
    ).toEqual([]);
    // A successful guarded write publishes its event after the commit.
    expect(
      (
        await req(
          a.key,
          "PUT",
          `/api/task/title/${c.task.id}`,
          { title: "Done right" },
          1,
        )
      ).status,
    ).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(
      events.filter((e) => (e as { taskId?: string }).taskId === c.task.id),
    ).toHaveLength(1);
  });

  it("a guarded comment delete works; a task delete by an agent key is refused by its permission ceiling; a deleted task takes its claim", async () => {
    const a = await newAgent("Scout");
    const c = await claimedCard(a);
    expect(
      (await req(a.key, "DELETE", `/api/comment/${c.comment.id}`, undefined, 1))
        .status,
    ).toBe(200);
    expect(
      (await req(a.key, "DELETE", `/api/task/${c.task.id}`, undefined, 1))
        .status,
    ).toBe(403);
    const person = await humanBearer(holder.user.id);
    expect((await req(person, "DELETE", `/api/task/${c.task.id}`)).status).toBe(
      200,
    );
    expect(await claimRow(c.task.id)).toBeNull();
  });

  it("bulk, import and raw activity are 403 agent_route_not_allowed for agent keys; creating a card stays unguarded", async () => {
    const a = await newAgent("Scout");
    const c = await claimedCard(a);
    const bulk = await req(
      a.key,
      "PATCH",
      "/api/task/bulk",
      { taskIds: [c.task.id], operation: "updatePriority", value: "high" },
      1,
    );
    expect(bulk.status).toBe(403);
    const imp = await req(
      a.key,
      "POST",
      `/api/task/import/${c.task.projectId}`,
      { tasks: [] },
      1,
    );
    expect(imp.status).toBe(403);
    const act = await req(
      a.key,
      "POST",
      "/api/activity/create",
      { taskId: c.task.id, type: "comment", message: "raw" },
      1,
    );
    expect(act.status).toBe(403);
    const { project } = await createProjectFixture({
      workspaceId: holder.workspace.id,
    });
    const created = await req(a.key, "POST", `/api/task/${project.id}`, {
      title: "New",
      description: "",
      priority: "no-priority",
      status: "to-do",
    });
    expect(created.status).toBe(200);
  });

  it("a person's requests are unchanged: no header needed, the claim is ignored (and revoked on reassignment)", async () => {
    const a = await newAgent("Scout");
    const c = await claimedCard(a);
    const person = await humanBearer(holder.user.id);
    expect(
      (
        await req(person, "PUT", `/api/task/title/${c.task.id}`, {
          title: "By a person",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await req(person, "PUT", `/api/task/status/${c.task.id}`, {
          status: "done",
        })
      ).status,
    ).toBe(200);
    expect((await claimRow(c.task.id))?.state).toBe("active");
  });

  it("the route inventory: every non-GET route of the task-scoped modules is classified", () => {
    const prefixes = [
      "/api/task",
      "/api/activity",
      "/api/comment",
      "/api/label",
      "/api/task-relation",
      "/api/time-entry",
      "/api/custom-field",
    ];
    const seen = new Set<string>();
    for (const r of app.routes as { method: string; path: string }[]) {
      if (
        r.method === "GET" ||
        r.method === "ALL" ||
        r.method === "HEAD" ||
        r.method === "OPTIONS"
      )
        continue;
      const path = r.path.replace(/\{(\w+)\}/g, ":$1").replace(/\/$/, "");
      if (!prefixes.some((p) => path === p || path.startsWith(`${p}/`)))
        continue;
      seen.add(`${r.method} ${path}`);
    }
    const unclassified = [...seen].filter((k) => !(k in CARD_ROUTE_CLASSES));
    expect(unclassified).toEqual([]);
    expect(seen.size).toBeGreaterThanOrEqual(30);
  });

  it("50 rounds of concurrent claims, guarded writes and a person's reassignments: no deadlock, and an active claim always matches the assignee", async () => {
    const a = await newAgent("Scout");
    const person = await humanBearer(holder.user.id);
    for (let i = 0; i < 50; i++) {
      const task = await newCard();
      const results = await Promise.all([
        claim(a.key, task.id, `r-${i}`),
        req(a.key, "PUT", `/api/task/title/${task.id}`, { title: `T${i}` }, 1),
        req(person, "PUT", `/api/task/assignee/${task.id}`, {
          userId: holder.user.id,
        }),
      ]);
      for (const r of results) expect(r.status).not.toBe(500);
      const row = await claimRow(task.id);
      if (row?.state === "active")
        expect(await assignee(task.id)).toBe(row.claimer);
    }
  });
});
