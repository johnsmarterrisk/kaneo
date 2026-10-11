import { format, isValid, parseISO } from "date-fns";
import { ChevronRight } from "lucide-react";
import type { OperonTable } from "@/fetchers/operon-tables/get-table";
import type { TableRow } from "@/fetchers/operon-tables/get-table-rows";
import { cn } from "@/lib/cn";
import {
  MADE_BY_KEY,
  ResizeHandle,
  TITLE_KEY,
  useColumnWidthsContext,
} from "./column-widths";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.10): one
 * collapsible section of the table view (a group option, "No <group>", a month, "No date")
 * and the row line inside it, styled like the fork's list view (navy theme: card ink on
 * bg-card, muted section bars).
 */
export type ShownColumn = OperonTable["columns"][number];

export function formatDay(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = parseISO(value);
  return isValid(date) ? format(date, "d MMM yyyy") : value;
}

export function cellText(column: ShownColumn, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (column.kind === "date") return formatDay(value);
  if (column.kind === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Task 15 (spec 7.11, US8): the phone row's second line — the shown columns' values (a date
 * as "6 Oct") then Made by, e.g. "Published · 6 Oct · LinkedIn · Rella agent".
 */
export function phoneDetailLine(row: TableRow, columns: ShownColumn[]): string {
  const parts = columns.map((column) => {
    const value = row.values[column.name];
    if (column.kind === "date" && typeof value === "string" && value) {
      const date = parseISO(value);
      return isValid(date) ? format(date, "d MMM") : value;
    }
    return cellText(column, value);
  });
  return [...parts, row.madeBy.name ?? ""].filter(Boolean).join(" · ");
}

export function RowLine({
  row,
  columns,
  onOpen,
  phone = false,
  alt = false,
}: {
  row: TableRow;
  columns: ShownColumn[];
  onOpen: (rowId: string) => void;
  phone?: boolean;
  /** Row striping as Operon's lists do it (John, 2026-10-11): `bg-row-alt` is the shared
      `--row-alt` (#eef4fb light / #1e4270 dark, Operon's own values) on alternating rows,
      starting with the first; group headers are never striped. */
  alt?: boolean;
}) {
  const { width } = useColumnWidthsContext();
  if (phone) {
    return (
      <button
        type="button"
        data-testid="table-row"
        onClick={() => onOpen(row.rowId)}
        className={cn(
          "flex min-h-[44px] w-full min-w-0 flex-col items-start gap-0.5 border-b border-border/50 px-4 py-2 text-left",
          alt && "bg-row-alt",
        )}
      >
        <span className="w-full truncate text-sm text-card-foreground">
          {row.title}
        </span>
        <span className="w-full truncate text-xs text-muted-foreground">
          {phoneDetailLine(row, columns)}
        </span>
      </button>
    );
  }
  // Desktop widths come from the table view's resizable columns (spec §16); every cell
  // carries `data-col` so a handle's double-click can measure the widest one.
  return (
    <button
      type="button"
      data-testid="table-row"
      onClick={() => onOpen(row.rowId)}
      className={cn(
        "flex w-full items-center gap-3 border-b border-border/50 px-4 py-1.5 text-left transition-colors hover:bg-accent/60",
        alt && "bg-row-alt",
      )}
    >
      <span
        data-col={TITLE_KEY}
        style={{ width: width(TITLE_KEY) }}
        className="shrink-0 truncate text-sm text-card-foreground"
      >
        {row.title}
      </span>
      {columns.map((column) => (
        <span
          key={column.id}
          data-col={column.id}
          style={{ width: width(column.id) }}
          className="hidden shrink-0 truncate text-xs text-muted-foreground md:inline"
        >
          {cellText(column, row.values[column.name])}
        </span>
      ))}
      <span
        data-col={MADE_BY_KEY}
        style={{ width: width(MADE_BY_KEY) }}
        className="shrink-0 truncate text-xs text-muted-foreground"
      >
        {row.madeBy.name ?? ""}
      </span>
    </button>
  );
}

/**
 * The desktop header row. The border right of every column but the last (Made by) is a
 * resize handle for that column (spec §16); the phone list has no header and no handles.
 */
export function ColumnHeader({ columns }: { columns: ShownColumn[] }) {
  const { width } = useColumnWidthsContext();
  const cells = [
    { key: TITLE_KEY, label: "Title", md: false },
    ...columns.map((c) => ({ key: c.id, label: c.name, md: true })),
  ];
  return (
    <div className="flex w-full items-center gap-3 border-b border-border/50 bg-card px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {cells.map((cell) => (
        <span
          key={cell.key}
          style={{ width: width(cell.key) }}
          className={cn(
            "relative shrink-0",
            cell.md && "hidden md:inline-block",
          )}
        >
          <span data-col={cell.key} className="block truncate">
            {cell.label}
          </span>
          <ResizeHandle columnKey={cell.key} label={cell.label} />
        </span>
      ))}
      <span
        data-col={MADE_BY_KEY}
        style={{ width: width(MADE_BY_KEY) }}
        className="shrink-0 truncate"
      >
        Made by
      </span>
    </div>
  );
}

export default function GroupSection({
  title,
  rows,
  columns,
  collapsed,
  onToggle,
  onOpen,
  phone = false,
}: {
  title: string;
  rows: TableRow[];
  columns: ShownColumn[];
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (rowId: string) => void;
  phone?: boolean;
}) {
  return (
    <section
      className="border-b border-border/50"
      data-testid="table-section"
      aria-label={title}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 border-b border-border/50 bg-muted/60 px-4 py-2 text-sm font-medium text-card-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 transition-transform",
            !collapsed && "rotate-90",
          )}
        />
        <span>{title}</span>
        <span className="text-xs text-muted-foreground">{rows.length}</span>
      </button>
      {!collapsed && (
        <div className="bg-card">
          {rows.map((row, index) => (
            <RowLine
              key={row.rowId}
              row={row}
              columns={columns}
              onOpen={onOpen}
              phone={phone}
              alt={index % 2 === 0}
            />
          ))}
        </div>
      )}
    </section>
  );
}
