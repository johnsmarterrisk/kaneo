import { useQuery } from "@tanstack/react-query";
import { getTableRow } from "@/fetchers/operon-tables/table-row";

/** Operon fork addition (Tables task 9, row 18): one entry for the record panel. */
function useTableRow(taskId: string | undefined) {
  return useQuery({
    queryKey: ["operon-table-row", taskId],
    queryFn: () => getTableRow(taskId ?? ""),
    enabled: Boolean(taskId) && taskId !== "new",
  });
}

export default useTableRow;
