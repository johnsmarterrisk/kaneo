import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  customFieldDefinitionTable,
  projectTable,
} from "../../database/schema";
import { hideTableColumn } from "../../operon-tables/columns";
import { isTableProject } from "../../operon-tables/guard";

async function deleteCustomField(
  id: string,
  // Operon fork addition (Tables, row 18): the actor, for the hide log line.
  actorUserId?: string,
) {
  const [field] = await db
    .select({
      projectId: customFieldDefinitionTable.projectId,
      workspaceId: projectTable.workspaceId,
    })
    .from(customFieldDefinitionTable)
    .innerJoin(
      projectTable,
      eq(projectTable.id, customFieldDefinitionTable.projectId),
    )
    .where(eq(customFieldDefinitionTable.id, id))
    .limit(1);

  if (!field) {
    throw new HTTPException(404, {
      message: "Custom field or project not found",
    });
  }

  if (!field.workspaceId) {
    throw new HTTPException(400, {
      message: "The project is not associated with a workspace",
    });
  }

  // Operon fork addition (Tables task 6, row 18, spec 7.1): on a table project a column is
  // HIDDEN, never deleted — the cascade would erase its values and history.
  if (await isTableProject(field.projectId)) {
    const hidden = await hideTableColumn(id, actorUserId);
    return { ...hidden, workspaceId: field.workspaceId };
  }

  const [deleted] = await db
    .delete(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.id, id))
    .returning();

  if (!deleted) {
    throw new HTTPException(404, {
      message: "Custom field not found",
    });
  }

  return {
    ...deleted,
    workspaceId: field.workspaceId,
  };
}

export default deleteCustomField;
