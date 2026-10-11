import { type SQL, sql } from "drizzle-orm";
import db from "../database";
import { readTableRows, type TableRow } from "./read-row";
import { tableError } from "./values";
import { decodeCursor, encodeCursor } from "./views";
import { type LockedTable, loadTable } from "./write-row";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.9 / RF-11):
 * the server search the table view's search box calls, and task 12's `search_table_rows`
 * wraps. A case-insensitive LITERAL substring over the title, the Notes text and the ACTIVE
 * text and link values of the workspace's tables (or one table): `%`, `_` and the escape
 * character are escaped, and a hidden column is never searched, so neither a wildcard nor a
 * hidden value can widen what comes back. Newest rows first, paged by (created_at, id).
 */
export const SEARCH_PAGE_MAX = 50;

export function likePattern(query: string) {
  return `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export type SearchRow = TableRow & { tableName: string };

export async function searchTableRows(input: {
  workspaceId: string;
  query: string;
  tableId?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ rows: SearchRow[]; nextCursor: string | null }> {
  const query = input.query.trim();
  if (query.length < 1 || query.length > 200) {
    tableError(422, "validation_failed", "q is 1 to 200 characters");
  }
  const limit = input.limit ?? SEARCH_PAGE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_PAGE_MAX) {
    tableError(422, "validation_failed", "limit is 1 to 50");
  }
  const cursor = decodeCursor(input.cursor);

  const scope = await db.execute(sql`
    SELECT p.id AS id FROM project p
    JOIN operon_table_project f ON f.project_id = p.id
    WHERE p.workspace_id = ${input.workspaceId} AND p.archived_at IS NULL
    ${input.tableId ? sql`AND p.id = ${input.tableId}` : sql``}`);
  const tableIds = ((scope.rows ?? []) as { id: string }[]).map((r) => r.id);
  if (input.tableId && tableIds.length === 0) {
    // A table of another workspace (or no table at all) answers nothing, not even a count.
    tableError(404, "not_a_table", "That table is not in this workspace");
  }
  if (tableIds.length === 0) return { rows: [], nextCursor: null };

  const tables = new Map<string, LockedTable>();
  for (const id of tableIds) {
    const table = await loadTable(id);
    if (table) tables.set(id, table);
  }
  const searchable = [...tables.values()].flatMap((t) =>
    t.defs
      .filter((d) => d.type === "text" || d.type === "link")
      .map((d) => d.id),
  );
  const pattern = likePattern(query);
  const valueMatch: SQL = searchable.length
    ? sql`OR EXISTS (SELECT 1 FROM custom_field_value v
        WHERE v.task_id = t.id
          AND v.field_id IN (${sql.join(
            searchable.map((id) => sql`${id}`),
            sql`, `,
          )})
          AND v.value ILIKE ${pattern} ESCAPE '\\')`
    : sql``;
  const page = cursor
    ? sql`AND (t.created_at, t.id) < (${cursor.c ?? ""}::timestamp, ${cursor.id})`
    : sql``;

  const result = await db.execute(sql`
    SELECT t.id AS id, t.project_id AS "projectId", t.created_at::text AS c
    FROM task t
    WHERE t.project_id IN (${sql.join(
      [...tables.keys()].map((id) => sql`${id}`),
      sql`, `,
    )})
      AND (t.title ILIKE ${pattern} ESCAPE '\\'
        OR coalesce(t.description, '') ILIKE ${pattern} ESCAPE '\\'
        ${valueMatch})
      ${page}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ${limit + 1}`);
  const hits = (result.rows ?? []) as {
    id: string;
    projectId: string;
    c: string;
  }[];
  const more = hits.length > limit;
  const kept = more ? hits.slice(0, limit) : hits;

  const byTable = new Map<string, string[]>();
  for (const hit of kept) {
    byTable.set(hit.projectId, [...(byTable.get(hit.projectId) ?? []), hit.id]);
  }
  const shaped = new Map<string, SearchRow>();
  for (const [projectId, ids] of byTable) {
    const table = tables.get(projectId);
    if (!table) continue;
    for (const row of await readTableRows(table, ids)) {
      shaped.set(row.rowId, { ...row, tableName: table.project.name });
    }
  }
  const last = kept[kept.length - 1];
  return {
    rows: kept
      .map((hit) => shaped.get(hit.id))
      .filter((row): row is SearchRow => Boolean(row)),
    nextCursor: more && last ? encodeCursor({ id: last.id, c: last.c }) : null,
  };
}
