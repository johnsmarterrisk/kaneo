import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Context, Next } from "hono";
import db from "../database";
import {
  customFieldDefinitionTable,
  customFieldValueTable,
  operonTableProjectTable,
  operonTableValueHistoryTable,
  projectTable,
  taskTable,
} from "../database/schema";
import { requireTableAdmin } from "./admin";
import { isTableProject } from "./guard";
import { tableError } from "./values";
import type { Tx } from "./write-row";

/**
 * Operon fork addition (Tables task 6, docs/fork-discipline.md row 18, spec 7.1 / R-B3 /
 * R-D): the column-definition rules a table adds to #1542's routes. Removing a column
 * hides it; values and history stay, readable by an admin only. Every definition writer
 * locks the project row FOR UPDATE first (the lock order of write-row.ts, RF-8).
 */
export async function lockProjectForDefinitions(tx: Tx, projectId: string) {
  await tx
    .select({ id: projectTable.id })
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .for("update");
}

function fold(name: string) {
  return name.trim().toLowerCase();
}

/** Active column names are unique per table after trimming and case folding (R-D). */
export async function assertUniqueActiveName(
  tx: Tx,
  projectId: string,
  name: string,
  exceptId?: string,
) {
  const active = await tx
    .select({
      id: customFieldDefinitionTable.id,
      name: customFieldDefinitionTable.name,
    })
    .from(customFieldDefinitionTable)
    .where(
      and(
        eq(customFieldDefinitionTable.projectId, projectId),
        isNull(customFieldDefinitionTable.hiddenAt),
      ),
    );
  if (active.some((d) => d.id !== exceptId && fold(d.name) === fold(name))) {
    tableError(409, "duplicate_column", "This table already has that column");
  }
}

async function projectOfField(fieldId: string) {
  const [field] = await db
    .select({ projectId: customFieldDefinitionTable.projectId })
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.id, fieldId))
    .limit(1);
  return field?.projectId ?? null;
}

/**
 * #1542's definition routes (create, reorder, delete) keep their `project:update` gate and,
 * on a TABLE project, also require a table admin (RF-9). Reads the raw request: route
 * middleware runs before the validators.
 */
export async function requireTableAdminOnTable(c: Context, next: Next) {
  let projectId = c.req.param("projectId") ?? null;
  if (!projectId && c.req.param("id")) {
    projectId = await projectOfField(c.req.param("id") as string);
  }
  if (!projectId) {
    const body = (await c.req.json().catch(() => null)) as {
      projectId?: unknown;
    } | null;
    projectId = typeof body?.projectId === "string" ? body.projectId : null;
  }
  if (await isTableProject(projectId)) return requireTableAdmin(c, next);
  await next();
}

/**
 * Hide a table column (spec 7.1): `hidden_at` set, values and history untouched, and a
 * group/date/status pointer naming it cleared in the same transaction. Rewrites no rows,
 * so it signals nothing (R-B).
 */
export async function hideTableColumn(fieldId: string, actorUserId?: string) {
  return db.transaction(async (tx) => {
    const projectId = await projectOfField(fieldId);
    if (!projectId) tableError(404, "not_found", "Custom field not found");
    await lockProjectForDefinitions(tx, projectId);
    const [field] = await tx
      .select()
      .from(customFieldDefinitionTable)
      .where(eq(customFieldDefinitionTable.id, fieldId))
      .for("update");
    if (!field) tableError(404, "not_found", "Custom field not found");
    const [hidden] = await tx
      .update(customFieldDefinitionTable)
      .set({ hiddenAt: field.hiddenAt ?? new Date() })
      .where(eq(customFieldDefinitionTable.id, fieldId))
      .returning();
    if (!hidden) tableError(404, "not_found", "Custom field not found");
    for (const pointer of [
      "groupFieldId",
      "dateFieldId",
      "statusFieldId",
    ] as const) {
      await tx
        .update(operonTableProjectTable)
        .set({ [pointer]: null })
        .where(
          and(
            eq(operonTableProjectTable.projectId, projectId),
            eq(operonTableProjectTable[pointer], fieldId),
          ),
        );
    }
    console.log("[operon] tables.column_hidden", {
      projectId,
      fieldId,
      actorUserId: actorUserId ?? null,
    });
    return hidden;
  });
}

const HISTORY_PAGE = 100;

/**
 * R-B3, the admin recovery read: a column's current values (hidden or not) and its value
 * history, newest first, paged by (created_at, id).
 */
