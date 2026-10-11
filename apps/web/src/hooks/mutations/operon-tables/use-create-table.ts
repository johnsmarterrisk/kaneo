import { useMutation } from "@tanstack/react-query";
import { createTable } from "@/fetchers/operon-tables/create-table";

function useCreateTable() {
  return useMutation({ mutationFn: createTable });
}

export default useCreateTable;
