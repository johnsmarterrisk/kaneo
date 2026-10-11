import { getApiUrl } from "@/fetchers/get-api-url";

/**
 * Operon fork addition (Tables task 6/10, docs/fork-discipline.md row 18): the admin-only
 * recovery read of one column, hidden or not — its current values and its value history.
 */
export type ColumnHistory = {
  field: { id: string; name: string; kind: string; hidden: boolean };
  current: { rowId: string; title: string; value: string | null }[];
  history: {
    rowId: string;
    oldValue: string | null;
    newValue: string | null;
    reason: string;
    at: string;
  }[];
  nextCursor: string | null;
};

/** `cursor` is the previous page's `nextCursor` (codex round 1, finding 5: older pages). */
export async function getColumnHistory(
  projectId: string,
  fieldId: string,
  cursor?: string | null,
): Promise<ColumnHistory> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await fetch(
    getApiUrl(
      `/operon/tables/${encodeURIComponent(projectId)}/fields/${encodeURIComponent(fieldId)}/history${query}`,
    ),
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(`The history could not be read (${response.status})`);
  }
  return (await response.json()) as ColumnHistory;
}
