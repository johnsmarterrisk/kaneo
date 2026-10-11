import { timingSafeEqual } from "node:crypto";
import * as Sentry from "@sentry/node";
import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../database";
import {
  integrationTable,
  operonTableProjectTable,
  operonTableRowOutboxTable,
} from "../database/schema";
import {
  operonProjectCreatedDestination,
  operonProjectCreatedSecret,
  startOperonProjectCreatedDelivery,
} from "../operon-project-created";
import { postToGenericWebhook } from "../plugins/generic-webhook/client";
import {
  type GenericWebhookConfig,
  type GenericWebhookEventKey,
  normalizeGenericWebhookConfig,
} from "../plugins/generic-webhook/config";
import { withJobLease } from "../scheduler/leader-lock";
import { markTableAnnounced, tableAnnouncement } from "./create-table";

/**
 * Operon fork addition (Tables task 5, docs/fork-discipline.md row 18, spec 7.4): the durable
 * delivery of table row writes. Records are committed with the row (write-row.ts); this
 * drain posts them, oldest first and first-in-first-out per task, and DELETES each one on
 * Operon's 2xx. Anything else keeps it pending on a bounded ladder (5 s, 15 s, 60 s, 300 s,
 * then 900 s) forever: a lost signal is worse than a loud stall.
 *
 * It posts ONLY to the instance's provisioned Operon destination with the provisioned
 * secret (RF-1), and only for a project whose generic-webhook integration carries exactly
 * those two values — a workspace admin who points the integration elsewhere stalls the
 * table's delivery; values never leave for the edited destination. And it posts no row of a
 * table Operon has not acknowledged (`announced_at`, RF-7), so every signal is resolved
 * against a disclosure row Operon has already written.
 */
export const OUTBOX_BATCH = 50;
export const OUTBOX_BACKOFF_SECONDS = [5, 15, 60, 300] as const;
export const OUTBOX_MAX_BACKOFF_SECONDS = 900;
/** A claimed record is invisible to other drainers this long; a crash re-exposes it. */
const CLAIM_SECONDS = 60;
/** The job lease, equal to the claim: neither may lapse while this instance still posts. */
const LEASE_MS = CLAIM_SECONDS * 1000;
/** `postToGenericWebhook`'s own timeout (plugins/generic-webhook/client.ts). */
const POST_TIMEOUT_MS = 10_000;
/**
 * Codex round 1, finding 1: a pass may START a post only before this budget runs out, so its
 * last post ends (budget + one timeout + the bookkeeping margin) well inside the 60 s lease
 * and claim. Records still unposted at the deadline are released (due now, attempts
 * unchanged) for the next pass, in id order, so another instance can never claim a record
 * this one is still posting and per-task order holds. Never raise it past
 * LEASE_MS - POST_TIMEOUT_MS minus a margin.
 */
export const PASS_BUDGET_MS = LEASE_MS - POST_TIMEOUT_MS - 10_000;
/** How soon a record held back by a precondition (announce, webhook) is looked at again. */
const HOLD_SECONDS = 5;
export const STALL_SECONDS = 900;
const STALL_ALERT_EVERY_MS = 15 * 60 * 1000;

const EVENT_TOGGLES: Record<string, GenericWebhookEventKey> = {
  "task.created": "taskCreated",
  "task.fields_changed": "taskFieldsChanged",
  "task.deleted": "taskDeleted",
};

export function backoffSeconds(attempts: number) {
  return OUTBOX_BACKOFF_SECONDS[attempts - 1] ?? OUTBOX_MAX_BACKOFF_SECONDS;
}

/**
 * Test seams. `disableKick` stops the post-commit kick so a test drives the drain itself;
 * `alert` observes the stall alert in place of Sentry.
 */
export const tableOutboxHooks: {
  disableKick?: boolean;
  alert?: (message: string, extra: Record<string, number>) => void;
  /** Overrides PASS_BUDGET_MS so a test can run a pass past its budget in milliseconds. */
  passBudgetMs?: number;
} = {};

