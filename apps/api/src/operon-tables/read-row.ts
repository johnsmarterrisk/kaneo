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
  const projectId = table.project.id;
  const [task] = await db
    .select()
    .from(taskTable)
    .where(and(eq(taskTable.id, taskId), eq(taskTable.projectId, projectId)))
    .limit(1);
  if (!task) return null;
  const stored = await db
    .select({
      fieldId: customFieldValueTable.fieldId,
      value: customFieldValueTable.value,
    })
    .from(customFieldValueTable)
    .where(eq(customFieldValueTable.taskId, taskId));
  const storedById = new Map(stored.map((s) => [s.fieldId, s.value ?? null]));
  const [meta] = await db
    .select()
    .from(operonTableRowMetaTable)
    .where(eq(operonTableRowMetaTable.taskId, taskId))
    .limit(1);

  const people = await names(
    [meta?.createdByUserId, meta?.lastWriterUserId, task.userId].filter(
      (id): id is string => typeof id === "string",
    ),
  );

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
