import { useQuery } from "@tanstack/react-query";
import { getColumnHistory } from "@/fetchers/operon-tables/get-column-history";

/** Operon fork addition (Tables, row 18): a column's recovery read, fetched on demand. */
function useGetColumnHistory(projectId: string, fieldId: string | null) {
  return useQuery({
    queryKey: ["operon-table-history", projectId, fieldId],
    queryFn: () => getColumnHistory(projectId, fieldId ?? ""),
    enabled: Boolean(projectId && fieldId),
  });
}

export default useGetColumnHistory;
