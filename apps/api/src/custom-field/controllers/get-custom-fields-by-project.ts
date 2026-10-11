import { and, asc, eq, isNull } from "drizzle-orm";
import db from "../../database";
import { customFieldDefinitionTable } from "../../database/schema";

async function getCustomFieldsByProject(projectId: string) {
  return (
    db
      .select()
      .from(customFieldDefinitionTable)
      // Operon fork addition (Tables, row 18): hidden columns are not active definitions.
      .where(
        and(
          eq(customFieldDefinitionTable.projectId, projectId),
          isNull(customFieldDefinitionTable.hiddenAt),
        ),
      )
      .orderBy(asc(customFieldDefinitionTable.position))
  );
}

export default getCustomFieldsByProject;
