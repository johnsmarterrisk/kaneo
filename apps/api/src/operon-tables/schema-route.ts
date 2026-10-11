import { z } from "zod";
import { LINK_MAX_LENGTH } from "../task/validate-task-fields";
import {
  type ColumnDef,
  optionList,
  TEXT_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "./values";
import type { LockedTable } from "./write-row";

/**
 * Operon fork addition (Tables task 12, docs/fork-discipline.md row 18, spec 7.8): the
 * columns an agent reads before it writes, and the JSON Schema of an entry, through zod's
 * own `z.toJSONSchema` rather than a hand-written schema. Built from the table's ACTIVE
 * definitions only (a hidden column never appears), with every dropdown's CURRENT options
 * as its enum. The route still validates every write against the definitions of record;
 * this schema is guidance, never the check.
 */
function columnSchema(def: ColumnDef): z.ZodType {
  const options = optionList(def);
  switch (def.type) {
    case "text":
      return z.string().max(TEXT_MAX_LENGTH);
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "date":
      return z.iso.date().describe("A date, YYYY-MM-DD");
    case "dropdown":
      // No option yet (a new table's Topic): nothing is accepted until an admin adds one.
      return options.length > 0
        ? z.enum(options as [string, ...string[]])
        : z.never();
    case "multiselect":
      return z.array(
        options.length > 0
          ? z.enum(options as [string, ...string[]])
          : z.never(),
      );
    case "link":
      // The row writer accepts http(s) only (validate-task-fields.ts), so the published
      // schema says exactly that: a protocol-limited URL plus a pattern JSON Schema carries
      // (codex round 1, finding 6).
      return z
        .url({ protocol: /^https?$/ })
        .max(LINK_MAX_LENGTH)
        .regex(/^https?:\/\//i)
        .describe("An http(s) URL");
    case "image":
      return z.string().describe("A Stash file id");
    default:
      return z.unknown();
  }
}

export function tableSchema(table: LockedTable) {
  const values: Record<string, z.ZodType> = {};
  for (const def of table.defs) {
    const column = columnSchema(def);
    // `null` clears a value on update; a required column must carry one on add.
    values[def.name] = def.required ? column : column.nullable().optional();
  }
  const entry = z.strictObject({
    title: z.string().min(1).max(TITLE_MAX_LENGTH),
    notes: z.string().optional(),
    assigneeId: z.string().nullable().optional(),
    values: z.strictObject(values),
  });
  return {
    tableId: table.project.id,
    name: table.project.name,
    columns: table.defs.map((def) => ({
      id: def.id,
      name: def.name,
      kind: def.type,
      required: def.required,
      ...(def.type === "dropdown" || def.type === "multiselect"
        ? { options: optionList(def) }
        : {}),
    })),
    jsonSchema: z.toJSONSchema(entry),
  };
}
