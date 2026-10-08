import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getProjectFieldLabels,
  putProjectFieldLabels,
} from "@/fetchers/operon-field-labels/project-field-labels";

// Operon fork addition (social agent S18, docs/fork-discipline.md row 17). A project with
// no labels, a failed read and a read still loading all answer `undefined`, so every call
// site falls through to its existing translation and renders exactly as upstream.
const queryKey = (projectId: string) => ["operon-field-labels", projectId];

export function useProjectFieldLabels(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKey(projectId ?? ""),
    queryFn: () => getProjectFieldLabels(projectId ?? ""),
    enabled: Boolean(projectId),
    staleTime: 60_000,
    retry: false,
  });
}

/** The project's label for `field`, or `undefined` for the call site's translation. */
export function useProjectFieldLabel(
  projectId: string | undefined,
  field: "description" | "dueDate",
): string | undefined {
  const { data, isError } = useProjectFieldLabels(projectId);
  if (isError || !data) return undefined;
  const label =
    field === "description" ? data.descriptionLabel : data.dueDateLabel;
  return label ?? undefined;
}

export function useSetProjectFieldLabels(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (labels: { descriptionLabel: string; dueDateLabel: string }) =>
      putProjectFieldLabels(projectId, labels),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKey(projectId), saved);
    },
  });
}
