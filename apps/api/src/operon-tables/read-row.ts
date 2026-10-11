import { and, eq, inArray } from "drizzle-orm";
import db from "../database";
import {
  customFieldValueTable,
  operonTableRowMetaTable,
  taskTable,
  userTable,
} from "../database/schema";
import {
  type ColumnDef,
  capCodePoints,
  displayValue,
  fromStoredText,
} from "./values";
import type { LockedTable } from "./write-row";

/**
 * Operon fork addition (Tables, docs/fork-discipline.md row 18, spec 7.8 / R-B2): one table
 * row as every Tables surface answers it — values keyed by ACTIVE column name, Made by, and
 * the Last change summary resolved against the active columns at read time, so a column
 * hidden since names nothing and shows no value (task 6).
 */
export type TableRow = {
  rowId: string;
  tableId: string;
  title: string;
  notes: string;
  assigneeId: string | null;
  values: Record<string, unknown>;
  madeBy: { id: string | null; name: string | null };
  createdAt: string | null;
  lastChange: {
    by: { id: string | null; name: string | null };
    at: string | null;
    columns: string[];
    summary: string | null;
  };
  url: string;
};

const CORE_LABEL: Record<string, string> = {
  title: "Title",
  notes: "Notes",
  assignee: "Owner",
};

async function names(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map<string, string | null>();
  const users = await db
    .select({ id: userTable.id, name: userTable.name })
    .from(userTable)
    .where(inArray(userTable.id, unique));
  return new Map(users.map((u) => [u.id, u.name ?? null]));
}

export async function readTableRow(
  table: LockedTable,
  taskId: string,
): Promise<TableRow | null> {
  const [row] = await readTableRows(table, [taskId]);
  return row ?? null;
}

/**
 * Many rows of ONE table in a fixed number of queries (the table view, summary and search
 * pages), answered in the order of `taskIds`; an id not in this table is skipped.
 */
export async function readTableRows(
  table: LockedTable,
  taskIds: string[],
): Promise<TableRow[]> {
  const projectId = table.project.id;
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const tasks = await db
    .select()
    .from(taskTable)
    .where(and(inArray(taskTable.id, ids), eq(taskTable.projectId, projectId)));
  if (tasks.length === 0) return [];
  const found = tasks.map((t) => t.id);
  const stored = await db
    .select({
      taskId: customFieldValueTable.taskId,
      fieldId: customFieldValueTable.fieldId,
      value: customFieldValueTable.value,
    })
    .from(customFieldValueTable)
    .where(inArray(customFieldValueTable.taskId, found));
  const metas = await db
    .select()
    .from(operonTableRowMetaTable)
    .where(inArray(operonTableRowMetaTable.taskId, found));
  const metaByTask = new Map(metas.map((m) => [m.taskId, m]));
  const storedByTask = new Map<string, Map<string, string | null>>();
  for (const s of stored) {
    let byField = storedByTask.get(s.taskId);
    if (!byField) {
      byField = new Map();
      storedByTask.set(s.taskId, byField);
    }
    byField.set(s.fieldId, s.value ?? null);
  }
  const people = await names(
    tasks.flatMap((t) => {
      const meta = metaByTask.get(t.id);
      return [meta?.createdByUserId, meta?.lastWriterUserId, t.userId].filter(
        (id): id is string => typeof id === "string",
      );
    }),
  );
  const byId = new Map(
    tasks.map((task) => [
      task.id,
      shapeRow(
        table,
        task,
        storedByTask.get(task.id) ?? new Map(),
        metaByTask.get(task.id),
        people,
      ),
    ]),
  );
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is TableRow => Boolean(row));
}

function shapeRow(
  table: LockedTable,
  task: typeof taskTable.$inferSelect,
  storedById: Map<string, string | null>,
  meta: typeof operonTableRowMetaTable.$inferSelect | undefined,
  people: Map<string, string | null>,
): TableRow {
  const projectId = table.project.id;

  const values: Record<string, unknown> = {};
  for (const def of table.defs) {
    values[def.name] = fromStoredText(def, storedById.get(def.id) ?? null);
  }

  const change = (meta?.lastChange ?? { fieldIds: [], core: [] }) as {
    fieldIds?: string[];
    core?: string[];
  };
  const activeById = new Map(table.defs.map((d) => [d.id, d]));
  const changedDefs = (change.fieldIds ?? [])
    .map((id) => activeById.get(id))
    .filter((d): d is ColumnDef => Boolean(d));
  const core = (change.core ?? []).filter((c) => CORE_LABEL[c]);
  const columns = [
    ...core.map((c) => CORE_LABEL[c] as string),
    ...changedDefs.map((d) => d.name),
  ];

  let summary: string | null = null;
  if (columns.length === 1) {
    const only = changedDefs[0];
    let value: string | null;
    if (only) {
      value = displayValue(only, storedById.get(only.id) ?? null);
    } else if (core[0] === "title") {
      value = task.title;
    } else if (core[0] === "assignee") {
      value = task.userId ? (people.get(task.userId) ?? null) : null;
    } else {
      value = task.description || null;
    }
    summary = `set ${columns[0]} to ${value === null ? "nothing" : capCodePoints(value, 80)}`;
  } else if (columns.length > 1) {
    summary = `changed ${columns.length} columns`;
  }

  const clientUrl = process.env.KANEO_CLIENT_URL || "http://localhost:5173";
  return {
    rowId: task.id,
    tableId: projectId,
    title: task.title,
    notes: task.description ?? "",
    assigneeId: task.userId ?? null,
    values,
    madeBy: {
      id: meta?.createdByUserId ?? null,
      name: meta ? (people.get(meta.createdByUserId) ?? null) : null,
    },
    createdAt: meta?.createdAt?.toISOString() ?? null,
    lastChange: {
      by: {
        id: meta?.lastWriterUserId ?? null,
        name: meta ? (people.get(meta.lastWriterUserId) ?? null) : null,
      },
      at: meta?.lastChangedAt?.toISOString() ?? null,
      columns,
      summary,
    },
    url: `${clientUrl}/dashboard/workspace/${table.project.workspaceId}/project/${projectId}/task/${task.id}`,
  };
}
