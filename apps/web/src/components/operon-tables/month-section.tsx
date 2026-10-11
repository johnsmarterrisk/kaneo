import { format, isValid, parseISO } from "date-fns";
import type { TableRow } from "@/fetchers/operon-tables/get-table-rows";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.10): the
 * "Sort by date" layout — the undated rows as "No date" on top, then one section per month
 * newest first ("October 2026"). The server already ordered the rows that way; this only
 * cuts them into sections, keeping the server's order.
 */
export const VISIBLE_MONTHS = 12;

export type MonthBucket = { key: string; title: string; rows: TableRow[] };

export function monthBuckets(rows: TableRow[], dateColumn: string) {
  const undated: TableRow[] = [];
  const months: MonthBucket[] = [];
  for (const row of rows) {
    const raw = row.values[dateColumn];
    const date = typeof raw === "string" ? parseISO(raw) : null;
    if (!date || !isValid(date)) {
      undated.push(row);
      continue;
    }
    const key = format(date, "yyyy-MM");
    let bucket = months[months.length - 1];
    if (!bucket || bucket.key !== key) {
      bucket = { key, title: format(date, "MMMM yyyy"), rows: [] };
      months.push(bucket);
    }
    bucket.rows.push(row);
  }
  return { undated, months };
}
