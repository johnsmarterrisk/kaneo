import { randomUUID } from "node:crypto";
import { and, asc, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  columnTable,
  customFieldDefinitionTable,
  customFieldValueTable,
  operonTableProjectTable,
  operonTableRowMetaTable,
  operonTableRowOutboxTable,
  operonTableValueHistoryTable,
  projectTable,
  taskTable,
  userTable,
} from "../database/schema";
import { publishEvent } from "../events";
import { deleteS3Keys, getTaskAssetKeys } from "../storage/cleanup-assets";
import { claimTaskNumber } from "../task/controllers/claim-task-numbers";
import { assertAssignableUser } from "../utils/assert-assignable-user";
import { kickTableOutbox } from "./outbox";
import { checkStashImage } from "./stash-image";
import {
  type ColumnDef,
  capCodePoints,
  displayValue,
  resolveColumn,
  TITLE_MAX_LENGTH,
  tableError,
  toStoredText,
  unknownColumn,
} from "./values";

/**
 * Operon fork addition (Tables task 5, docs/fork-discipline.md row 18, spec 7.3): the ONLY
 * code that writes a table row's title, Notes, owner or custom values. One save commits the
 * row, its value history, its attribution and its outbox records in ONE transaction (R-B,
 * R-B2, R-B3); the outbox drain (outbox.ts) delivers them to Operon afterwards.
 *
 * Lock order, everywhere (RF-8): the project row, then its definitions in `id` order, then
 * tasks in `id` order. A row save takes the project and definitions FOR SHARE; every
 * definition writer (tasks 6, 7, 10) and the project delete take the project FOR UPDATE
 * first, so a definition change, a delete and a row save serialize and cannot deadlock.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LockedTable = {
  project: { id: string; name: string; workspaceId: string };
  /** Active definitions in position order (task 6 filters hidden ones). */
  defs: ColumnDef[];
};

export type WriteReason = "save" | "topic_rename" | "topic_merge";

export type WriteContext = {
  actorUserId: string;
  /** One per transaction; a Topic Rename/Merge shares it across N rows (RF-3). */
  writeId: string;
  reason: WriteReason;
  /** Fixed before commit, so every retry of a record is byte-identical. */
  timestamp: string;
  actor: { id: string | null; name: string | null };
};

export type ResolvedRowInput = {
  taskId?: string;
  title?: string;
  notes?: string | null;
  assigneeId?: string | null;
  /** field id → stored text, `null` = clear. Already validated against `locked.defs`. */
  values: Map<string, string | null>;
};

export type RowWriteResult = {
  taskId: string;
  op: "create" | "update";
  changed: boolean;
  changedCount: number;
  events: Array<{ type: string; data: Record<string, unknown> }>;
};

/** Test seams: inject a failure or a pause at a named point of the row write. */
export const tableWriteHooks: {
  afterPreCheck?: () => Promise<void>;
  afterProjectLock?: () => Promise<void>;
  afterValueUpsert?: (tx: Tx) => Promise<void>;
} = {};

const CORE_NAMES = { title: "Title", notes: "Notes", assignee: "Owner" };
const ENVELOPE_TITLE_MAX = 80;

const DEF_COLUMNS = {
  id: customFieldDefinitionTable.id,
  name: customFieldDefinitionTable.name,
  type: customFieldDefinitionTable.type,
  required: customFieldDefinitionTable.required,
  options: customFieldDefinitionTable.options,
  position: customFieldDefinitionTable.position,
};

function byPosition(a: ColumnDef, b: ColumnDef) {
  return a.position - b.position || a.id.localeCompare(b.id);
}

/** The table and its active definitions, unlocked (pre-check and reads). */
export async function loadTable(
  projectId: string,
): Promise<LockedTable | null> {
  const [project] = await db
    .select({
      id: projectTable.id,
      name: projectTable.name,
      workspaceId: projectTable.workspaceId,
    })
    .from(projectTable)
    .innerJoin(
      operonTableProjectTable,
      eq(operonTableProjectTable.projectId, projectTable.id),
    )
    .where(eq(projectTable.id, projectId))
    .limit(1);
  if (!project) return null;
  const defs = await db
    .select(DEF_COLUMNS)
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, projectId));
  return { project, defs: defs.sort(byPosition) };
}

