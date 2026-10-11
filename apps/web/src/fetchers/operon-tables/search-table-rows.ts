import { getApiUrl } from "@/fetchers/get-api-url";
import type { TableRow } from "./get-table-rows";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, RF-11): the server
 * search the table view's search box calls — a literal substring over titles, Notes and
 * the active text and link columns, so a row beyond the loaded pages is still found.
 */
export type SearchRow = TableRow & { tableName: string };

export async function searchTableRows(input: {
  workspaceId: string;
  tableId?: string;
  q: string;
  cursor?: string | null;
}): Promise<{ rows: SearchRow[]; nextCursor: string | null }> {
  const params = new URLSearchParams({
    workspaceId: input.workspaceId,
    q: input.q,
  });
  if (input.tableId) params.set("tableId", input.tableId);
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await fetch(
    getApiUrl(`/operon/tables/search?${params.toString()}`),
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(`The search did not run (${response.status})`);
  }
  return (await response.json()) as {
    rows: SearchRow[];
    nextCursor: string | null;
  };
}
