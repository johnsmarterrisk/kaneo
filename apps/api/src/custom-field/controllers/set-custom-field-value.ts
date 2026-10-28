import { eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

import db from "../../database";
import {
  customFieldDefinitionTable,
  customFieldValueTable,
  taskTable,
} from "../../database/schema";
import type { CardExecutor } from "../../operon-card-claims";
import { checkStashImage } from "../../operon-tables/stash-image";
import { validateCustomFieldValue } from "../../task/validate-task-fields";

function isMultiselectEmpty(value: string): boolean {
  if (!value || value.trim().length === 0) return true;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

async function setCustomFieldValue(
  taskId: string,
  fieldId: string,
  value: string,
  // Operon fork addition (Tables, row 18): the writer, for the Stash image check.
  userId?: string,
  executor: CardExecutor = db,
) {
  const [task] = await executor
    .select({
      projectId: taskTable.projectId,
    })
    .from(taskTable)
    .where(eq(taskTable.id, taskId))
    .limit(1);

  if (!task) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  const [field] = await executor
    .select()
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.id, fieldId))
    .limit(1);

  if (!field || field.projectId !== task.projectId) {
    throw new HTTPException(404, {
      message: "Custom field not found",
    });
  }

  let normalizedValue = value.trim();

  // Operon fork addition (Tables, fork-discipline row 18, spec 7.6): an image value is a
  // Stash file the writer may preview (checked on the signed channel, fail closed) and is
  // stored as its bare UUID; a link must be http(s), at most 2,000 characters.
  if (field.type === "image" && normalizedValue.length > 0) {
    if (!userId) {
      throw new HTTPException(400, { message: "An image needs a writer" });
    }
    normalizedValue = await checkStashImage(userId, normalizedValue);
  }
  if (field.type === "link" && normalizedValue.length > 0) {
    const error = validateCustomFieldValue(normalizedValue, "link", field.name);
    if (error) {
      throw new HTTPException(422, {
        res: Response.json(
          { error: "invalid_link", message: error },
          { status: 422 },
        ),
      });
    }
  }

  if (field.required) {
    if (field.type === "multiselect") {
      if (isMultiselectEmpty(normalizedValue)) {
        throw new HTTPException(400, {
          message: "This custom field is required",
        });
      }
    } else if (normalizedValue.length === 0) {
      throw new HTTPException(400, {
        message: "This custom field is required",
      });
    }
  }

  if (field.type === "dropdown" && normalizedValue.length > 0) {
    if (
      Array.isArray(field.options) &&
      !field.options.includes(normalizedValue)
    ) {
      throw new HTTPException(400, {
        message: "Invalid option for this custom field",
      });
    }
  }

  if (field.type === "number" && normalizedValue.length > 0) {
    if (Number.isNaN(Number(normalizedValue))) {
      throw new HTTPException(400, {
        message: "Value must be a valid number",
      });
    }
  }

  if (field.type === "boolean" && normalizedValue.length > 0) {
    if (normalizedValue !== "true" && normalizedValue !== "false") {
      throw new HTTPException(400, {
        message: "Value must be true or false",
      });
    }
  }

  if (field.type === "multiselect" && normalizedValue.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalizedValue);
    } catch {
      throw new HTTPException(400, {
        message: "Value must be a valid JSON array",
      });
    }

    if (!Array.isArray(parsed)) {
      throw new HTTPException(400, {
        message: "Value must be a JSON array",
      });
    }

    if (Array.isArray(field.options)) {
      const options = field.options as string[];

      const invalid = parsed.some(
        (v) => typeof v !== "string" || !options.includes(v),
      );

      if (invalid) {
        throw new HTTPException(400, {
          message: "Invalid option(s) for this custom field",
        });
      }
    }
  }

  const [result] = await executor
    .insert(customFieldValueTable)
    .values({
      taskId,
      fieldId,
      value: normalizedValue,
    })
    .onConflictDoUpdate({
      target: [customFieldValueTable.taskId, customFieldValueTable.fieldId],
      set: {
        value: sql`excluded.value`,
      },
    })
    .returning();

  return result;
}

export default setCustomFieldValue;
