import { getApiUrl } from "@/fetchers/get-api-url";
import type { TableRow } from "./get-table-rows";

/**
 * Operon fork addition (Tables task 9, docs/fork-discipline.md row 18, spec 7.3 / 7.9): one
 * entry's read, and the record panel's writes through the table's atomic row route — the
 * only write path for a table entry (the task routes refuse table rows).
 */
export type TableRowRead = {
  row: TableRow;
  table: {
    tableId: string;
    name: string;
    groupColumn: string | null;
    statusColumn: string | null;
    dateColumn: string | null;
  };
};

export type RowWrite = {
  title: string;
  notes: string;
  /** Column name → typed value; null clears it. */
  values: Record<string, unknown>;
  /** "New topic…": adds the option to the group column and sets it in the same save. */
  newTopic?: { fieldId: string; label: string };
};

async function failure(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => null)) as {
    message?: string;
  } | null;
  throw new Error(body?.message ?? `${fallback} (${response.status})`);
}

export async function getTableRow(taskId: string): Promise<TableRowRead> {
  const response = await fetch(
    getApiUrl(`/operon/tables/rows/${encodeURIComponent(taskId)}`),
    { credentials: "include" },
  );
  if (!response.ok) return failure(response, "The entry could not be read");
  return (await response.json()) as TableRowRead;
}

export async function addTableRow(
  projectId: string,
  requestId: string,
  write: RowWrite,
): Promise<{ row: TableRow }> {
  const response = await fetch(
    getApiUrl(`/operon/tables/${encodeURIComponent(projectId)}/rows`),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, ...write }),
    },
  );
  if (!response.ok) return failure(response, "The entry could not be added");
  return (await response.json()) as { row: TableRow };
}

export async function updateTableRow(
  projectId: string,
  taskId: string,
  write: RowWrite,
): Promise<{ row: TableRow; unchanged: boolean }> {
  const response = await fetch(
    getApiUrl(
      `/operon/tables/${encodeURIComponent(projectId)}/rows/${encodeURIComponent(taskId)}`,
    ),
    {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(write),
    },
  );
  if (!response.ok) return failure(response, "The entry could not be saved");
  return (await response.json()) as { row: TableRow; unchanged: boolean };
}

export async function deleteTableRow(
  projectId: string,
  taskId: string,
): Promise<void> {
  const response = await fetch(
    getApiUrl(
      `/operon/tables/${encodeURIComponent(projectId)}/rows/${encodeURIComponent(taskId)}`,
    ),
    { method: "DELETE", credentials: "include" },
  );
  if (!response.ok) return failure(response, "The entry could not be deleted");
}
