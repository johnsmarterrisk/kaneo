import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import db from "../database";
import {
  customFieldDefinitionTable,
  customFieldValueTable,
  taskTable,
} from "../database/schema";
import { kickTableOutbox } from "./outbox";
import { optionList, tableError, unknownColumn } from "./values";
import {
  lockTable,
  notifyTableRowsChanged,
  readLabel,
  resolveActor,
  type WriteContext,
  writeTableRowInTx,
} from "./write-row";

/**
 * Operon fork addition (Tables task 7, docs/fork-discipline.md row 18, spec 7.3a, RF-3,
 * RF-8): an admin adds, renames or merges a choice column's options. Rename and Merge
 * rewrite every row carrying the option through `writeTableRowInTx` — one history row and
 * one `fields_changed` record per row, all sharing ONE writeId, each with its own task id
 * — and update the options, all in ONE transaction: project, then definitions, then the
 * affected tasks in id order, every lock FOR UPDATE. Any failure rolls back every row,
 * the options and every outbox record.
 */
export type OptionEdit =
  | { action: "add"; label: string }
  | { action: "rename"; from: string; to: string }
  | { action: "merge"; from: string; into: string };

const CHOICE_KINDS = new Set(["dropdown", "multiselect"]);

function fold(label: string) {
  return label.trim().toLowerCase();
}

export function readOptionEdit(body: unknown): OptionEdit {
  const b = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  switch (b.action) {
    case "add":
      return { action: "add", label: readLabel(b.label) };
    case "rename":
      return {
        action: "rename",
        from: readLabel(b.from, "from"),
        to: readLabel(b.to, "to"),
      };
    case "merge":
      return {
        action: "merge",
        from: readLabel(b.from, "from"),
        into: readLabel(b.into, "into"),
      };
    default:
      tableError(
        422,
        "validation_failed",
        "action must be add, rename or merge",
      );
  }
}

/** Test seam: fail a rename/merge after its rows are rewritten, before the options. */
export const optionEditHooks: { afterRows?: () => Promise<void> } = {};

function refuse(reason: string, message: string, extra = {}): never {
  tableError(reason === "unknown_column" ? 422 : 409, reason, message, extra);
}

export async function editOptions({
  projectId,
  fieldId,
  actorUserId,
  edit,
}: {
  projectId: string;
  fieldId: string;
  actorUserId: string;
  edit: OptionEdit;
}) {
  const ctx: WriteContext = {
    actorUserId,
    writeId: randomUUID(),
    reason: edit.action === "merge" ? "topic_merge" : "topic_rename",
    timestamp: new Date().toISOString(),
    actor: await resolveActor(actorUserId),
  };

  const result = await db.transaction(async (tx) => {
    const locked = await lockTable(tx, projectId, "update");
    if (!locked) tableError(404, "not_a_table", "This project is not a table");
    // Active columns of THIS table only: a hidden or another table's field is refused.
    const def = locked.defs.find((d) => d.id === fieldId);
    if (!def) unknownColumn(locked.defs);
    if (!CHOICE_KINDS.has(def.type)) {
      refuse("not_a_choice_column", "Only choice columns have options");
    }
    const options = optionList(def);
    const find = (label: string) =>
      options.find((o) => fold(o) === fold(label));

    if (edit.action === "add") {
      const existing = find(edit.label);
      if (existing)
        return {
          def,
          options,
          rows: 0,
          taskIds: [] as string[],
          added: false,
          label: existing,
        };
      const next = [...options, edit.label];
      await tx
        .update(customFieldDefinitionTable)
        .set({ options: next })
        .where(eq(customFieldDefinitionTable.id, def.id));
      return {
        def,
        options: next,
        rows: 0,
        taskIds: [] as string[],
        added: true,
        label: edit.label,
      };
    }

    const from = options.find((o) => o === edit.from);
    if (!from) {
      refuse("unknown_option", "That option is not in this column", {
        column: def.name,
        options,
      });
    }
    let target: string;
    let next: string[];
    if (edit.action === "rename") {
      if (find(edit.to) && fold(edit.to) !== fold(from)) {
        refuse(
          "option_exists",
          "That option already exists; merge into it instead",
          {
            options,
          },
        );
      }
      target = edit.to;
      next = options.map((o) => (o === from ? target : o));
    } else {
      const into = options.find((o) => o === edit.into);
      if (!into || into === from) {
        refuse("unknown_option", "Merge into another option of this column", {
          column: def.name,
          options,
        });
      }
      target = into;
      next = options.filter((o) => o !== from);
    }

    // The rows carrying the option, locked in task id order (spec 7.3a).
    const stored = await tx
      .select({
        taskId: customFieldValueTable.taskId,
        value: customFieldValueTable.value,
      })
      .from(customFieldValueTable)
      .where(eq(customFieldValueTable.fieldId, def.id));
    const rewrites = new Map<string, string>();
    for (const row of stored) {
      if (!row.value) continue;
      if (def.type === "dropdown") {
        if (row.value === from) rewrites.set(row.taskId, target);
      } else {
        let picked: unknown;
        try {
          picked = JSON.parse(row.value);
        } catch {
          continue;
        }
        if (!Array.isArray(picked) || !picked.includes(from)) continue;
        const out: string[] = [];
        for (const label of picked as string[]) {
          const mapped = label === from ? target : label;
          if (!out.includes(mapped)) out.push(mapped);
        }
        rewrites.set(row.taskId, JSON.stringify(out));
      }
    }
    const taskIds = [...rewrites.keys()].sort();
    if (taskIds.length > 0) {
      await tx
        .select({ id: taskTable.id })
        .from(taskTable)
        .where(
          and(
            inArray(taskTable.id, taskIds),
            eq(taskTable.projectId, projectId),
          ),
        )
        .orderBy(asc(taskTable.id))
        .for("update");
    }
    for (const taskId of taskIds) {
      await writeTableRowInTx(tx, locked, ctx, {
        taskId,
        values: new Map([[def.id, rewrites.get(taskId) ?? null]]),
      });
    }
    await optionEditHooks.afterRows?.();
    await tx
      .update(customFieldDefinitionTable)
      .set({ options: next })
      .where(eq(customFieldDefinitionTable.id, def.id));
    return {
      def,
      options: next,
      rows: taskIds.length,
      taskIds,
      added: false,
      label: target,
    };
  });

  const event =
    edit.action === "add"
      ? "tables.option_added"
      : edit.action === "rename"
        ? "tables.option_renamed"
        : "tables.options_merged";
  if (edit.action !== "add" || result.added) {
    console.log(`[operon] ${event}`, {
      projectId,
      fieldId,
      rowsRewritten: result.rows,
      actorUserId,
    });
  }
  if (result.rows > 0) {
    await notifyTableRowsChanged(projectId, result.taskIds, actorUserId);
    kickTableOutbox();
  }
  return {
    fieldId,
    options: result.options,
    label: result.label,
    rowsRewritten: result.rows,
    ...(edit.action === "add" ? { added: result.added } : {}),
    ...(result.rows > 0 ? { writeId: ctx.writeId } : {}),
  };
}
