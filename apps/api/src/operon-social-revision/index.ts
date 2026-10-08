import { type SQL, sql } from "drizzle-orm";
import { taskTable } from "../database/schema";

/**
 * Operon fork addition (social agent S9) — the approved-card revision.
 *
 * The fields an approval covers. A write that sets any of them to a DIFFERENT value adds 1 to
 * `task.social_revision`; a write that leaves them all as they were (a reorder, a priority
 * change through the full update, a status write to the status the card already has) adds 0.
 */
type CoveredFields = {
  title?: string;
  description?: string | null;
  dueDate?: Date | null;
  status?: string;
  projectId?: string;
};

const COVERED_COLUMNS = {
  title: taskTable.title,
  description: taskTable.description,
  dueDate: taskTable.dueDate,
  status: taskTable.status,
  projectId: taskTable.projectId,
} as const;

/**
 * The `social_revision` value for an UPDATE's SET clause. It is an SQL expression on purpose:
 * Postgres evaluates SET expressions against the row being updated, under that row's lock, so
 * two concurrent edits get distinct increasing revisions. Computing `existing + 1` in
 * application memory would let both writes store the same number, and Operon would then post
 * an edited card as if it were the approved one. Callers read the stored value back with
 * `.returning()`, which is what the status-change and move webhooks carry.
 *
 * `sql.param(value, column)` encodes each value with its column's driver mapping, so a due
 * date compares as the same `timestamp` the SET stores, whatever the process time zone.
 */
export function nextSocialRevision(changes: CoveredFields): SQL {
  const differs = (Object.keys(COVERED_COLUMNS) as (keyof CoveredFields)[])
    .filter((field) => changes[field] !== undefined)
    .map(
      (field) =>
        sql`${COVERED_COLUMNS[field]} IS DISTINCT FROM ${sql.param(changes[field], COVERED_COLUMNS[field])}`,
    );

  if (differs.length === 0) return sql`${taskTable.socialRevision}`;

  return sql`${taskTable.socialRevision} + CASE WHEN ${sql.join(differs, sql` OR `)} THEN 1 ELSE 0 END`;
}
