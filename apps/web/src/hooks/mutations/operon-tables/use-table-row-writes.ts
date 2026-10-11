import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  addTableRow,
  deleteTableRow,
  type RowWrite,
  updateTableRow,
} from "@/fetchers/operon-tables/table-row";

/**
 * Operon fork addition (Tables task 9, row 18): the record panel's save and delete. Each
 * refreshes the table's rows, the workspace summary and (a new topic adds an option) the
 * table's columns.
 */
function useRefresh(projectId: string) {
  const queryClient = useQueryClient();
  return async (taskId?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["operon-table-rows", projectId],
      }),
      queryClient.invalidateQueries({ queryKey: ["operon-table", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["operon-tables-summary"] }),
      queryClient.invalidateQueries({ queryKey: ["operon-table-search"] }),
      ...(taskId
        ? [
            queryClient.invalidateQueries({
              queryKey: ["operon-table-row", taskId],
            }),
          ]
        : []),
    ]);
  };
}

export function useSaveTableRow(projectId: string) {
  const refresh = useRefresh(projectId);
  return useMutation({
    mutationFn: async (input: {
      taskId: string | null;
      requestId: string;
      write: RowWrite;
    }) =>
      input.taskId
        ? (await updateTableRow(projectId, input.taskId, input.write)).row
        : (await addTableRow(projectId, input.requestId, input.write)).row,
    onSuccess: (row) => refresh(row.rowId),
  });
}

export function useDeleteTableRow(projectId: string) {
  const refresh = useRefresh(projectId);
  return useMutation({
    mutationFn: (taskId: string) => deleteTableRow(projectId, taskId),
    onSuccess: (_data, taskId) => refresh(taskId),
  });
}
