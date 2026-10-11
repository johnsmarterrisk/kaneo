import { getApiUrl } from "@/fetchers/get-api-url";

/**
 * Operon fork addition (Tables, docs/fork-discipline.md row 18): a project's table flag
 * and active columns. `null` when the project is not a table (the route's 404).
 */
export type OperonTable = {
  projectId: string;
  name: string;
  isTable: true;
  groupFieldId: string | null;
  dateFieldId: string | null;
  statusFieldId: string | null;
  columns: {
    id: string;
    name: string;
    kind: string;
    required: boolean;
    options: string[] | null;
    position: number;
  }[];
  /** Present for a table admin only (the Columns page's "Hidden columns"). */
  hiddenColumns?: {
    id: string;
    name: string;
    kind: string;
    hiddenAt: string;
  }[];
};

export async function getTable(projectId: string): Promise<OperonTable | null> {
  const response = await fetch(
    getApiUrl(`/operon/tables/${encodeURIComponent(projectId)}`),
    { credentials: "include" },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`The table could not be read (${response.status})`);
  }
  return (await response.json()) as OperonTable;
}
