import { useQuery } from "@tanstack/react-query";
import { getTable } from "@/fetchers/operon-tables/get-table";

/** Operon fork addition (Tables, row 18): the table flag; `null` for an ordinary project. */
function useGetTable(projectId: string | undefined) {
  return useQuery({
    queryKey: ["operon-table", projectId],
    queryFn: () => getTable(projectId ?? ""),
    enabled: Boolean(projectId),
  });
}

export default useGetTable;