/**
 * Lock the project row, then its definitions in `id` order — FOR SHARE for a row save,
 * FOR UPDATE for a definition writer (spec 7.3 step 3). Null when not a table.
 */
export async function lockTable(
  tx: Tx,
  projectId: string,
  mode: "share" | "update",
): Promise<LockedTable | null> {
  const [project] = await tx
    .select({
      id: projectTable.id,
      name: projectTable.name,
      workspaceId: projectTable.workspaceId,
    })
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .for(mode);
  if (!project) return null;
  const [flag] = await tx
    .select({ projectId: operonTableProjectTable.projectId })
    .from(operonTableProjectTable)
    .where(eq(operonTableProjectTable.projectId, projectId))
    .limit(1);
  if (!flag) return null;
  const defs = await tx
    .select(DEF_COLUMNS)
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, projectId))
    .orderBy(asc(customFieldDefinitionTable.id))
    .for(mode);
  return { project, defs: defs.sort(byPosition) };
}

export async function resolveActor(userId: string) {
  const [user] = await db
    .select({ id: userTable.id, name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  return { id: user?.id ?? userId, name: user?.name ?? null };
}

function taskUrl(workspaceId: string, projectId: string, taskId: string) {
  const clientUrl = process.env.KANEO_CLIENT_URL || "http://localhost:5173";
  return `${clientUrl}/dashboard/workspace/${workspaceId}/project/${projectId}/task/${taskId}`;
}

async function statusName(tx: Tx, columnId: string | null) {
  if (!columnId) return null;
  const [column] = await tx
    .select({ name: columnTable.name })
    .from(columnTable)
    .where(eq(columnTable.id, columnId))
    .limit(1);
  return column?.name ?? null;
}

/**
 * The generic-webhook envelope `sendEvent` builds (spec 7.3 step 6), with `task.title`
 * capped at 80 code points for EVERY table row delivery; the task row keeps its full title.
 */
async function envelope(
  tx: Tx,
  locked: LockedTable,
  ctx: WriteContext,
  event: string,
  task: typeof taskTable.$inferSelect,
  data: Record<string, unknown>,
) {
  return {
    event,
    timestamp: ctx.timestamp,
    integration: { type: "generic-webhook" },
    project: {
      id: locked.project.id,
      name: locked.project.name,
      workspaceId: locked.project.workspaceId,
    },
    task: {
      id: task.id,
      number: task.number,
      title: capCodePoints(task.title, ENVELOPE_TITLE_MAX),
      status: task.status,
      statusName: (await statusName(tx, task.columnId)) ?? task.status,
      priority: task.priority,
      url: taskUrl(locked.project.workspaceId, locked.project.id, task.id),
    },
    actor: ctx.actor,
    data,
  };
}

/**
 * Steps 3 (task lock) to 6 of spec 7.3 inside the caller's transaction, which already holds
 * the project and definition locks. `input.values` is already validated against
 * `locked.defs`. A save equal to the stored row writes nothing (R-G).
 */
export async function writeTableRowInTx(
  tx: Tx,
  locked: LockedTable,
  ctx: WriteContext,
  input: ResolvedRowInput,
): Promise<RowWriteResult> {
  const projectId = locked.project.id;
  const defsById = new Map(locked.defs.map((d) => [d.id, d]));
  const creating = !input.taskId;

  let task: typeof taskTable.$inferSelect;
  const stored = new Map<string, string | null>();

  if (creating) {
    const [firstColumn] = await tx
      .select({ id: columnTable.id, slug: columnTable.slug })
      .from(columnTable)
      .where(eq(columnTable.projectId, projectId))
      .orderBy(asc(columnTable.position))
      .limit(1);
    const number = await claimTaskNumber(projectId, tx);
    const [maxPosition] = await tx
      .select({ value: max(taskTable.position) })
      .from(taskTable)
      .where(eq(taskTable.projectId, projectId));
    const [inserted] = await tx
      .insert(taskTable)
      .values({
        projectId,
        title: input.title ?? "",
        description: input.notes ?? "",
        userId: input.assigneeId ?? null,
        status: firstColumn?.slug ?? "to-do",
        columnId: firstColumn?.id ?? null,
        priority: "no-priority",
        number,
        position: (maxPosition?.value ?? 0) + 1,
      })
      .returning();
    if (!inserted) throw new Error("table row insert returned no row");
    task = inserted;
  } else {
    const [locked_] = await tx
      .select()
      .from(taskTable)
      .where(
        and(
          eq(taskTable.id, input.taskId as string),
          eq(taskTable.projectId, projectId),
        ),
      )
      .for("update");
    if (!locked_) {
      tableError(404, "row_not_in_table", "That entry is not in this table");
    }
    task = locked_;
    await tx
      .select({ taskId: operonTableRowMetaTable.taskId })
      .from(operonTableRowMetaTable)
      .where(eq(operonTableRowMetaTable.taskId, task.id))
      .for("update");
    const rows = await tx
      .select({
        fieldId: customFieldValueTable.fieldId,
        value: customFieldValueTable.value,
      })
      .from(customFieldValueTable)
      .where(eq(customFieldValueTable.taskId, task.id));
    for (const row of rows) stored.set(row.fieldId, row.value ?? null);
  }

  // Step 4: the diff against what is stored.
  const changes: Array<{
    def: ColumnDef;
    old: string | null;
    next: string | null;
  }> = [];
  for (const [fieldId, next] of input.values) {
    const def = defsById.get(fieldId);
    if (!def) continue;
    const old = stored.get(fieldId) ?? null;
    if ((old ?? null) !== (next ?? null)) changes.push({ def, old, next });
  }
  const core: Array<{
    fieldId: "title" | "notes" | "assignee";
    value: unknown;
  }> = [];
  const update: Partial<typeof taskTable.$inferInsert> = {};
  if (creating) {
    core.push({ fieldId: "title", value: task.title });
    if (input.notes) core.push({ fieldId: "notes", value: input.notes });
    if (input.assigneeId)
      core.push({ fieldId: "assignee", value: input.assigneeId });
  } else {
    if (input.title !== undefined && input.title !== task.title) {
      update.title = input.title;
      core.push({ fieldId: "title", value: input.title });
    }
    if (
      input.notes !== undefined &&
      (input.notes ?? "") !== (task.description ?? "")
    ) {
      update.description = input.notes ?? "";
      core.push({ fieldId: "notes", value: input.notes ?? null });
    }
    if (
      input.assigneeId !== undefined &&
      (input.assigneeId ?? null) !== (task.userId ?? null)
    ) {
      update.userId = input.assigneeId ?? null;
      core.push({ fieldId: "assignee", value: input.assigneeId ?? null });
    }
  }

  if (!creating && changes.length === 0 && core.length === 0) {
    return {
      taskId: task.id,
      op: "update",
      changed: false,
      changedCount: 0,
      events: [],
    };
  }

  const before = task;
  if (Object.keys(update).length > 0) {
    const [updated] = await tx
      .update(taskTable)
      .set(update)
      .where(eq(taskTable.id, task.id))
      .returning();
    if (updated) task = updated;
  }

  // Step 5: values, history, attribution.
  for (const change of changes) {
    if (change.next === null) {
      await tx
        .delete(customFieldValueTable)
        .where(
          and(
            eq(customFieldValueTable.taskId, task.id),
            eq(customFieldValueTable.fieldId, change.def.id),
          ),
        );
    } else {
      await tx
        .insert(customFieldValueTable)
        .values({ taskId: task.id, fieldId: change.def.id, value: change.next })
        .onConflictDoUpdate({
          target: [customFieldValueTable.taskId, customFieldValueTable.fieldId],
          set: { value: change.next },
        });
    }
  }
  await tableWriteHooks.afterValueUpsert?.(tx);

  if (changes.length > 0) {
    await tx.insert(operonTableValueHistoryTable).values(
      changes.map((change) => ({
        projectId,
        taskId: task.id,
        fieldId: change.def.id,
        writeId: ctx.writeId,
        actorUserId: ctx.actorUserId,
        oldValue: change.old,
        newValue: change.next,
        reason: ctx.reason,
      })),
    );
  }

  const lastChange = {
    fieldIds: changes.map((c) => c.def.id),
    core: core.map((c) => c.fieldId),
  };
  const now = new Date(ctx.timestamp);
  if (creating) {
    await tx.insert(operonTableRowMetaTable).values({
      taskId: task.id,
      projectId,
      createdByUserId: ctx.actorUserId,
      createdAt: now,
      lastWriterUserId: ctx.actorUserId,
      lastWriteId: ctx.writeId,
      lastChangedAt: now,
      lastChange,
    });
  } else {
    // A row always has its meta (only this module creates rows); the upsert is a safety net
    // that never rewrites the creator.
    await tx
      .insert(operonTableRowMetaTable)
      .values({
        taskId: task.id,
        projectId,
        createdByUserId: ctx.actorUserId,
        lastWriterUserId: ctx.actorUserId,
        lastWriteId: ctx.writeId,
        lastChangedAt: now,
        lastChange,
      })
      .onConflictDoUpdate({
        target: operonTableRowMetaTable.taskId,
        set: {
          lastWriterUserId: ctx.actorUserId,
          lastWriteId: ctx.writeId,
          lastChangedAt: now,
          lastChange,
        },
      });
  }

  // Step 6: the outbox records, committed with the row.
  const fieldsChanged = {
    writeId: ctx.writeId,
    reason: ctx.reason,
    changes: changes.map((c) => ({
      fieldId: c.def.id,
      name: c.def.name,
      kind: c.def.type,
      value: displayValue(c.def, c.next),
    })),
    core: core.map((c) => ({
      fieldId: c.fieldId,
      name: CORE_NAMES[c.fieldId],
      value: c.value ?? null,
    })),
  };
  const records: Array<{ event: string; payload: Record<string, unknown> }> =
    [];
  if (creating) {
    records.push({
      event: "task.created",
      payload: await envelope(tx, locked, ctx, "task.created", task, {
        title: capCodePoints(task.title, ENVELOPE_TITLE_MAX),
        number: task.number,
        status: task.status,
        priority: task.priority,
      }),
    });
  }
  records.push({
    event: "task.fields_changed",
    payload: await envelope(
      tx,
      locked,
      ctx,
      "task.fields_changed",
      task,
      fieldsChanged,
    ),
  });
  await tx.insert(operonTableRowOutboxTable).values(
    records.map((record) => ({
      projectId,
      taskId: task.id,
      event: record.event,
      writeId: ctx.writeId,
      payload: record.payload,
    })),
  );

  // Initiative's own activity and notifications, published after commit by the caller.
  const events: RowWriteResult["events"] = [];
  if (creating) {
    events.push({
      type: "task.created",
      data: {
        ...task,
        taskId: task.id,
        userId: task.userId ?? "",
        currentUserId: ctx.actorUserId,
        type: "created",
        content: null,
      },
    });
  } else {
    if (update.title !== undefined) {
      events.push({
        type: "task.title_changed",
        data: {
          taskId: task.id,
          projectId,
          userId: ctx.actorUserId,
          oldTitle: before.title,
          newTitle: task.title,
          type: "title_changed",
        },
      });
    }
    if (update.description !== undefined) {
      events.push({
        type: "task.description_changed",
        data: {
          taskId: task.id,
          projectId,
          userId: ctx.actorUserId,
          oldDescription: before.description,
          newDescription: task.description,
          title: task.title,
          type: "description_changed",
        },
      });
    }
  }

  return {
    taskId: task.id,
    op: creating ? "create" : "update",
    changed: true,
    changedCount: changes.length + core.length,
    events,
  };
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type RowBody = {
  requestId?: unknown;
  title?: unknown;
  notes?: unknown;
  assigneeId?: unknown;
  values?: unknown;
};

function validationFailed(message: string): never {
  tableError(422, "validation_failed", message);
}

function readTitle(value: unknown, required: boolean) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") validationFailed("title is required");
  const title = value.trim();
  if (!title || title.length > TITLE_MAX_LENGTH)
    validationFailed(`title must be 1-${TITLE_MAX_LENGTH} characters`);
  return title;
}

function readNullableString(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") validationFailed(`${name} must be a string`);
  return value;
}

function readValues(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    validationFailed("values must be an object");
  return value as Record<string, unknown>;
}

/** Logs the refusal's machine reason (never a value, R-H); the body is cloned, not consumed. */
export async function refusalReason(error: unknown): Promise<string | null> {
  if (!(error instanceof HTTPException)) return null;
  try {
    const body = (await error.res?.clone().json()) as { error?: unknown };
    if (typeof body?.error === "string") return body.error;
  } catch {
    // not a structured refusal
  }
  return `http_${error.status}`;
}

async function logRefused(
  projectId: string,
  taskId: string | null,
  actorUserId: string,
  error: unknown,
) {
  const reason = await refusalReason(error);
  if (!reason) return;
  console.warn("[operon] tables.row_write_refused", {
    projectId,
    taskId,
    reason,
    actorUserId,
  });
}

async function publishAll(events: RowWriteResult["events"]) {
  for (const event of events) {
    await publishEvent(event.type, event.data);
  }
}

/**
 * The route wrapper (spec 7.3): pre-check outside any lock (fail fast, the Stash check),
 * then ONE transaction that locks, revalidates against the locked definitions (RF-8) and
 * writes; after commit, Initiative's events and a drain kick.
 */
export async function writeTableRow({
  projectId,
  workspaceId,
  actorUserId,
  via,
  taskId,
  body,
}: {
  projectId: string;
  workspaceId: string;
  actorUserId: string;
  via: "session" | "api_key";
  taskId?: string;
  body: RowBody;
}): Promise<{ taskId: string; changed: boolean }> {
  try {
    const creating = !taskId;
    if (creating) {
      // Required of every caller (R-C); task 12 adds the request tombstone and replay.
      if (
        typeof body.requestId !== "string" ||
        !REQUEST_ID.test(body.requestId)
      )
        validationFailed("requestId is required (1-64 of A-Z a-z 0-9 _ -)");
    }
    const title = readTitle(body.title, creating);
    const notes = readNullableString(body.notes, "notes");
    let assigneeId = readNullableString(body.assigneeId, "assigneeId");
    if (assigneeId === "") assigneeId = null;
    const values = readValues(body.values);

    // Step 1: fail fast, no lock held (the Stash check is an HTTP call).
    const pre = await loadTable(projectId);
    if (!pre) tableError(404, "not_a_table", "This project is not a table");
    const images = new Map<string, { fieldId: string; text: string | null }>();
    for (const [key, value] of Object.entries(values)) {
      const def = resolveColumn(pre.defs, key) ?? unknownColumn(pre.defs);
      let text = toStoredText(def, value);
      if (def.type === "image" && text !== null) {
        text = await checkStashImage(actorUserId, text);
      }
      if (def.type === "image") images.set(key, { fieldId: def.id, text });
    }
    if (assigneeId) {
      try {
        await assertAssignableUser(assigneeId, workspaceId);
      } catch (error) {
        if (error instanceof HTTPException) {
          tableError(
            422,
            "invalid_assignee",
            "That person cannot own entries in this workspace",
          );
        }
        throw error;
      }
    }
    await tableWriteHooks.afterPreCheck?.();

    const ctx: WriteContext = {
      actorUserId,
      writeId: randomUUID(),
      reason: "save",
      timestamp: new Date().toISOString(),
      actor: await resolveActor(actorUserId),
    };

    const result = await db.transaction(async (tx) => {
      const locked = await lockTable(tx, projectId, "share");
      if (!locked)
        tableError(404, "not_a_table", "This project is not a table");
      await tableWriteHooks.afterProjectLock?.();

      // Step 3: the check of record, against the LOCKED definitions (RF-8).
      const resolved = new Map<string, string | null>();
      for (const [key, value] of Object.entries(values)) {
        const def =
          resolveColumn(locked.defs, key) ?? unknownColumn(locked.defs);
        if (def.type === "image") {
          const checked = images.get(key);
          // The key now names a different column than the one Stash-checked.
          if (!checked || checked.fieldId !== def.id)
            unknownColumn(locked.defs);
          resolved.set(def.id, checked.text);
        } else {
          resolved.set(def.id, toStoredText(def, value));
        }
      }
      for (const def of locked.defs) {
        if (!def.required) continue;
        const cleared = resolved.has(def.id) && resolved.get(def.id) === null;
        const missing = creating && !resolved.get(def.id);
        if (cleared || missing) {
          tableError(422, "required_value", "This column needs a value", {
            column: def.name,
          });
        }
      }
      return writeTableRowInTx(tx, locked, ctx, {
        taskId,
        title,
        notes,
        assigneeId,
        values: resolved,
      });
    });

    if (result.changed) {
      console.log("[operon] tables.row_written", {
        projectId,
        taskId: result.taskId,
        writeId: ctx.writeId,
        op: result.op,
        changedCount: result.changedCount,
        actorUserId,
        via,
      });
      await publishAll(result.events);
      kickTableOutbox();
    }
    return { taskId: result.taskId, changed: result.changed };
  } catch (error) {
    await logRefused(projectId, taskId ?? null, actorUserId, error);
    throw error;
  }
}

/** Spec 7.3 step 6, delete: `task.deleted` built before the delete, history kept. */
export async function deleteTableRow({
  projectId,
  actorUserId,
  via,
  taskId,
}: {
  projectId: string;
  actorUserId: string;
  via: "session" | "api_key";
  taskId: string;
}) {
  const ctx: WriteContext = {
    actorUserId,
    writeId: randomUUID(),
    reason: "save",
    timestamp: new Date().toISOString(),
    actor: await resolveActor(actorUserId),
  };
  const assetKeys = await getTaskAssetKeys(taskId);
  const deleted = await db.transaction(async (tx) => {
    const locked = await lockTable(tx, projectId, "share");
    if (!locked) tableError(404, "not_a_table", "This project is not a table");
    const [task] = await tx
      .select()
      .from(taskTable)
      .where(and(eq(taskTable.id, taskId), eq(taskTable.projectId, projectId)))
      .for("update");
    if (!task)
      tableError(404, "row_not_in_table", "That entry is not in this table");
    await tx.insert(operonTableRowOutboxTable).values({
      projectId,
      taskId: task.id,
      event: "task.deleted",
      writeId: ctx.writeId,
      payload: await envelope(tx, locked, ctx, "task.deleted", task, {}),
    });
    await tx.delete(taskTable).where(eq(taskTable.id, task.id));
    return task;
  });

  console.log("[operon] tables.row_written", {
    projectId,
    taskId,
    writeId: ctx.writeId,
    op: "delete",
    changedCount: 0,
    actorUserId,
    via,
  });
  await publishEvent("task.deleted", {
    taskId: deleted.id,
    projectId,
    userId: actorUserId,
    title: deleted.title,
  });
  kickTableOutbox();
  if (assetKeys.length > 0) deleteS3Keys(assetKeys).catch(() => {});
  return deleted;
}
