import { format, isValid, parseISO } from "date-fns";
import { ChevronRight } from "lucide-react";
import type { OperonTable } from "@/fetchers/operon-tables/get-table";
import type { TableRow } from "@/fetchers/operon-tables/get-table-rows";
import { cn } from "@/lib/cn";

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
      <span className="min-w-0 flex-1 truncate text-sm text-card-foreground">
        {row.title}
      </span>
      {columns.map((column) => (
        <span
          key={column.id}
          className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground md:inline"
        >
          {cellText(column, row.values[column.name])}
        </span>
      ))}
      <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
        {row.madeBy.name ?? ""}
      </span>
    </button>
  );
}

export function ColumnHeader({ columns }: { columns: ShownColumn[] }) {
  return (
    <div className="flex items-center gap-3 border-b border-border/50 bg-card px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      <span className="min-w-0 flex-1">Title</span>
      {columns.map((column) => (
        <span
          key={column.id}
          className="hidden w-28 shrink-0 truncate md:inline"
        >
          {column.name}
        </span>
      ))}
      <span className="w-28 shrink-0">Made by</span>
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
