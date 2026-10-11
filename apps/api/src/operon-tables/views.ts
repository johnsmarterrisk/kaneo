import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import db from "../database";
import {
  operonTableProjectTable,
  operonTableRowMetaTable,
  projectTable,
  taskTable,
  userTable,
} from "../database/schema";
import { readTableRows, type TableRow } from "./read-row";
import { optionList, tableError } from "./values";
import { type LockedTable, loadTable } from "./write-row";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.9 / 7.10 /
 * R-B2): the table view's rows page and the workspace project list's Tables summary. Both
 * read ACTIVE columns only (loadTable drops hidden ones), so a hidden column's values never
 * reach these surfaces. Filters and the date sort run in SQL BEFORE the page is cut, so the
 * newest dated row or a matching row created long ago is found whatever its creation order.
 */

export const ROWS_PAGE_MAX = 200;
/** Test seam: the summary page size (50 tables per page). */
export const summaryLimits = { page: 50 };
const RECENT_ROWS = 5;

export type TableSettings = {
  table: LockedTable;
  dateFieldId: string | null;
  statusFieldId: string | null;
};

export async function loadTableSettings(
  projectId: string,
): Promise<TableSettings | null> {
  const table = await loadTable(projectId);
  if (!table) return null;
  const [flag] = await db
    .select({
      dateFieldId: operonTableProjectTable.dateFieldId,
      statusFieldId: operonTableProjectTable.statusFieldId,
    })
    .from(operonTableProjectTable)
    .where(eq(operonTableProjectTable.projectId, projectId))
    .limit(1);
  const active = new Set(table.defs.map((d) => d.id));
  const keep = (id: string | null | undefined) =>
    id && active.has(id) ? id : null;
  return {
    table: { ...table, groupFieldId: keep(table.groupFieldId) },
    dateFieldId: keep(flag?.dateFieldId),
    statusFieldId: keep(flag?.statusFieldId),
  };
}

type Cursor = { id: string; c?: string; d?: string | null };

export function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed && typeof parsed.id === "string") return parsed as Cursor;
  } catch {
    // fall through to the 422 below
  }
  tableError(422, "validation_failed", "That cursor is not valid");
}

export type RowsQuery = {
  sort: "created" | "date";
  /** Choice column id → accepted options (OR within a column, AND across columns). */
  filters: Map<string, string[]>;
  year: number | null;
  cursor: string | undefined;
  limit: number;
};

/** `?sort=date&filter=<fieldId>:<option>&year=2026&cursor=…&limit=…`, validated. */
export function readRowsQuery(
  settings: TableSettings,
  query: { sort?: string; year?: string; cursor?: string; limit?: string },
  filterParams: string[],
): RowsQuery {
  const sort = query.sort === "date" ? "date" : "created";
  if (query.sort && query.sort !== "date" && query.sort !== "created") {
    tableError(422, "validation_failed", "sort is created or date");
  }
  const needsDate = sort === "date" || Boolean(query.year);
  if (needsDate && !settings.dateFieldId) {
    tableError(422, "no_date_column", "This table has no date column");
  }
  let year: number | null = null;
  if (query.year) {
    year = Number(query.year);
    if (!Number.isInteger(year) || year < 1000 || year > 9999) {
      tableError(422, "validation_failed", "year is a four-digit year");
    }
  }
  const filters = new Map<string, string[]>();
  for (const raw of filterParams) {
    const split = raw.indexOf(":");
    const fieldId = split > 0 ? raw.slice(0, split) : "";
    const option = split > 0 ? raw.slice(split + 1) : "";
    const def = settings.table.defs.find((d) => d.id === fieldId);
    if (def?.type !== "dropdown") {
      tableError(422, "validation_failed", "A filter names a choice column");
    }
    if (!optionList(def).includes(option)) {
      tableError(422, "unknown_option", "That option is not in this column", {
        column: def.name,
        options: optionList(def),
      });
    }
    filters.set(fieldId, [...(filters.get(fieldId) ?? []), option]);
  }
  let limit = ROWS_PAGE_MAX;
  if (query.limit) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > ROWS_PAGE_MAX) {
      tableError(422, "validation_failed", "limit is 1 to 200");
    }
  }
  return { sort, filters, year, cursor: query.cursor, limit };
}

function filterSql(q: RowsQuery): SQL[] {
  const where: SQL[] = [];
  for (const [fieldId, options] of q.filters) {
    where.push(sql`EXISTS (SELECT 1 FROM custom_field_value fv
      WHERE fv.task_id = t.id AND fv.field_id = ${fieldId}
      AND fv.value IN (${sql.join(
        options.map((o) => sql`${o}`),
        sql`, `,
      )}))`);
  }
  if (q.year !== null) {
    where.push(sql`dv.value LIKE ${`${q.year}-%`}`);
  }
  return where;
}

