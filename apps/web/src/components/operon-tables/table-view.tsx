import { Plus, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OperonTable } from "@/fetchers/operon-tables/get-table";
import type {
  TableRow,
  TableRowsQuery,
} from "@/fetchers/operon-tables/get-table-rows";
import useGetTable from "@/hooks/queries/operon-tables/use-get-table";
import useTableRows, {
  TABLE_VIEW_ROW_CAP,
} from "@/hooks/queries/operon-tables/use-table-rows";
import { cn } from "@/lib/cn";
import ChipRows, { type ChipRow } from "./chip-rows";
import GroupSection, { ColumnHeader, type ShownColumn } from "./group-section";
import { monthBuckets, VISIBLE_MONTHS } from "./month-section";
import TableSearchResults from "./table-search";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.10 US2/US4):
 * the table view. Grouped by the group column (Topic in the template) in option order with
 * a final "No <group>" section, or sorted by the date column under month headers with the
 * undated rows on top. Sort and chips go to the rows route, which applies them before it
 * pages; at most 2,000 matching rows load. Search runs on the server (RF-11). English copy,
 * as the fork's other Operon surfaces; navy theme classes like the fork's list view.
 */
type Mode = "group" | "date";

function plural(n: number, word: string, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value.trim() === "" ? "" : debounced;
}

function byId(table: OperonTable, id: string | null) {
  return id ? (table.columns.find((c) => c.id === id) ?? null) : null;
}

export type TableViewProps = {
  projectId: string;
  workspaceId: string;
  isAdmin: boolean;
  onOpenRow: (rowId: string) => void;
  onAddEntry: () => void;
  onOpenColumns: () => void;
  /** The gallery toggle (task 11) renders here when the table has an image column. */
  galleryToggle?: React.ReactNode;
  /** When set, the gallery replaces the list body (task 11). */
  renderBody?: (rows: TableRow[]) => React.ReactNode;
};

export default function TableView(props: TableViewProps) {
  const { data: table, isLoading } = useGetTable(props.projectId);
  if (isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading table…</p>;
  }
  if (!table) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        This project is not a table.
      </p>
    );
  }
  return <TableViewBody {...props} table={table} />;
}

