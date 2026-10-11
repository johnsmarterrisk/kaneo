import { getApiUrl } from "@/fetchers/get-api-url";
import type { OperonTable } from "./get-table";

/**
 * Operon fork addition (Tables task 10, docs/fork-discipline.md row 18): the table's group,
 * date and status columns. Admins only; the server checks each column's table and kind.
 */
export type TableSettings = Partial<
  Record<"groupFieldId" | "dateFieldId" | "statusFieldId", string | null>
>;

export async function updateTableSettings(input: {
  projectId: string;
  settings: TableSettings;
}): Promise<OperonTable> {
  const response = await fetch(
    getApiUrl(`/operon/tables/${encodeURIComponent(input.projectId)}/settings`),
    {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.settings),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      body?.message ?? `The setting could not be saved (${response.status})`,
    );
  }
  return (await response.json()) as OperonTable;
}
