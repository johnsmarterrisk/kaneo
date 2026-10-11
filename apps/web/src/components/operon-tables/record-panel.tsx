import { format, isValid, parseISO } from "date-fns";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import TaskDescriptionEditor from "@/components/task/task-description-editor";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OperonTable } from "@/fetchers/operon-tables/get-table";
import type { TableRow } from "@/fetchers/operon-tables/get-table-rows";
import {
  useDeleteTableRow,
  useSaveTableRow,
} from "@/hooks/mutations/operon-tables/use-table-row-writes";
import useTableRow from "@/hooks/queries/operon-tables/use-table-row";
import { toast } from "@/lib/toast";
import { StashImageField } from "./stash-picker";

/**
 * Operon fork addition (Tables task 9, docs/fork-discipline.md row 18, spec 7.10 US3/US9):
 * a table entry's record panel, rendered by the task details sheet for a table row instead
 * of the board fields. Title, the active columns in position order, Notes; Made by (read
 * only, system-set), the Last change line and the ledger note. One Save writes everything
 * through the table's atomic row route (task 5); nothing autosaves field by field, because
 * each save is one Proof-of-Work signal. No comments, relations or subtasks (R-E).
 * English copy as the fork's other Operon surfaces; navy theme classes (card ink on
 * bg-card), like the fork's own screens.
 */
export const NEW_TOPIC = "__new_topic__";

type Column = OperonTable["columns"][number];
type Draft = {
  title: string;
  notes: string;
  values: Record<string, unknown>;
  newTopic: string;
};

const FIELD_CLASS =
  "h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-card-foreground";

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function draftFrom(table: OperonTable, row: TableRow | null): Draft {
  const values: Record<string, unknown> = {};
  for (const column of table.columns) {
    values[column.name] = row?.values[column.name] ?? null;
  }
  return {
    title: row?.title ?? "",
    notes: row?.notes ?? "",
    values,
    newTopic: "",
  };
}

export function madeByLine(row: TableRow): string | null {
  if (!row.madeBy.name) return null;
  const at = row.createdAt ? parseISO(row.createdAt) : null;
  return at && isValid(at)
    ? `Made by ${row.madeBy.name} · ${format(at, "d MMM yyyy, HH:mm")}`
    : `Made by ${row.madeBy.name}`;
}

export function lastChangeLine(row: TableRow): string | null {
  const { by, summary } = row.lastChange;
  if (!summary) return null;
  return `Last change ${by.name ?? "someone"} ${summary}`;
}

/** The typed values the row route takes: empty text and empty choices clear (null). */
function valuesToSend(table: OperonTable, draft: Draft) {
  const out: Record<string, unknown> = {};
  for (const column of table.columns) {
    const value = draft.values[column.name];
    if (value === undefined || value === "") {
      out[column.name] = null;
    } else if (column.kind === "number" && typeof value === "string") {
      out[column.name] = value.trim() === "" ? null : Number(value);
    } else if (Array.isArray(value) && value.length === 0) {
      out[column.name] = null;
    } else {
      out[column.name] = value;
    }
  }
  return out;
}

