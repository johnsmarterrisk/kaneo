import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { customFieldDefinitionTable } from "../../database/schema";
import { lockProjectForDefinitions } from "../../operon-tables/columns";

async function reorderCustomFields(
  projectId: string,
  customFields: Array<{ id: string; position: number }>,
) {
  await db.transaction(async (tx) => {
    // Operon fork addition (Tables, row 18, RF-8): every definition writer locks the
    // project first, the order the table row writer relies on. Harmless elsewhere.
    await lockProjectForDefinitions(tx, projectId);
    for (const field of customFields) {
      const [updated] = await tx
        .update(customFieldDefinitionTable)
        .set({ position: field.position })
        .where(
          and(
            eq(customFieldDefinitionTable.id, field.id),
            eq(customFieldDefinitionTable.projectId, projectId),
          ),
        )
        .returning({ id: customFieldDefinitionTable.id });

      if (!updated) {
        throw new HTTPException(400, {
          message: `Custom field ${field.id} does not belong to this project`,
        });
      }
    }
  });

  const updated = await db.query.customFieldDefinitionTable.findMany({
    where: eq(customFieldDefinitionTable.projectId, projectId),
    orderBy: (columns, { asc }) => [asc(columns.position)],
  });

  return updated;
}

export default reorderCustomFields;