/**
 * One page of a table's rows: `created` = newest first by creation; `date` = the undated
 * rows first (the "No date" group), then the date column newest first. The cursor carries
 * the last row's ordering key as Postgres text (microseconds kept) plus its id.
 */
export async function listTableRows(settings: TableSettings, q: RowsQuery) {
  const projectId = settings.table.project.id;
  const dateFieldId = settings.dateFieldId ?? "";
  const cursor = decodeCursor(q.cursor);
  const where: SQL[] = [sql`t.project_id = ${projectId}`, ...filterSql(q)];
  const dateValue = sql`NULLIF(dv.value, '')`;

  const pageWhere = [...where];
  if (cursor && q.sort === "created") {
    pageWhere.push(
      sql`(t.created_at, t.id) < (${cursor.c ?? ""}::timestamp, ${cursor.id})`,
    );
  } else if (cursor) {
    pageWhere.push(
      cursor.d === null || cursor.d === undefined
        ? sql`((${dateValue} IS NULL AND t.id < ${cursor.id}) OR ${dateValue} IS NOT NULL)`
        : sql`(${dateValue} IS NOT NULL AND (${dateValue} < ${cursor.d} OR (${dateValue} = ${cursor.d} AND t.id < ${cursor.id})))`,
    );
  }
  const order =
    q.sort === "date"
      ? sql`(${dateValue} IS NULL) DESC, ${dateValue} DESC, t.id DESC`
      : sql`t.created_at DESC, t.id DESC`;

  const result = await db.execute(sql`
    SELECT t.id AS id, t.created_at::text AS c, ${dateValue} AS d
    FROM task t
    LEFT JOIN custom_field_value dv ON dv.task_id = t.id AND dv.field_id = ${dateFieldId}
    WHERE ${sql.join(pageWhere, sql` AND `)}
    ORDER BY ${order}
    LIMIT ${q.limit + 1}`);
  const page = (result.rows ?? []) as {
    id: string;
    c: string;
    d: string | null;
  }[];
  const more = page.length > q.limit;
  const kept = more ? page.slice(0, q.limit) : page;
  const last = kept[kept.length - 1];
  const rows = await readTableRows(
    settings.table,
    kept.map((r) => r.id),
  );

  let total: number | null = null;
  let entries: number | null = null;
  if (!cursor) {
    const counted = await db.execute(sql`
      SELECT count(*)::int AS n FROM task t
      LEFT JOIN custom_field_value dv ON dv.task_id = t.id AND dv.field_id = ${dateFieldId}
      WHERE ${sql.join(where, sql` AND `)}`);
    total = Number((counted.rows?.[0] as { n: number } | undefined)?.n ?? 0);
    entries =
      q.filters.size === 0 && q.year === null
        ? total
        : await countEntries(projectId);
  }

  return {
    rows,
    nextCursor:
      more && last ? encodeCursor({ id: last.id, c: last.c, d: last.d }) : null,
    total,
    entries,
  };
}

async function countEntries(projectId: string) {
  const counted = await db.execute(
    sql`SELECT count(*)::int AS n FROM task WHERE project_id = ${projectId}`,
  );
  return Number((counted.rows?.[0] as { n: number } | undefined)?.n ?? 0);
}

/** Counts of one choice column's stored values over a table's rows. */
async function optionCounts(projectId: string, fieldId: string | null) {
  if (!fieldId) return new Map<string, number>();
  const result = await db.execute(sql`
    SELECT v.value AS value, count(*)::int AS n
    FROM custom_field_value v JOIN task t ON t.id = v.task_id
    WHERE t.project_id = ${projectId} AND v.field_id = ${fieldId}
      AND v.value IS NOT NULL AND v.value <> ''
    GROUP BY v.value`);
  return new Map(
    ((result.rows ?? []) as { value: string; n: number }[]).map((r) => [
      r.value,
      Number(r.n),
    ]),
  );
}

export type TableSummary = {
  tableId: string;
  name: string;
  entries: number;
  group: {
    fieldId: string;
    name: string;
    isTemplateTopic: boolean;
    options: number;
    counts: { option: string; count: number }[];
  } | null;
  status: { option: string; count: number }[];
  lastAdded: { at: string; by: string | null } | null;
};

export type RecentRow = {
  rowId: string;
  tableId: string;
  tableName: string;
  title: string;
  madeBy: string | null;
  createdAt: string;
};