function FieldEditor({
  column,
  value,
  onChange,
  topicColumn,
  canAddTopic,
  newTopic,
  onNewTopic,
}: {
  column: Column;
  value: unknown;
  onChange: (value: unknown) => void;
  topicColumn: boolean;
  canAddTopic: boolean;
  newTopic: string;
  onNewTopic: (label: string) => void;
}) {
  const id = `table-field-${column.id}`;
  const options = column.options ?? [];
  let control: React.ReactNode;
  switch (column.kind) {
    case "dropdown": {
      const choosingNew = topicColumn && value === NEW_TOPIC;
      control = (
        <div className="flex flex-col gap-1.5">
          <select
            id={id}
            className={FIELD_CLASS}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">—</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            {topicColumn && canAddTopic && (
              <option value={NEW_TOPIC}>New topic…</option>
            )}
          </select>
          {choosingNew && (
            <Input
              aria-label={`New ${column.name.toLowerCase()} name`}
              placeholder={`New ${column.name.toLowerCase()} name`}
              value={newTopic}
              onChange={(e) => onNewTopic(e.target.value)}
              className="h-9 bg-card text-sm"
              autoFocus
            />
          )}
        </div>
      );
      break;
    }
    case "multiselect": {
      const picked = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div id={id} className="flex flex-wrap gap-3">
          {options.map((option) => (
            <label
              key={option}
              className="flex items-center gap-1.5 text-sm text-card-foreground"
            >
              <input
                type="checkbox"
                checked={picked.includes(option)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...picked, option]
                      : picked.filter((p) => p !== option),
                  )
                }
              />
              {option}
            </label>
          ))}
        </div>
      );
      break;
    }
    case "date":
      control = (
        <input
          id={id}
          type="date"
          className={FIELD_CLASS}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
      break;
    case "number":
      control = (
        <input
          id={id}
          type="number"
          className={FIELD_CLASS}
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case "boolean":
      control = (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
      break;
    case "image":
      control = (
        <StashImageField
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
        />
      );
      break;
    case "link":
      control = (
        <input
          id={id}
          type="url"
          placeholder="https://"
          className={FIELD_CLASS}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
      break;
    default:
      control = (
        <input
          id={id}
          type="text"
          className={FIELD_CLASS}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {column.name}
        {column.required && <span className="text-destructive"> *</span>}
      </label>
      {control}
    </div>
  );
}

export type RecordPanelProps = {
  table: OperonTable;
  /** A row id, or "new" for an empty entry ("Add entry"). */
  rowId: string;
  /** Workspace owner/admin: offered "New topic…" (the server re-checks, R-D). */
  canAddTopic: boolean;
  onClose: () => void;
};

export default function RecordPanel(props: RecordPanelProps) {
  const isNew = props.rowId === "new";
  const read = useTableRow(isNew ? undefined : props.rowId);
  if (!isNew && read.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading entry…</p>;
  }
  if (!isNew && (read.isError || !read.data)) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        This entry could not be read.
      </p>
    );
  }
  return (
    <RecordForm
      key={props.rowId}
      {...props}
      row={isNew ? null : (read.data?.row ?? null)}
    />
  );
}

function RecordForm({
  table,
  row: initialRow,
  canAddTopic,
  onClose,
}: RecordPanelProps & { row: TableRow | null }) {
  const [row, setRow] = useState<TableRow | null>(initialRow);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(table, initialRow));
  // One request id per opened empty entry, so a retried save never adds a second row.
  const [requestId] = useState(newRequestId);
  const save = useSaveTableRow(table.projectId);
  const remove = useDeleteTableRow(table.projectId);
  const group = table.columns.find((c) => c.id === table.groupFieldId) ?? null;

  useEffect(() => {
    setRow(initialRow);
  }, [initialRow]);

  const setValue = (name: string, value: unknown) =>
    setDraft((d) => ({ ...d, values: { ...d.values, [name]: value } }));

  const handleSave = async () => {
    const values = valuesToSend(table, draft);
    let newTopic: { fieldId: string; label: string } | undefined;
    if (group && draft.values[group.name] === NEW_TOPIC) {
      const label = draft.newTopic.trim();
      if (!label) {
        toast.error(`Name the new ${group.name.toLowerCase()}`);
        return;
      }
      values[group.name] = label;
      newTopic = { fieldId: group.id, label };
    }
    try {
      const saved = await save.mutateAsync({
        taskId: row?.rowId ?? null,
        requestId,
        write: { title: draft.title, notes: draft.notes, values, newTopic },
      });
      toast.success("Saved");
      if (!row) {
        onClose();
        return;
      }
      setRow(saved);
      setDraft(draftFrom(table, saved));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Not saved");
    }
  };

  const handleDelete = async () => {
    if (!row) return;
    try {
      await remove.mutateAsync(row.rowId);
      toast.success("Entry deleted");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Not deleted");
    }
  };

  const madeBy = row ? madeByLine(row) : null;
  const lastChange = row ? lastChangeLine(row) : null;

  return (
    <div className="flex h-full flex-col bg-card text-card-foreground">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">{table.name}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">Edit entry</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close"
          onClick={onClose}
          className="text-card-foreground"
        >
          <X className="size-4" />
        </Button>
      </div>
      <form
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <div className="flex flex-col gap-1">
          <label
            htmlFor="table-field-title"
            className="text-xs font-medium text-muted-foreground"
          >
            Title
          </label>
          <Input
            id="table-field-title"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            className="h-9 bg-card text-sm"
          />
        </div>
        {table.columns.map((column) => (
          <FieldEditor
            key={column.id}
            column={column}
            value={draft.values[column.name]}
            onChange={(value) => setValue(column.name, value)}
            topicColumn={column.id === group?.id}
            canAddTopic={canAddTopic}
            newTopic={draft.newTopic}
            onNewTopic={(label) => setDraft((d) => ({ ...d, newTopic: label }))}
          />
        ))}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Notes
          </span>
          <TaskDescriptionEditor
            value={draft.notes}
            onChange={(notes) => setDraft((d) => ({ ...d, notes }))}
            placeholder="Notes"
            taskId={row?.rowId}
          />
        </div>
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {madeBy && <span data-testid="made-by">{madeBy}</span>}
          {lastChange && <span data-testid="last-change">{lastChange}</span>}
          <span>Ledger: every change is a Proof-of-Work signal</span>
        </div>
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-card pt-3">
          <Button type="submit" size="sm" disabled={save.isPending}>
            Save
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {row && (
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
                  />
                }
              >
                Delete
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    render={<Button variant="outline" size="sm" />}
                  >
                    Cancel
                  </AlertDialogClose>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => void handleDelete()}
                  >
                    Delete entry
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </form>
    </div>
  );
}
