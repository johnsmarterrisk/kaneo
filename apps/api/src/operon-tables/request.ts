import { createHash, createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { postgresFailure } from "../auth";
import db from "../database";
import { operonTableRequestTable } from "../database/schema";
import { tableError } from "./values";

/**
 * Operon fork addition (Tables task 12, docs/fork-discipline.md row 18, spec 7.3 step 2,
 * R-C / RF-6): the request tombstone of a keyed table-row add. A retry of the same add (same
 * caller, same table, same `requestId`, same payload) answers the row the first attempt
 * made — or, when that row was deleted since, its id with `deleted: true` — and never a
 * second row. The tombstone is independent of the task row (no task FK), which is the
 * whole point: a replay after a delete must still find it.
 */
export type TableRequest = typeof operonTableRequestTable.$inferSelect;

/**
 * `tables:<projectId>:<sha256(actorUserId + "\n" + requestId), first 40 hex>`. The actor and
 * the table are IN the key, so the same `requestId` from another agent or for another table
 * is a different request: it creates its own row and can never read the first one.
 */
export function requestKey(
  projectId: string,
  actorUserId: string,
  requestId: string,
) {
  const digest = createHash("sha256")
    .update(`${actorUserId}\n${requestId}`)
    .digest("hex")
    .slice(0, 40);
  return `tables:${projectId}:${digest}`;
}

/** Keys sorted at every depth, so one payload has exactly one canonical text. */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const FINGERPRINT_LABEL = "operon-tables-request-fingerprint-v1";

/**
 * HMAC-SHA256 over the canonical JSON of the submitted payload (values as submitted, an
 * absent member and `null` share one representation), under a key derived from the
 * existing S2S secret — no new secret is configured, and a stored fingerprint reveals
 * nothing guessable about a short value.
 */
export function requestFingerprint(
  projectId: string,
  body: {
    title?: unknown;
    notes?: unknown;
    assigneeId?: unknown;
    values?: unknown;
    newTopic?: unknown;
  },
) {
  const secret = process.env.OPERON_KANEO_S2S_SECRET;
  if (!secret) {
    tableError(
      503,
      "not_configured",
      "Table entries cannot be added until the Operon link is configured",
    );
  }
  const key = createHmac("sha256", secret).update(FINGERPRINT_LABEL).digest();
  return createHmac("sha256", key)
    .update(
      canonical({
        projectId,
        title: body.title,
        notes: body.notes,
        assigneeId: body.assigneeId,
        values: body.values ?? {},
        newTopic: body.newTopic,
      }),
    )
    .digest("hex");
}

export async function findRequest(key: string) {
  const [found] = await db
    .select()
    .from(operonTableRequestTable)
    .where(eq(operonTableRequestTable.key, key))
    .limit(1);
  return found ?? null;
}

/**
 * Step 2's comparison: the stored request must be this table's, this caller's and this
 * payload's, else 409 `request_conflict` carrying no row data (the stored row is not
 * this caller's to see under a changed payload).
 */
export function assertSameRequest(
  found: TableRequest,
  expected: { projectId: string; actorUserId: string; fingerprint: string },
) {
  if (
    found.projectId !== expected.projectId ||
    found.actorUserId !== expected.actorUserId ||
    found.requestFingerprint !== expected.fingerprint
  ) {
    console.warn("[operon] tables.request_conflict", {
      projectId: expected.projectId,
      taskId: found.projectId === expected.projectId ? found.taskId : null,
      actorUserId: expected.actorUserId,
    });
    tableError(
      409,
      "request_conflict",
      "This requestId was already used for a different entry",
    );
  }
}

/** A concurrent add with the same key won the tombstone's primary key (SQLSTATE 23505). */
export function isRequestKeyViolation(error: unknown) {
  const failure = postgresFailure(error);
  return (
    failure?.code === "23505" &&
    failure.constraint === "operon_table_request_pkey"
  );
}
