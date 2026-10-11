import { and, eq, isNull } from "drizzle-orm";
import db from "../../database";
import {
  customFieldDefinitionTable,
  customFieldValueTable,
  taskTable,
} from "../../database/schema";

async function getCustomFieldValuesByProject(projectId: string) {
  return (
    db
      .select({
        id: customFieldValueTable.id,
        taskId: customFieldValueTable.taskId,
        fieldId: customFieldValueTable.fieldId,
        value: customFieldValueTable.value,
        fieldName: customFieldDefinitionTable.name,
        fieldPosition: customFieldDefinitionTable.position,
        fieldType: customFieldDefinitionTable.type,
        fieldOptions: customFieldDefinitionTable.options,
      })
      .from(customFieldValueTable)
      .innerJoin(taskTable, eq(customFieldValueTable.taskId, taskTable.id))
      .innerJoin(
        customFieldDefinitionTable,
        eq(customFieldValueTable.fieldId, customFieldDefinitionTable.id),
      )
      // Operon fork addition (Tables, row 18): a hidden column's values are not listed.
      .where(
        and(
          eq(taskTable.projectId, projectId),
          isNull(customFieldDefinitionTable.hiddenAt),
        ),
      )
  );
}

export default getCustomFieldValuesByProject;