type Claimed = {
  id: number;
  project_id: string;
  task_id: string;
  event: string;
  write_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  age_ms: number;
};

function sameSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function hold(ids: number[], seconds = HOLD_SECONDS) {
  if (ids.length === 0) return;
  await db
    .update(operonTableRowOutboxTable)
    .set({ nextAttemptAt: sql`now() + make_interval(secs => ${seconds})` })
    .where(inArray(operonTableRowOutboxTable.id, ids));
}

const announcing = new Set<string>();

/** RF-7: re-send a table's `project.created` (joining any ladder in flight), never awaited. */
function reannounce(projectId: string) {
  if (announcing.has(projectId)) return;
  announcing.add(projectId);
  void (async () => {
    try {
      const announcement = await tableAnnouncement(projectId);
      if (!announcement) return;
      const result = await startOperonProjectCreatedDelivery(announcement);
      if (result.delivered) await markTableAnnounced(projectId, "drain");
    } catch (error) {
      console.error("[operon] tables.table_announce_failed", {
        projectId,
        errorClass: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      announcing.delete(projectId);
    }
  })();
}

/** Why a project's records may not be posted now, or null when they may (spec 7.4). */
async function projectBlock(
  projectId: string,
  destination: string | null,
  secret: string | null,
): Promise<
  | {
      reason:
        | "waiting_for_announce"
        | "not_configured"
        | "destination_mismatch"
        | "waiting_for_webhook"
        | "project_missing";
    }
  | { reason: null; config: GenericWebhookConfig }
> {
  const [flag] = await db
    .select({ announcedAt: operonTableProjectTable.announcedAt })
    .from(operonTableProjectTable)
    .where(eq(operonTableProjectTable.projectId, projectId))
    .limit(1);
  if (!flag) return { reason: "project_missing" };
  if (!flag.announcedAt) {
    reannounce(projectId);
    return { reason: "waiting_for_announce" };
  }
  if (!destination || !secret) return { reason: "not_configured" };

  const [integration] = await db
    .select({
      config: integrationTable.config,
      isActive: integrationTable.isActive,
    })
    .from(integrationTable)
    .where(
      and(
        eq(integrationTable.projectId, projectId),
        eq(integrationTable.type, "generic-webhook"),
      ),
    )
    .limit(1);
  if (!integration || integration.isActive === false) {
    return { reason: "waiting_for_webhook" };
  }
  let config: GenericWebhookConfig;
  try {
    config = normalizeGenericWebhookConfig(
      JSON.parse(integration.config) as GenericWebhookConfig,
    );
  } catch {
    return { reason: "destination_mismatch" };
  }
  if (
    config.webhookUrl !== destination ||
    !config.secret ||
    !sameSecret(config.secret, secret)
  ) {
    return { reason: "destination_mismatch" };
  }
  return { reason: null, config };
}

const LOG_LEVEL: Record<string, "warn" | "error"> = {
  waiting_for_announce: "warn",
  waiting_for_webhook: "warn",
  not_configured: "error",
  destination_mismatch: "error",
  project_missing: "error",
};

function failureOf(error: unknown): {
  status: number | null;
  errorClass: string;
} {
  const message = error instanceof Error ? error.message : "";
  // postToGenericWebhook's messages carry the status as "(NNN)"; only the number is kept,
  // never the text (it can hold the receiver's body).
  const status = /\((\d{3})\)/.exec(message)?.[1];
  if (status) return { status: Number(status), errorClass: `http_${status}` };
  if (/timed out/i.test(message))
    return { status: null, errorClass: "timeout" };
  return {
    status: null,
    errorClass: error instanceof Error ? error.name : typeof error,
  };
}

let lastStallAlertAt = 0;

async function checkStall() {
  const result = await db.execute<{
    pending: string;
    oldest: string | null;
  }>(sql`
    SELECT count(*)::text AS pending,
           extract(epoch FROM (now() - min(created_at)))::text AS oldest
    FROM operon_table_row_outbox
  `);
  const row = result.rows[0];
  const pending = Number(row?.pending ?? 0);
  const oldest = row?.oldest ? Math.floor(Number(row.oldest)) : 0;
  if (pending === 0 || oldest <= STALL_SECONDS) {
    lastStallAlertAt = 0;
    return false;
  }
  if (Date.now() - lastStallAlertAt >= STALL_ALERT_EVERY_MS) {
    lastStallAlertAt = Date.now();
    console.error("[operon] tables.outbox.stalled", {
      pending,
      oldestPendingSeconds: oldest,
    });
    const extra = { pending, oldestPendingSeconds: oldest };
    if (tableOutboxHooks.alert)
      tableOutboxHooks.alert("tables.outbox.stalled", extra);
    else
      Sentry.captureMessage("tables.outbox.stalled", { level: "error", extra });
  }
  return true;
}

/**
 * One drain pass: claim up to 50 due records (oldest first, the oldest pending record of
 * each task only), check each project's preconditions, post, delete on 2xx.
 */
export async function drainTableOutbox() {
  const deadline =
    Date.now() + (tableOutboxHooks.passBudgetMs ?? PASS_BUDGET_MS);
  const claimed = await db.execute<Claimed>(sql`
    UPDATE operon_table_row_outbox AS o
    SET next_attempt_at = now() + make_interval(secs => ${CLAIM_SECONDS})
    WHERE o.id IN (
      SELECT c.id FROM operon_table_row_outbox AS c
      WHERE c.next_attempt_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM operon_table_row_outbox AS p
          WHERE p.task_id = c.task_id AND p.id < c.id
            AND p.next_attempt_at > now()
        )
      ORDER BY c.id
      LIMIT ${OUTBOX_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING o.id, o.project_id, o.task_id, o.event, o.write_id, o.payload,
              o.attempts,
              (extract(epoch FROM (now() - o.created_at)) * 1000)::float8 AS age_ms
  `);
  const records = [...claimed.rows]
    .map((r) => ({ ...r, id: Number(r.id) }))
    .sort((a, b) => a.id - b.id);

  const destination = operonProjectCreatedDestination();
  const secret = operonProjectCreatedSecret();
  const byProject = new Map<string, Claimed[]>();
  for (const record of records) {
    const list = byProject.get(record.project_id) ?? [];
    list.push(record);
    byProject.set(record.project_id, list);
  }

  let delivered = 0;
  let failed = 0;
  let held = 0;
  const released: number[] = [];
  for (const [projectId, list] of byProject) {
    if (Date.now() > deadline) {
      released.push(...list.map((r) => r.id));
      continue;
    }
    const block = await projectBlock(projectId, destination, secret);
    if (block.reason) {
      held += list.length;
      await hold(list.map((r) => r.id));
      console[LOG_LEVEL[block.reason] ?? "warn"](
        `[operon] tables.outbox.${block.reason}`,
        { projectId, pending: list.length },
      );
      continue;
    }

    // FIFO per task: once a task's record fails or waits in this pass, its later records
    // wait too (the claim query keeps them back on the next pass while it backs off).
    const stopped = new Set<string>();
    for (const record of list) {
      if (Date.now() > deadline) {
        released.push(record.id);
        continue;
      }
      if (stopped.has(record.task_id)) {
        held += 1;
        await hold([record.id]);
        continue;
      }
      const toggle = EVENT_TOGGLES[record.event];
      if (!toggle || !block.config.events?.[toggle]) {
        stopped.add(record.task_id);
        held += 1;
        await hold([record.id]);
        console.warn("[operon] tables.outbox.waiting_for_webhook", {
          projectId,
          pending: 1,
        });
        continue;
      }
      try {
        await postToGenericWebhook(
          destination as string,
          record.payload,
          secret as string,
        );
        await db
          .delete(operonTableRowOutboxTable)
          .where(eq(operonTableRowOutboxTable.id, record.id));
        delivered += 1;
        console.log("[operon] tables.outbox.delivered", {
          outboxId: record.id,
          writeId: record.write_id,
          event: record.event,
          attempts: record.attempts + 1,
          latencyMs: Math.round(record.age_ms),
        });
      } catch (error) {
        stopped.add(record.task_id);
        failed += 1;
        const attempt = record.attempts + 1;
        const wait = backoffSeconds(attempt);
        const failure = failureOf(error);
        await db
          .update(operonTableRowOutboxTable)
          .set({
            attempts: attempt,
            lastStatus: failure.status,
            lastErrorClass: failure.errorClass,
            nextAttemptAt: sql`now() + make_interval(secs => ${wait})`,
          })
          .where(eq(operonTableRowOutboxTable.id, record.id));
        console.warn("[operon] tables.outbox.retry", {
          outboxId: record.id,
          writeId: record.write_id,
          event: record.event,
          attempt,
          ...(failure.status === null
            ? { errorClass: failure.errorClass }
            : { status: failure.status }),
          nextAttemptInSec: wait,
        });
      }
    }
  }

  if (released.length > 0) {
    // Out of budget: hand the rest back now, untouched, rather than let the claim lapse
    // under a post still in flight (finding 1).
    await db
      .update(operonTableRowOutboxTable)
      .set({ nextAttemptAt: sql`now()` })
      .where(inArray(operonTableRowOutboxTable.id, released));
    console.warn("[operon] tables.outbox.pass_budget_spent", {
      released: released.length,
    });
  }

  const stalled = await checkStall();
  return {
    claimed: records.length,
    delivered,
    failed,
    held,
    released: released.length,
    degraded: stalled || failed > 0,
  };
}

let running: Promise<void> | null = null;
let again = false;

/**
 * Every drain — the 5 s croner job and the post-commit kick — runs here: one pass at a time
 * in this process, and under the Postgres job lease across instances (OI-2), so exactly one
 * drainer posts at any moment and per-task order holds. A kick while a pass runs re-runs it.
 */
export function runTableOutboxDrain(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await withJobLease(
        "tables-outbox",
        drainTableOutbox,
        () => null,
        LEASE_MS,
      );
    } while (again);
  })()
    .catch((error) => {
      console.error("[operon] tables.outbox.drain_failed", {
        errorClass: error instanceof Error ? error.name : typeof error,
      });
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** The post-commit kick (spec 7.3 step 7), never awaited by the writer. */
export function kickTableOutbox() {
  if (tableOutboxHooks.disableKick) return;
  void runTableOutboxDrain();
}

/**
 * RF-10: backlog figures for ONE workspace's tables only (one join on the project's
 * workspace), so one workspace cannot read or infer another's backlog.
 */
export async function outboxHealth(workspaceId: string) {
  const result = await db.execute<{
    pending: string;
    oldest: string | null;
    oldest_attempts: number | null;
    last_error_class: string | null;
  }>(sql`
    WITH scoped AS (
      SELECT o.id, o.created_at, o.attempts, o.last_error_class
      FROM operon_table_row_outbox AS o
      JOIN project AS p ON p.id = o.project_id
      WHERE p.workspace_id = ${workspaceId}
    )
    SELECT
      (SELECT count(*)::text FROM scoped) AS pending,
      (SELECT extract(epoch FROM (now() - min(created_at)))::text FROM scoped) AS oldest,
      (SELECT attempts FROM scoped ORDER BY created_at, id LIMIT 1) AS oldest_attempts,
      (SELECT last_error_class FROM scoped WHERE last_error_class IS NOT NULL
         ORDER BY id DESC LIMIT 1) AS last_error_class
  `);
  const row = result.rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    oldestPendingSeconds: row?.oldest ? Math.floor(Number(row.oldest)) : 0,
    oldestAttempts: row?.oldest_attempts ?? 0,
    lastErrorClass: row?.last_error_class ?? null,
  };
}
