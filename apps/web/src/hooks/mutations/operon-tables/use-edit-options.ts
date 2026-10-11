import { useMutation, useQueryClient } from "@tanstack/react-query";
import { editOptions } from "@/fetchers/operon-tables/edit-options";

/** Operon fork addition (Tables task 7, row 18): option add / rename / merge. */
function useEditOptions(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: editOptions,
    onSuccess: () => {
      // Rows, definitions and the table all change with a rename or merge.
      void queryClient.invalidateQueries({
        queryKey: ["operon-table", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["custom-fields", projectId],
      });
      void queryClient.invalidateQueries({ refetchType: "all" });
    },
  });
}

export default useEditOptions;