async function summarize(settings: TableSettings): Promise<TableSummary> {
  const { table } = settings;
  const projectId = table.project.id;
  const entries = await countEntries(projectId);
  const groupDef = table.defs.find((d) => d.id === table.groupFieldId);
  const statusDef = table.defs.find((d) => d.id === settings.statusFieldId);
  const groupCounts = await optionCounts(projectId, groupDef?.id ?? null);
  const statusCounts = await optionCounts(projectId, statusDef?.id ?? null);
  const [last] = await db
    .select({
      at: operonTableRowMetaTable.createdAt,
      by: userTable.name,
    })
    .from(operonTableRowMetaTable)
    .innerJoin(taskTable, eq(taskTable.id, operonTableRowMetaTable.taskId))
    .leftJoin(
      userTable,
      eq(userTable.id, operonTableRowMetaTable.createdByUserId),
    )
    .where(eq(operonTableRowMetaTable.projectId, projectId))
    .orderBy(sql`${operonTableRowMetaTable.createdAt} DESC`)
    .limit(1);
  return {
    tableId: projectId,
    name: table.project.name,
    entries,
    group: groupDef
      ? {
          fieldId: groupDef.id,
          name: groupDef.name,
          isTemplateTopic: groupDef.name === "Topic",
          options: optionList(groupDef).length,
          counts: optionList(groupDef).map((option) => ({
            option,
            count: groupCounts.get(option) ?? 0,
          })),
        }
      : null,
    status: statusDef
      ? optionList(statusDef).map((option) => ({
          option,
          count: statusCounts.get(option) ?? 0,
        }))
      : [],
    lastAdded: last ? { at: last.at.toISOString(), by: last.by ?? null } : null,
  };
}

/**
 * The workspace project list's Tables section: one page of the workspace's (unarchived)
 * tables in the project list's own order, and on the first page the five newest rows
 * across them. The caller's `project:read` on the workspace is checked by the route; a
 * table of another workspace never appears because every query is scoped to this one.
 */
export async function workspaceSummary(
  workspaceId: string,
  rawCursor: string | undefined,
) {
  const cursor = decodeCursor(rawCursor);
  const projects = await db
    .select({
      id: projectTable.id,
      position: projectTable.position,
    })
    .from(projectTable)
    .innerJoin(
      operonTableProjectTable,
      eq(operonTableProjectTable.projectId, projectTable.id),
    )
    .where(
      and(
        eq(projectTable.workspaceId, workspaceId),
        isNull(projectTable.archivedAt),
      ),
    )
    .orderBy(
      asc(projectTable.position),
      asc(projectTable.createdAt),
      asc(projectTable.id),
    );
  // Position ties are broken by creation then id, so the cursor is the last id's index.
  const start = cursor ? projects.findIndex((p) => p.id === cursor.id) + 1 : 0;
  const pageIds = projects.slice(start, start + summaryLimits.page);
  const tables: TableSummary[] = [];
  for (const { id } of pageIds) {
    const settings = await loadTableSettings(id);
    if (settings) tables.push(await summarize(settings));
  }
  const lastId = pageIds[pageIds.length - 1]?.id;
  const nextCursor =
    start + summaryLimits.page < projects.length && lastId
      ? encodeCursor({ id: lastId })
      : null;

  let recent: RecentRow[] | undefined;
  if (!cursor) {
    const allIds = projects.map((p) => p.id);
    recent = [];
    if (allIds.length > 0) {
      const newest = await db
        .select({
          rowId: operonTableRowMetaTable.taskId,
          tableId: operonTableRowMetaTable.projectId,
          tableName: projectTable.name,
          title: taskTable.title,
          madeBy: userTable.name,
          createdAt: operonTableRowMetaTable.createdAt,
        })
        .from(operonTableRowMetaTable)
        .innerJoin(taskTable, eq(taskTable.id, operonTableRowMetaTable.taskId))
        .innerJoin(
          projectTable,
          eq(projectTable.id, operonTableRowMetaTable.projectId),
        )
        .leftJoin(
          userTable,
          eq(userTable.id, operonTableRowMetaTable.createdByUserId),
        )
        .where(inArray(operonTableRowMetaTable.projectId, allIds))
        .orderBy(
          sql`${operonTableRowMetaTable.createdAt} DESC, ${operonTableRowMetaTable.taskId} DESC`,
        )
        .limit(RECENT_ROWS);
      recent = newest.map((r) => ({
        ...r,
        madeBy: r.madeBy ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    }
  }
  return { tables, nextCursor, ...(recent ? { recent } : {}) };
}

export type { TableRow };