function TableViewBody({
  table,
  workspaceId,
  isAdmin,
  onOpenRow,
  onAddEntry,
  onOpenColumns,
  galleryToggle,
  renderBody,
}: TableViewProps & { table: OperonTable }) {
  const group = byId(table, table.groupFieldId);
  const dateColumn = byId(table, table.dateFieldId);
  const status = byId(table, table.statusFieldId);
  const [mode, setMode] = useState<Mode>(group ? "group" : "date");
  // A cleared group pointer disables "Group by"; a cleared date pointer "Sort by date".
  const effectiveMode: Mode =
    mode === "group" && !group
      ? "date"
      : mode === "date" && !dateColumn
        ? "group"
        : mode;
  const [chips, setChips] = useState<Record<string, string>>({});
  const [year, setYear] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showOlder, setShowOlder] = useState(false);
  const [searchText, setSearchText] = useState("");
  const query = useDebounced(searchText, 300);

  const dropdowns = table.columns.filter((c) => c.kind === "dropdown");
  // Chip rows: Status first, then the other choice columns; the group column only when
  // sorted by date (when grouped, its sections already split the list).
  const chipColumns = [
    ...(status ? [status] : []),
    ...dropdowns.filter(
      (c) =>
        c.id !== status?.id &&
        !(effectiveMode === "group" && c.id === group?.id),
    ),
  ];
  const activeFilters = Object.fromEntries(
    Object.entries(chips).filter(([id]) =>
      chipColumns.some((c) => c.id === id),
    ),
  );
  const rowsQuery: TableRowsQuery = {
    sort: effectiveMode === "date" ? "date" : "created",
    filters: activeFilters,
    year: dateColumn ? year : null,
  };
  const { rows, total, entries, isError } = useTableRows(
    table.projectId,
    rowsQuery,
  );
  const [allEntries, setAllEntries] = useState<number | null>(null);
  useEffect(() => {
    if (entries !== null) setAllEntries(entries);
  }, [entries]);

  const years = useMemo(() => {
    const seen = new Set<number>();
    if (year !== null) seen.add(year);
    if (dateColumn) {
      for (const row of rows) {
        const value = row.values[dateColumn.name];
        if (typeof value === "string" && /^\d{4}-/.test(value)) {
          seen.add(Number(value.slice(0, 4)));
        }
      }
    }
    return [...seen].sort((a, b) => b - a);
  }, [rows, dateColumn, year]);

  const chipRows: ChipRow[] = [
    ...chipColumns.map((c) => ({
      key: c.id,
      label: c.name,
      options: c.options ?? [],
      selected: activeFilters[c.id] ?? null,
    })),
    ...(dateColumn && years.length > 0
      ? [
          {
            key: "__year",
            label: "Year",
            options: years.map(String),
            selected: year === null ? null : String(year),
          },
        ]
      : []),
  ];

  // Columns: Title, the group column when sorted, Status, the date column, other choices.
  const shown: ShownColumn[] = [
    ...(effectiveMode === "date" && group ? [group] : []),
    ...(status ? [status] : []),
    ...(dateColumn ? [dateColumn] : []),
    ...dropdowns.filter((c) => c.id !== group?.id && c.id !== status?.id),
  ];

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groupWord = group?.name.toLowerCase() ?? "group";
  const header = [
    table.name,
    plural(allEntries ?? entries ?? 0, "entry", "entries"),
    ...(group ? [plural((group.options ?? []).length, groupWord)] : []),
  ].join(" · ");

  let body: React.ReactNode;
  if (query) {
    body = (
      <TableSearchResults
        workspaceId={workspaceId}
        tableId={table.projectId}
        query={query}
        columns={shown}
        onOpen={onOpenRow}
      />
    );
  } else if (isError) {
    body = (
      <p className="px-4 py-6 text-sm text-destructive">
        The entries could not be loaded.
      </p>
    );
  } else if (renderBody) {
    body = renderBody(rows);
  } else if (effectiveMode === "group") {
    body = (
      <GroupedList
        rows={rows}
        group={group}
        columns={shown}
        collapsed={collapsed}
        onToggle={toggle}
        onOpen={onOpenRow}
      />
    );
  } else {
    const { undated, months } = monthBuckets(rows, dateColumn?.name ?? "");
    const visible = showOlder ? months : months.slice(0, VISIBLE_MONTHS);
    const older = months
      .slice(VISIBLE_MONTHS)
      .reduce((n, bucket) => n + bucket.rows.length, 0);
    body = (
      <>
        {undated.length > 0 && (
          <GroupSection
            title="No date"
            rows={undated}
            columns={shown}
            collapsed={collapsed.has("__nodate")}
            onToggle={() => toggle("__nodate")}
            onOpen={onOpenRow}
          />
        )}
        {visible.map((bucket) => (
          <GroupSection
            key={bucket.key}
            title={bucket.title}
            rows={bucket.rows}
            columns={shown}
            collapsed={collapsed.has(bucket.key)}
            onToggle={() => toggle(bucket.key)}
            onOpen={onOpenRow}
          />
        ))}
        {!showOlder && older > 0 && (
          <button
            type="button"
            onClick={() => setShowOlder(true)}
            className="w-full px-4 py-2 text-left text-xs text-muted-foreground hover:bg-accent/60"
          >
            {older} more, older
          </button>
        )}
      </>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border bg-card px-4 py-3 text-card-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-base font-semibold" data-testid="table-header">
            {header}
          </h1>
          <div className="flex items-center gap-1.5">
            {galleryToggle}
            {isAdmin && (
              <Button
                variant="outline"
                size="xs"
                onClick={onOpenColumns}
                className="gap-1"
              >
                <Settings2 className="h-3 w-3" />
                Columns
              </Button>
            )}
            <Button size="xs" onClick={onAddEntry} className="gap-1">
              <Plus className="h-3 w-3" />
              Add entry
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder={`Search ${table.name.toLowerCase()}`}
            aria-label={`Search ${table.name.toLowerCase()}`}
            className="h-8 max-w-xs bg-card text-sm"
          />
          <div className="inline-flex rounded-md border border-border p-0.5">
            <button
              type="button"
              disabled={!group}
              aria-pressed={effectiveMode === "group"}
              onClick={() => setMode("group")}
              className={cn(
                "rounded px-2 py-0.5 text-xs",
                effectiveMode === "group"
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground",
                !group && "cursor-not-allowed opacity-50",
              )}
            >
              Group by {groupWord}
            </button>
            <button
              type="button"
              disabled={!dateColumn}
              aria-pressed={effectiveMode === "date"}
              onClick={() => setMode("date")}
              className={cn(
                "rounded px-2 py-0.5 text-xs",
                effectiveMode === "date"
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground",
                !dateColumn && "cursor-not-allowed opacity-50",
              )}
            >
              Sort by date
            </button>
          </div>
        </div>
        <ChipRows
          rows={chipRows}
          onSelect={(key, option) => {
            if (key === "__year") {
              setYear(option === null ? null : Number(option));
              return;
            }
            setChips((prev) => {
              const next = { ...prev };
              if (option === null) delete next[key];
              else next[key] = option;
              return next;
            });
          }}
        />
        {total !== null && total > TABLE_VIEW_ROW_CAP && !query && (
          <p className="text-xs text-muted-foreground">
            Showing the first 2,000 entries
          </p>
        )}
      </div>
      <div className="flex-1 overflow-auto bg-muted/20">
        {!query && !renderBody && <ColumnHeader columns={shown} />}
        {body}
      </div>
    </div>
  );
}

function GroupedList({
  rows,
  group,
  columns,
  collapsed,
  onToggle,
  onOpen,
}: {
  rows: TableRow[];
  group: ShownColumn | null;
  columns: ShownColumn[];
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onOpen: (rowId: string) => void;
}) {
  if (!group) {
    return (
      <GroupSection
        title="All entries"
        rows={rows}
        columns={columns}
        collapsed={collapsed.has("__all")}
        onToggle={() => onToggle("__all")}
        onOpen={onOpen}
      />
    );
  }
  const options = group.options ?? [];
  const byOption = new Map<string, TableRow[]>(options.map((o) => [o, []]));
  const none: TableRow[] = [];
  for (const row of rows) {
    const value = row.values[group.name];
    const bucket = typeof value === "string" ? byOption.get(value) : undefined;
    if (bucket) bucket.push(row);
    else none.push(row);
  }
  return (
    <>
      {options
        .filter((option) => (byOption.get(option) ?? []).length > 0)
        .map((option) => (
          <GroupSection
            key={option}
            title={option}
            rows={byOption.get(option) ?? []}
            columns={columns}
            collapsed={collapsed.has(`g:${option}`)}
            onToggle={() => onToggle(`g:${option}`)}
            onOpen={onOpen}
          />
        ))}
      {none.length > 0 && (
        <GroupSection
          title={`No ${group.name.toLowerCase()}`}
          rows={none}
          columns={columns}
          collapsed={collapsed.has("__none")}
          onToggle={() => onToggle("__none")}
          onOpen={onOpen}
        />
      )}
    </>
  );
}