export async function readColumnHistory(
  projectId: string,
  fieldId: string,
  cursor: string | undefined,
) {
  const [field] = await db
    .select()
    .from(customFieldDefinitionTable)
    .where(
      and(
        eq(customFieldDefinitionTable.id, fieldId),
        eq(customFieldDefinitionTable.projectId, projectId),
      ),
    )
    .limit(1);
  if (!field) tableError(404, "not_found", "That column is not in this table");

  let after: { at: Date; id: string } | null = null;
  if (cursor) {
    const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
    const date = new Date(at ?? "");
    if (!id || Number.isNaN(date.getTime()))
      tableError(422, "validation_failed", "Invalid cursor");
    after = { at: date, id };
  }

  const history = await db
    .select()
    .from(operonTableValueHistoryTable)
    .where(
      and(
        eq(operonTableValueHistoryTable.projectId, projectId),
        eq(operonTableValueHistoryTable.fieldId, fieldId),
        after
          ? or(
              lt(operonTableValueHistoryTable.createdAt, after.at),
              and(
                eq(operonTableValueHistoryTable.createdAt, after.at),
                lt(operonTableValueHistoryTable.id, after.id),
              ),
            )
          : sql`true`,
      ),
    )
    .orderBy(
      desc(operonTableValueHistoryTable.createdAt),
      desc(operonTableValueHistoryTable.id),
    )
    .limit(HISTORY_PAGE + 1);
  const page = history.slice(0, HISTORY_PAGE);
  const last = page[page.length - 1];
  const nextCursor =
    history.length > HISTORY_PAGE && last
      ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString(
          "base64url",
        )
      : null;

  const current = after
    ? []
    : await db
        .select({
          rowId: customFieldValueTable.taskId,
          title: taskTable.title,
          value: customFieldValueTable.value,
        })
        .from(customFieldValueTable)
        .innerJoin(taskTable, eq(taskTable.id, customFieldValueTable.taskId))
        .where(eq(customFieldValueTable.fieldId, fieldId))
        .orderBy(asc(taskTable.number));

  return {
    field: {
      id: field.id,
      name: field.name,
      kind: field.type,
      hidden: field.hiddenAt !== null,
      hiddenAt: field.hiddenAt?.toISOString() ?? null,
    },
    current,
    history: page.map((h) => ({
      rowId: h.taskId,
      writeId: h.writeId,
      actorUserId: h.actorUserId,
      oldValue: h.oldValue,
      newValue: h.newValue,
      reason: h.reason,
      at: h.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

const SETTING_KINDS = {
  groupFieldId: "dropdown",
  dateFieldId: "date",
  statusFieldId: "dropdown",
} as const;
type SettingKey = keyof typeof SETTING_KINDS;
export type TableSettings = Partial<Record<SettingKey, string | null>>;

export function readTableSettings(body: unknown): TableSettings {
  if (!body || typeof body !== "object" || Array.isArray(body))
    tableError(422, "validation_failed", "A JSON object body is required");
  const settings: TableSettings = {};
  for (const key of Object.keys(SETTING_KINDS) as SettingKey[]) {
    const value = (body as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string")
      tableError(
        422,
        "validation_failed",
        `${key} must be a column id or null`,
      );
    settings[key] = value;
  }
  if (Object.keys(settings).length === 0)
    tableError(422, "validation_failed", "Nothing to change");
  return settings;
}

/** Spec 7.1: a definition writer, so it locks the project FOR UPDATE first (RF-8). */
export async function updateTableSettings(
  projectId: string,
  settings: TableSettings,
  actorUserId: string,
) {
  await db.transaction(async (tx) => {
    await lockProjectForDefinitions(tx, projectId);
    for (const [key, fieldId] of Object.entries(settings) as [
      SettingKey,
      string | null,
    ][]) {
      if (fieldId === null) continue;
      const [field] = await tx
        .select()
        .from(customFieldDefinitionTable)
        .where(
          and(
            eq(customFieldDefinitionTable.id, fieldId),
            eq(customFieldDefinitionTable.projectId, projectId),
            isNull(customFieldDefinitionTable.hiddenAt),
          ),
        )
        .for("update");
      if (!field || field.type !== SETTING_KINDS[key]) {
        tableError(
          422,
          "invalid_setting",
          "That column cannot be used for this setting",
          { setting: key },
        );
      }
    }
    await tx
      .update(operonTableProjectTable)
      .set(settings)
      .where(eq(operonTableProjectTable.projectId, projectId));
  });
  console.log("[operon] tables.settings_changed", {
    projectId,
    settings: Object.keys(settings),
    actorUserId,
  });
}
