import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import useCreateCustomField from "@/hooks/mutations/custom-field/use-create-custom-field";
import useDeleteCustomField from "@/hooks/mutations/custom-field/use-delete-custom-field";
import { useReorderCustomFields } from "@/hooks/mutations/custom-field/use-reorder-custom-field";
import useEditOptions from "@/hooks/mutations/operon-tables/use-edit-options";
import useUpdateTableSettings from "@/hooks/mutations/operon-tables/use-update-table-settings";
import useGetCustomFieldValuesByProject from "@/hooks/queries/custom-field/use-get-custom-field-values-by-project";
import useGetColumnHistory from "@/hooks/queries/operon-tables/use-get-column-history";
import useGetTable from "@/hooks/queries/operon-tables/use-get-table";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { toast } from "@/lib/toast";

/**
 * Operon fork addition (Tables task 10, docs/fork-discipline.md row 18, spec 7.10 US6): a
 * table's Columns page. Admins add, reorder and hide columns, choose the group/date/status
 * columns, and rename or merge topics; hidden columns keep their history, readable here.
 * The server is the check of record for every action (table admin, RF-9); a member sees
 * "Admins only." and the columns without controls. English copy, as the fork's other
 * Operon surfaces. Styled for the settings frame's white bg-card panel (navy theme:
 * card-foreground ink, never upstream's text-foreground on white).
 */
export const KIND_LABELS: Record<string, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  dropdown: "Choice",
  boolean: "Checkbox",
  multiselect: "Multiple choice",
  image: "Image from Stash",
  link: "Link",
};

const SELECT_CLASS =
  "h-8 rounded-md border border-border bg-card px-2 text-sm text-card-foreground";

/** Options sharing a case-insensitive prefix of three or more characters (spec 7.10). */
export function looksLike(option: string, options: string[]): string | null {
  const prefix = option.trim().toLowerCase().slice(0, 3);
  if (prefix.length < 3) return null;
  return (
    options.find(
      (other) =>
        other !== option && other.trim().toLowerCase().startsWith(prefix),
    ) ?? null
  );
}

function errorText(error: unknown) {
  if (!(error instanceof Error)) return "That did not work";
  try {
    const parsed = JSON.parse(error.message) as { message?: string };
    return parsed.message ?? error.message;
  } catch {
    return error.message;
  }
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-md font-medium text-card-foreground">{title}</h2>
      {children}
    </section>
  );
}

function HistoryPanel({
  projectId,
  fieldId,
}: {
  projectId: string;
  fieldId: string;
}) {
  const {
    data,
    isLoading,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useGetColumnHistory(projectId, fieldId);
  if (isLoading)
    return <p className="text-xs text-muted-foreground">Loading history…</p>;
  if (error || !data)
    return (
      <p className="text-xs text-destructive">The history could not be read.</p>
    );
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-xs text-card-foreground">
      <p className="font-medium">Current values</p>
      {data.current.length === 0 ? (
        <p className="text-muted-foreground">No entry holds a value.</p>
      ) : (
        <ul className="space-y-1">
          {data.current.map((row) => (
            <li key={row.rowId}>
              {row.title}: {row.value}
            </li>
          ))}
        </ul>
      )}
      <p className="font-medium">Changes</p>
      <ul className="space-y-1">
        {data.history.map((change) => (
          <li key={`${change.rowId}-${change.at}-${change.newValue}`}>
            {new Date(change.at).toLocaleString()}: {change.oldValue ?? "—"} →{" "}
            {change.newValue ?? "—"}
          </li>
        ))}
      </ul>
      {hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage?.()}
        >
          {isFetchingNextPage ? "Loading…" : "Load older changes"}
        </Button>
      )}
    </div>
  );
}

