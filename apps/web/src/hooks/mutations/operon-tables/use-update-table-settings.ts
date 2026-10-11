import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateTableSettings } from "@/fetchers/operon-tables/update-table-settings";

/** Operon fork addition (Tables task 10, row 18): the group/date/status columns. */
function useUpdateTableSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateTableSettings,
    onSuccess: (table) => {
      queryClient.setQueryData(["operon-table", projectId], table);
    },
  });
}

export default useUpdateTableSettings;
