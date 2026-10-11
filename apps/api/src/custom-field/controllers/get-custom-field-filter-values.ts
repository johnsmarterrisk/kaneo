import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import db from "../../database";
import {
  customFieldDefinitionTable,
  customFieldValueTable,
} from "../../database/schema";

export default async function getCustomFieldFilterValues(projectId: string) {
  const fields = await db
    .select()
    .from(customFieldDefinitionTable)
    // Operon fork addition (Tables, row 18): hidden columns offer no filter values.
    .where(
      and(
        eq(customFieldDefinitionTable.projectId, projectId),
        isNull(customFieldDefinitionTable.hiddenAt),
      ),
    );

  if (fields.length === 0) {
    return [];
  }
  const rows = await db
    .selectDistinct({
      fieldId: customFieldValueTable.fieldId,
      value: customFieldValueTable.value,
    })
    .from(customFieldValueTable)
    .where(
      and(
        inArray(
          customFieldValueTable.fieldId,
          fields.map((field) => field.id),
        ),
        isNotNull(customFieldValueTable.value),
        ne(customFieldValueTable.value, ""),
      ),
    );
  const valuesByField = new Map<string, string[]>();
  for (const row of rows) {
    const bucket = valuesByField.get(row.fieldId) ?? [];
    bucket.push(row.value as string);
    valuesByField.set(row.fieldId, bucket);
  }
  return fields.map((field) => ({
    fieldId: field.id,
    fieldName: field.name,
    fieldType: field.type,
    values: valuesByField.get(field.id) ?? [],
  }));
}
