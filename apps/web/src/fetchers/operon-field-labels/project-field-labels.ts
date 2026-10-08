import { getApiUrl } from "@/fetchers/get-api-url";

/**
 * Operon fork addition (social agent S18, docs/fork-discipline.md row 17): a project's
 * optional words for the description and due-date fields. `null` = the translated default.
 */
export type ProjectFieldLabels = {
  projectId: string;
  descriptionLabel: string | null;
  dueDateLabel: string | null;
};

export async function getProjectFieldLabels(
  projectId: string,
): Promise<ProjectFieldLabels> {
  const response = await fetch(
    getApiUrl(`/operon/project-field-labels/${encodeURIComponent(projectId)}`),
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(
      `Project field labels could not be read (${response.status})`,
    );
  }
  return (await response.json()) as ProjectFieldLabels;
}

export async function putProjectFieldLabels(
  projectId: string,
  labels: { descriptionLabel: string; dueDateLabel: string },
): Promise<ProjectFieldLabels> {
  const response = await fetch(
    getApiUrl(`/operon/project-field-labels/${encodeURIComponent(projectId)}`),
    {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(labels),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      body?.message ??
        `Project field labels could not be saved (${response.status})`,
    );
  }
  return (await response.json()) as ProjectFieldLabels;
}
