import { and, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { postgresFailure, UNIQUE_VIOLATION } from "../../auth";
import db from "../../database";
import {
  columnTable,
  customFieldDefinitionTable,
  customFieldValueTable,
  projectTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { checkStashImage } from "../../operon-tables/stash-image";
import {
  assertAssignableUser,
  getProjectWorkspaceId,
} from "../../utils/assert-assignable-user";
import {
  assertRequiredCustomFields,
  assertValidTaskStatus,
  isCustomFieldValueEmpty,
} from "../validate-task-fields";
import { claimTaskNumber } from "./claim-task-numbers";

type CustomFieldInput = {
  fieldId: string;
  value: string;
};

function deduplicateCustomFields(
  customFields?: CustomFieldInput[],
): CustomFieldInput[] | undefined {
  if (!customFields) {
    return undefined;
  }

  const fieldsById = new Map<string, CustomFieldInput>();

  for (const customField of customFields) {
    fieldsById.set(customField.fieldId, customField);
  }

  return Array.from(fieldsById.values());
}

async function createTask({
  projectId,
  currentUserId,
  userId,
  title,
  status,
  startDate,
  dueDate,
  description,
  priority,
  operonIdempotencyKey,
  customFields,
}: {
  projectId: string;
  currentUserId: string;
  userId?: string;
  title: string;
  status: string;
  startDate?: Date;
  dueDate?: Date;
  description?: string;
  priority?: string;
  operonIdempotencyKey?: string;
  customFields?: CustomFieldInput[];
}) {
  const resolvedStatus = status || "to-do";
  const resolvedPriority = priority || "no-priority";
  const normalizedCustomFields = deduplicateCustomFields(customFields);

  const normalizedUserId = userId?.trim() || undefined;

  await assertValidTaskStatus(resolvedStatus, projectId);

  const allFields = await db
    .select()
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, projectId));

  const mergedCustomFields: CustomFieldInput[] = normalizedCustomFields ?? [];
  const providedFieldIds = new Set(mergedCustomFields.map((f) => f.fieldId));

  for (const field of allFields) {
    if (
      !providedFieldIds.has(field.id) &&
      field.required &&
      field.defaultValue != null &&
      !isCustomFieldValueEmpty(
        field.defaultValue,
        field.type as
          | "number"
          | "boolean"
          | "date"
          | "dropdown"
          | "multiselect",
      )
    ) {
      mergedCustomFields.push({
        fieldId: field.id,
        value: field.defaultValue,
      });
    }
  }

  // Operon fork addition (Tables, fork-discipline row 18, spec 7.6): an image value is
  // checked with Stash for the creator and stored as the bare file UUID (a pasted
  // `/#/files/<uuid>` link is normalised). Fails closed: 422 image_refused / 503.
  for (const input of mergedCustomFields) {
    const field = allFields.find((f) => f.id === input.fieldId);
    if (field?.type === "image" && input.value.trim() !== "") {
      input.value = await checkStashImage(currentUserId, input.value);
    }
  }

  await assertRequiredCustomFields(projectId, mergedCustomFields);

  let assignee: { name: string } | undefined;

  if (normalizedUserId) {
    await assertAssignableUser(
      normalizedUserId,
      await getProjectWorkspaceId(projectId),
    );

    [assignee] = await db
      .select({ name: userTable.name })
      .from(userTable)
      .where(eq(userTable.id, normalizedUserId));
  }

  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, projectId),
      eq(columnTable.slug, resolvedStatus),
    ),
  });

  const [maxPositionResult] = await db
    .select({ maxPosition: max(taskTable.position) })
    .from(taskTable)
    .where(
      and(
        eq(taskTable.projectId, projectId),
        column?.id
          ? eq(taskTable.columnId, column.id)
          : eq(taskTable.status, resolvedStatus),
      ),
    );

  const nextPosition = (maxPositionResult?.maxPosition ?? 0) + 1;

  const createdTask = await db.transaction(async (tx) => {
    const taskNumber = await claimTaskNumber(projectId, tx);

    const [task] = await tx
      .insert(taskTable)
      .values({
        projectId,
        userId: normalizedUserId ?? null,
        title: title || "",
        status: resolvedStatus,
        columnId: column?.id ?? null,
        startDate: startDate || null,
        dueDate: dueDate || null,
        description: description || "",
        priority: resolvedPriority,
        number: taskNumber,
        position: nextPosition,
        operonIdempotencyKey: operonIdempotencyKey ?? null,
      })
      .returning();

    if (task && mergedCustomFields.length) {
      await tx.insert(customFieldValueTable).values(
        mergedCustomFields.map(({ fieldId, value }) => ({
          taskId: task.id,
          fieldId,
          value: value.trim(),
        })),
      );
    }

    return task;
  });

  if (!createdTask) {
    throw new HTTPException(500, {
      message: "Failed to create task",
    });
  }

  await publishEvent("task.created", {
    ...createdTask,
    taskId: createdTask.id,
    userId: createdTask.userId ?? "",
    currentUserId: currentUserId,
    type: "created",
    content: null,
  });

  return {
    ...createdTask,
    assigneeName: assignee?.name,
  };
}

/**
 * Smart Desk F0b (F4, F5): the task an Operon `Idempotency-Key` already created, in the
 * shape `createTask` returns (the full row plus `assigneeName`, the same assignee join
 * `get-task.ts` uses), or undefined when no task carries the key.
 *
 * It answers with the task AS IT STANDS NOW — its current project included if someone
 * moved it — and never with a task from another workspace: that is a 409 carrying no
 * task data, because a key must not become a way to read across workspaces.
 */
export async function findOperonKeyedTask(key: string, workspaceId: string) {
  const [found] = await db
    .select({
      task: taskTable,
      assigneeName: userTable.name,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .where(eq(taskTable.operonIdempotencyKey, key))
    .limit(1);

  if (!found) return undefined;

  if (found.workspaceId !== workspaceId) {
    throw new HTTPException(409, {
      res: Response.json(
        {
          code: "idempotency_key_conflict",
          message:
            "This Idempotency-Key belongs to a task in another workspace",
        },
        { status: 409 },
      ),
    });
  }

  // `createTask` returns `assigneeName: assignee?.name`, i.e. absent when unassigned.
  return { ...found.task, assigneeName: found.assigneeName ?? undefined };
}

/** A concurrent keyed create won the `task_operon_idempotency_key_unique` race. */
export function isOperonIdempotencyKeyViolation(error: unknown) {
  const failure = postgresFailure(error);
  return (
    failure?.code === UNIQUE_VIOLATION &&
    failure.constraint === "task_operon_idempotency_key_unique"
  );
}

export default createTask;
