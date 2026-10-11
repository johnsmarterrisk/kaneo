import { useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow, isValid, parseISO } from "date-fns";
import { Plus, Table2 } from "lucide-react";
import { useState } from "react";
import type {
  RecentRow,
  TableSummary,
} from "@/fetchers/operon-tables/get-tables-summary";
import useTablesSummary from "@/hooks/queries/operon-tables/use-tables-summary";
import { formatDateMedium } from "@/lib/format";
import CreateTableModal from "./create-table-modal";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.10 US1): the
 * "Tables" section of the workspace project list — one card per table, a "New table" card
 * for admins, and the "Recently added" footer. Data: the summary route, which already
 * omits hidden columns and other workspaces. `id="tables"` is the phone tab bar's anchor.
 */
function relative(at: string) {
  const date = parseISO(at);
  return isValid(date) ? formatDistanceToNow(date, { addSuffix: true }) : "";
}

export function groupLine(table: TableSummary): string | null {
  if (!table.group) return null;
  if (table.group.isTemplateTopic) {
    const k = table.group.options;
    return `${k} ${k === 1 ? "topic" : "topics"}`;
  }
  const used = table.group.counts.filter((c) => c.count > 0);
  return used.length > 0
    ? used.map((c) => `${c.option}: ${c.count}`).join(" · ")
    : null;
}

export function statusLine(table: TableSummary): string | null {
  const used = table.status.filter((s) => s.count > 0);
  // Newest-stage first, as the mock-up reads ("38 published · 3 in progress · 1 idea").
  return used.length > 0
    ? [...used]
        .reverse()
        .map((s) => `${s.count} ${s.option.toLowerCase()}`)
        .join(" · ")
    : null;
}

function TableCard({
  table,
  onOpen,
}: {
  table: TableSummary;
  onOpen: () => void;
}) {
  const group = groupLine(table);
  const status = statusLine(table);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="table-card"
      className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4 text-left text-card-foreground transition-colors hover:bg-accent/60"
    >
      <span className="flex items-center gap-2 font-medium">
        <Table2 className="h-4 w-4 text-muted-foreground" />
        {table.name}
      </span>
      <span className="text-sm text-muted-foreground">
        {table.entries} {table.entries === 1 ? "entry" : "entries"}
        {group ? ` · ${group}` : ""}
      </span>
      {status && (
        <span className="text-xs text-muted-foreground">{status}</span>
      )}
      {table.lastAdded && (
        <span className="text-xs text-muted-foreground">
          Last added {relative(table.lastAdded.at)}
          {table.lastAdded.by ? ` by ${table.lastAdded.by}` : ""}
        </span>
      )}
    </button>
  );
}

function RecentlyAdded({
  rows,
  onOpen,
}: {
  rows: RecentRow[];
  onOpen: (row: RecentRow) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium text-card-foreground">
        Recently added
      </h3>
      <ul className="divide-y divide-border/50 rounded-lg border border-border bg-card">
        {rows.map((row) => (
          <li key={row.rowId}>
            <button
              type="button"
              onClick={() => onOpen(row)}
              className="flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm hover:bg-accent/60"
            >
              <span className="w-32 shrink-0 truncate text-xs text-muted-foreground">
                {row.tableName}
              </span>
              <span className="min-w-0 flex-1 truncate text-card-foreground">
                {row.title}
              </span>
              <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground md:inline">
                {row.madeBy ?? ""}
              </span>
              <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                {formatDateMedium(row.createdAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function TablesSection({
  workspaceId,
  isAdmin,
}: {
  workspaceId: string;
  isAdmin: boolean;
}) {
  const navigate = useNavigate();
  const { data } = useTablesSummary(workspaceId);
  const [creating, setCreating] = useState(false);
  const tables = data?.tables ?? [];
  if (tables.length === 0 && !isAdmin) return null;

  const openTable = (tableId: string, taskId?: string) =>
    navigate({
      to: "/dashboard/workspace/$workspaceId/project/$projectId/table",
      params: { workspaceId, projectId: tableId },
      search: taskId ? { taskId } : {},
    });

  return (
    <section id="tables" className="flex flex-col gap-3 px-4 py-4">
      <h2 className="text-md font-medium text-card-foreground">Tables</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tables.map((table) => (
          <TableCard
            key={table.tableId}
            table={table}
            onOpen={() => openTable(table.tableId)}
          />
        ))}
        {isAdmin && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex flex-col gap-1 rounded-lg border border-dashed border-border bg-card p-4 text-left text-card-foreground transition-colors hover:bg-accent/60"
          >
            <span className="flex items-center gap-2 font-medium">
              <Plus className="h-4 w-4 text-muted-foreground" />
              New table
            </span>
            <span className="text-sm text-muted-foreground">
              Starts from the Marketing asset columns
            </span>
          </button>
        )}
      </div>
      {data?.recent && data.recent.length > 0 && (
        <RecentlyAdded
          rows={data.recent}
          onOpen={(row) => openTable(row.tableId, row.rowId)}
        />
      )}
      <CreateTableModal open={creating} onClose={() => setCreating(false)} />
    </section>
  );
}
