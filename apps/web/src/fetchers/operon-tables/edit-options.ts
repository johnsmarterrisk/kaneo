import { getApiUrl } from "@/fetchers/get-api-url";

/**
 * Operon fork addition (Tables task 7, docs/fork-discipline.md row 18): add, rename or merge
 * a choice column's options. Rename and Merge rewrite every entry carrying the option on the
 * server, one signal per entry. Admins only (the server decides).
 */
export type OptionEdit =
  | { action: "add"; label: string }
  | { action: "rename"; from: string; to: string }
  | { action: "merge"; from: string; into: string };

export type OptionEditResult = {
  fieldId: string;
  options: string[];
  label: string;
  rowsRewritten: number;
  added?: boolean;
};

export async function editOptions(input: {
  projectId: string;
  fieldId: string;
  edit: OptionEdit;
}): Promise<OptionEditResult> {
  const response = await fetch(
    getApiUrl(
      `/operon/tables/${encodeURIComponent(input.projectId)}/fields/${encodeURIComponent(input.fieldId)}/options`,
    ),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.edit),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      body?.message ?? `The options could not be changed (${response.status})`,
    );
  }
  return (await response.json()) as OptionEditResult;
}
