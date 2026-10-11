import { useQuery } from "@tanstack/react-query";
import { getTablesSummary } from "@/fetchers/operon-tables/get-tables-summary";

/** Operon fork addition (Tables task 8, row 18): the workspace list's Tables section. */
function useTablesSummary(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: ["operon-tables-summary", workspaceId],
    queryFn: () => getTablesSummary(workspaceId),
    enabled: Boolean(workspaceId) && enabled,
  });
}

export default useTablesSummary;
