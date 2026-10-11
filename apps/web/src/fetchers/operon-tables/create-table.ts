import { getApiUrl } from "@/fetchers/get-api-url";

/**
 * Operon fork addition (Tables, docs/fork-discipline.md row 18): "New table" — a project
 * flagged as a table, starting from the Marketing asset columns. Admins only (the server
 * decides; the menu entry only hides the option from members).
 */
export type CreatedTable = { id: string; workspaceId: string; isTable: true };

export async function createTable(input: {
  workspaceId: string;
  name: string;
  slug: string;
  icon: string;
}): Promise<CreatedTable> {
  const response = await fetch(getApiUrl("/operon/tables"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      body?.message ?? `The table could not be created (${response.status})`,
    );
  }
  return (await response.json()) as CreatedTable;
}
