import { getApiUrl } from "@/fetchers/get-api-url";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, spec 7.8 / 7.9): one
 * page of a table's rows. The server applies the sort and the chip filters before it cuts
 * the page, so a matching row created long ago is still reached.
 */
export type TableRow = {
  rowId: string;
  tableId: string;
  title: string;
  notes: string;
  assigneeId: string | null;
  values: Record<string, unknown>;
  madeBy: { id: string | null; name: string | null };
  createdAt: string | null;
  lastChange: {
    by: { id: string | null; name: string | null };
    at: string | null;
    columns: string[];
    summary: string | null;
  };
  url: string;
};

export type TableRowsQuery = {
  sort: "created" | "date";
  /** Choice column id → the one selected option. */
  filters: Record<string, string>;
  year: number | null;
};

export type TableRowsPage = {
  rows: TableRow[];
  nextCursor: string | null;
  /** Matching rows (first page only). */
  total: number | null;
  /** All rows of the table (first page only). */
  entries: number | null;
};

export function tableRowsSearch(
  query: TableRowsQuery,
  cursor?: string | null,
): string {
  const params = new URLSearchParams();
  params.set("sort", query.sort);
  for (const [fieldId, option] of Object.entries(query.filters)) {
    params.append("filter", `${fieldId}:${option}`);
  }
  if (query.year !== null) params.set("year", String(query.year));
  params.set("limit", "200");
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export async function getTableRows(
  projectId: string,
  query: TableRowsQuery,
  cursor?: string | null,
): Promise<TableRowsPage> {
  const response = await fetch(
    getApiUrl(
      `/operon/tables/${encodeURIComponent(projectId)}/rows?${tableRowsSearch(query, cursor)}`,
    ),
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(`The entries could not be read (${response.status})`);
  }
  return (await response.json()) as TableRowsPage;
}