function TopicRow({
  projectId,
  fieldId,
  option,
  count,
  options,
}: {
  projectId: string;
  fieldId: string;
  option: string;
  count: number;
  options: string[];
}) {
  const editOptions = useEditOptions(projectId);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(option);
  const hint = looksLike(option, options);
  const others = options.filter((o) => o !== option);

  async function run(edit: Parameters<typeof editOptions.mutateAsync>[0]) {
    try {
      const result = await editOptions.mutateAsync(edit);
      toast.success(
        result.rowsRewritten === 1
          ? "1 entry updated"
          : `${result.rowsRewritten} entries updated`,
      );
      setRenaming(false);
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 py-1 text-sm text-card-foreground">
      {renaming ? (
        <>
          <Input
            aria-label={`New name for ${option}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-8 w-48"
          />
          <Button
            size="xs"
            onClick={() =>
              run({
                projectId,
                fieldId,
                edit: { action: "rename", from: option, to: name.trim() },
              })
            }
            disabled={!name.trim() || name.trim() === option}
          >
            Save
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          {/* Spec §10 journey 5's exact text, "Cybersecurity 1 · looks like Cyber" (walk F2):
              the spaces and the "·" are in the text, not only in the flex gap. */}
          <span>
            <span className="font-medium">{option}</span>
            <span className="text-muted-foreground">{` ${count}`}</span>
            {hint ? (
              <span className="text-xs text-muted-foreground">
                {` · looks like ${hint}`}
              </span>
            ) : null}
          </span>
          <Button size="xs" variant="ghost" onClick={() => setRenaming(true)}>
            Rename
          </Button>
          {others.length > 0 ? (
            <select
              aria-label={`Merge ${option} into`}
              className={SELECT_CLASS}
              value=""
              onChange={(event) => {
                if (!event.target.value) return;
                void run({
                  projectId,
                  fieldId,
                  edit: {
                    action: "merge",
                    from: option,
                    into: event.target.value,
                  },
                });
              }}
            >
              <option value="">Merge into…</option>
              {others.map((other) => (
                <option key={other} value={other}>
                  {other}
                </option>
              ))}
            </select>
          ) : null}
        </>
      )}
    </li>
  );
}

function ColumnsPage({ projectId }: { projectId: string }) {
  const { isAdmin } = useWorkspacePermission();
  const { data: table, isLoading } = useGetTable(projectId);
  const { data: values } = useGetCustomFieldValuesByProject(projectId);
  // Walk finding F1: the app's queries default to `refetchOnMount: false`, and a row save
  // never touches #1542's `custom-field-values` cache, so the topic counts kept the numbers
  // of an earlier visit. Re-read them every time the page opens.
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.invalidateQueries({
      queryKey: ["custom-field-values", projectId],
    });
  }, [queryClient, projectId]);
  const createField = useCreateCustomField();
  const hideField = useDeleteCustomField(projectId);
  const reorder = useReorderCustomFields();
  const updateSettings = useUpdateTableSettings(projectId);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("text");
  const [newOptions, setNewOptions] = useState("");
  const [historyOf, setHistoryOf] = useState<string | null>(null);

  const columns = table?.columns ?? [];
  const groupColumn = columns.find((c) => c.id === table?.groupFieldId);
  const topicCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const value of values ?? []) {
      if (value.fieldId !== groupColumn?.id || !value.value) continue;
      counts.set(value.value, (counts.get(value.value) ?? 0) + 1);
    }
    return counts;
  }, [values, groupColumn?.id]);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading columns…</p>;
  }
  if (!table) {
    return (
      <p className="text-sm text-muted-foreground">
        This project is not a table.
      </p>
    );
  }

  async function addColumn() {
    const options = newOptions
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    try {
      await createField.mutateAsync({
        projectId,
        name: newName.trim(),
        type: newKind as never,
        required: false,
        ...(newKind === "dropdown" || newKind === "multiselect"
          ? { options }
          : {}),
      });
      setNewName("");
      setNewOptions("");
      toast.success("Column added");
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const next = [...columns];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(index + direction, 0, moved);
    try {
      await reorder.mutateAsync({
        projectId,
        fields: next.map((c, i) => ({ id: c.id, position: i + 1 })),
      });
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  async function hide(id: string) {
    try {
      await hideField.mutateAsync({ id });
      toast.success("Column hidden; its values and history are kept");
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  async function setSetting(
    key: "groupFieldId" | "dateFieldId" | "statusFieldId",
    value: string,
  ) {
    try {
      await updateSettings.mutateAsync({
        projectId,
        settings: { [key]: value || null },
      });
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  const choiceColumns = columns.filter((c) => c.kind === "dropdown");
  const dateColumns = columns.filter((c) => c.kind === "date");
  const topics = (groupColumn?.options as string[] | null) ?? [];

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-card-foreground">
          {table.name} · Columns
        </h1>
        <p className="text-muted-foreground">
          Started from the Marketing asset columns
        </p>
        {!isAdmin ? (
          <p className="text-sm font-medium text-card-foreground">
            Admins only.
          </p>
        ) : null}
      </div>

      <Section title="Columns">
        <ul className="divide-y divide-border rounded-md border border-border">
          <li className="flex items-center gap-3 px-3 py-2 text-sm text-card-foreground">
            <span className="font-medium">Title</span>
            <span className="text-muted-foreground">Template</span>
          </li>
          {columns.map((column, index) => (
            <li
              key={column.id}
              className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm text-card-foreground"
            >
              <span className="font-medium">{column.name}</span>
              <span className="text-muted-foreground">
                {KIND_LABELS[column.kind] ?? column.kind}
              </span>
              {Array.isArray(column.options) && column.options.length > 0 ? (
                <span className="truncate text-xs text-muted-foreground">
                  {(column.options as string[]).join(", ")}
                </span>
              ) : null}
              {isAdmin ? (
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Move ${column.name} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Move ${column.name} down`}
                    disabled={index === columns.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Hide ${column.name}`}
                    onClick={() => hide(column.id)}
                  >
                    Hide
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
          <li className="flex items-center gap-3 px-3 py-2 text-sm text-card-foreground">
            <span className="font-medium">Notes</span>
            <span className="text-muted-foreground">Template</span>
          </li>
          <li className="flex items-center gap-3 px-3 py-2 text-sm text-card-foreground">
            <span className="font-medium">Made by</span>
            <span className="text-muted-foreground">
              set automatically · Always
            </span>
          </li>
        </ul>

        {isAdmin ? (
          <div className="flex flex-wrap items-end gap-2">
            <Input
              aria-label="New column name"
              placeholder="New column name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              className="h-8 w-48"
            />
            <select
              aria-label="New column kind"
              className={SELECT_CLASS}
              value={newKind}
              onChange={(event) => setNewKind(event.target.value)}
            >
              {Object.entries(KIND_LABELS).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
            {newKind === "dropdown" || newKind === "multiselect" ? (
              <Input
                aria-label="Options"
                placeholder="Options, comma separated"
                value={newOptions}
                onChange={(event) => setNewOptions(event.target.value)}
                className="h-8 w-56"
              />
            ) : null}
            <Button size="sm" onClick={addColumn} disabled={!newName.trim()}>
              Add
            </Button>
          </div>
        ) : null}
      </Section>

      {isAdmin ? (
        <Section title="How the table is read">
          <div className="flex flex-wrap gap-4 text-sm text-card-foreground">
            {(
              [
                ["groupFieldId", "Group by", choiceColumns],
                ["dateFieldId", "Date column", dateColumns],
                ["statusFieldId", "Status column", choiceColumns],
              ] as const
            ).map(([key, label, candidates]) => (
              <label key={key} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{label}</span>
                <select
                  aria-label={label}
                  className={SELECT_CLASS}
                  value={table[key] ?? ""}
                  onChange={(event) => setSetting(key, event.target.value)}
                >
                  <option value="">None</option>
                  {candidates.map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </Section>
      ) : null}

      {groupColumn ? (
        <Section title={"Topics in this table"}>
          {topics.length === 0 ? (
            <p className="text-sm text-muted-foreground">No topics yet.</p>
          ) : (
            <ul>
              {topics.map((option) =>
                isAdmin ? (
                  <TopicRow
                    key={option}
                    projectId={projectId}
                    fieldId={groupColumn.id}
                    option={option}
                    count={topicCounts.get(option) ?? 0}
                    options={topics}
                  />
                ) : (
                  <li
                    key={option}
                    className="flex gap-2 py-1 text-sm text-card-foreground"
                  >
                    <span className="font-medium">{option}</span>
                    <span className="text-muted-foreground">
                      {topicCounts.get(option) ?? 0}
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
        </Section>
      ) : null}

      {isAdmin ? (
        <Section title="Hidden columns">
          {(table.hiddenColumns ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No hidden columns.</p>
          ) : (
            <ul className="space-y-2">
              {(table.hiddenColumns ?? []).map((column) => (
                <li key={column.id} className="space-y-2">
                  <div className="flex items-center gap-3 text-sm text-card-foreground">
                    <span className="font-medium">{column.name}</span>
                    <span className="text-muted-foreground">
                      {KIND_LABELS[column.kind] ?? column.kind}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        setHistoryOf(historyOf === column.id ? null : column.id)
                      }
                    >
                      View history
                    </Button>
                  </div>
                  {historyOf === column.id ? (
                    <HistoryPanel projectId={projectId} fieldId={column.id} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
    </div>
  );
}

export default ColumnsPage;
