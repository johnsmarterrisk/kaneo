import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow, isValid, parseISO } from "date-fns";
import { Plus, Search, Table2 } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { getTable, type OperonTable } from "@/fetchers/operon-tables/get-table";
import type {
  RecentRow,
  TableSummary,
} from "@/fetchers/operon-tables/get-tables-summary";
import type { SearchRow } from "@/fetchers/operon-tables/search-table-rows";
import useSearchTableRows from "@/hooks/queries/operon-tables/use-search-table-rows";
import useTablesSummary from "@/hooks/queries/operon-tables/use-tables-summary";
import { formatDateMedium } from "@/lib/format";
import CreateTableModal from "./create-table-modal";
import { formatDay } from "./group-section";
import { useDebounced } from "./table-view";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.10 US1; moved
 * to its own page by John's ruling 2026-10-11, spec section 15): the body of the Tables page
 * (`$workspaceId/tables.tsx`) — a search box across every table, one card per table, a "New
 * table" card for admins, and the "Recently added" footer. Data: the summary route, which
 * already omits hidden columns and other workspaces, and the search route.
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

/**
 * One search result: table name, title, status, date. Status and date are the row's values
 * in that table's own status and date columns (each table names its own), read from the
 * table's columns query; a table without a date column shows the row's creation date.
 */
function SearchResultLine({
  row,
  table,
  onOpen,
}: {
  row: SearchRow;
  table: OperonTable | null | undefined;
  onOpen: () => void;
}) {
  const columnName = (fieldId: string | null | undefined) =>
    table?.columns.find((column) => column.id === fieldId)?.name;
  const statusName = columnName(table?.statusFieldId);
  const dateName = columnName(table?.dateFieldId);
  const status = statusName ? row.values[statusName] : undefined;
  const dated = dateName ? formatDay(row.values[dateName]) : "";
  const date = dated || (row.createdAt ? formatDateMedium(row.createdAt) : "");
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-testid="tables-search-row"
        className="flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm hover:bg-accent/60"
      >
        <span className="w-32 shrink-0 truncate text-xs text-muted-foreground">
          {row.tableName}
        </span>
        <span className="min-w-0 flex-1 truncate text-card-foreground">
          {row.title}
        </span>
        <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
          {typeof status === "string" ? status : ""}
        </span>
        <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
          {date}
        </span>
      </button>
    </li>
  );
}

function SearchResults({
  workspaceId,
  query,
  onOpen,
}: {
  workspaceId: string;
  query: string;
  onOpen: (row: SearchRow) => void;
}) {
  const search = useSearchTableRows({ workspaceId, q: query });
  const rows = search.data?.pages.flatMap((page) => page.rows) ?? [];
  const tableIds = [...new Set(rows.map((row) => row.tableId))];
  // Same query key as `useGetTable`, so a table already opened is not fetched again.
  const tables = useQueries({
    queries: tableIds.map((tableId) => ({
      queryKey: ["operon-table", tableId],
      queryFn: () => getTable(tableId),
    })),
  });
  const tableById = new Map(
    tableIds.map((tableId, index) => [tableId, tables[index]?.data]),
  );
  if (search.isError) {
    return (
      <p className="px-4 py-6 text-sm text-destructive">
        The search did not run. Try again.
      </p>
    );
  }
  if (search.isLoading) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">Searching…</p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No entries match “{query.trim()}”.
      </p>
    );
  }
  return (
    <div data-testid="tables-search-results">
      <ul className="divide-y divide-border/50 rounded-lg border border-border bg-card">
        {rows.map((row) => (
          <SearchResultLine
            key={row.rowId}
            row={row}
            table={tableById.get(row.tableId)}
            onOpen={() => onOpen(row)}
          />
        ))}
      </ul>
      {search.hasNextPage && (
        <button
          type="button"
          onClick={() => void search.fetchNextPage()}
          className="w-full px-4 py-2 text-left text-xs text-muted-foreground hover:bg-accent/60"
        >
          More results
        </button>
      )}
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
  const { data, isLoading, isError, refetch } = useTablesSummary(workspaceId);
  const [creating, setCreating] = useState(false);
  const [input, setInput] = useState("");
  // Debounced as the table view's own search box is; clearing restores the cards at once.
  const query = useDebounced(input, 300);
  const tables = data?.tables ?? [];

  const openTable = (tableId: string, taskId?: string) =>
    navigate({
      to: "/dashboard/workspace/$workspaceId/project/$projectId/table",
      params: { workspaceId, projectId: tableId },
      search: taskId ? { taskId } : {},
    });

  return (
    <section className="flex flex-col gap-3 px-4 py-4">
      <div className="relative max-w-md">
        <Input
          type="search"
          aria-label="Search all tables"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search all tables"
          className="h-8 pl-8 text-sm"
        />
        {/* After the input, so the field's own background does not paint over it. */}
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      </div>
      {query.trim() ? (
        <SearchResults
          workspaceId={workspaceId}
          query={query}
          onOpen={(row) => openTable(row.tableId, row.rowId)}
        />
      ) : isError ? (
        // Codex round 1, finding 3: a failed or forbidden read is not an empty workspace —
        // never "No tables yet", and no "New table" offered over a list that did not load.
        <div className="flex items-center gap-3 py-6 text-sm">
          <span className="text-destructive">Tables could not be loaded.</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/60"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {!isLoading && tables.length === 0 && !isAdmin && (
            <p className="py-6 text-sm text-muted-foreground">No tables yet</p>
          )}
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
        </>
      )}
      <CreateTableModal open={creating} onClose={() => setCreating(false)} />
    </section>
  );
}
