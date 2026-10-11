import { getApiUrl } from "@/fetchers/get-api-url";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.10 US1): the
 * workspace project list's Tables section — per table entries, group and status counts and
 * the last added row; the first page also carries the five newest rows across tables.
 */
export type TableSummary = {
  tableId: string;
  name: string;
  entries: number;
  group: {
    fieldId: string;
    name: string;
    isTemplateTopic: boolean;
    options: number;
    counts: { option: string; count: number }[];
  } | null;
  status: { option: string; count: number }[];
  lastAdded: { at: string; by: string | null } | null;
};

export type RecentRow = {
  rowId: string;
  tableId: string;
  tableName: string;
  title: string;
  madeBy: string | null;
  createdAt: string;
};

export type TablesSummary = {
  tables: TableSummary[];
  nextCursor: string | null;
  recent?: RecentRow[];
};

export async function getTablesSummary(
  workspaceId: string,
  cursor?: string | null,
): Promise<TablesSummary> {
  const response = await fetch(
    getApiUrl(
      `/operon/tables/workspace/${encodeURIComponent(workspaceId)}/summary${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(`The tables could not be read (${response.status})`);
  }
  return (await response.json()) as TablesSummary;
}
