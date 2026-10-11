import { useInfiniteQuery } from "@tanstack/react-query";
import { searchTableRows } from "@/fetchers/operon-tables/search-table-rows";

/** Operon fork addition (Tables task 8, row 18, RF-11): the server search, paged on demand. */
function useSearchTableRows(input: {
  workspaceId: string;
  tableId?: string;
  q: string;
}) {
  const q = input.q.trim();
  return useInfiniteQuery({
    queryKey: ["operon-table-search", input.workspaceId, input.tableId, q],
    queryFn: ({ pageParam }) =>
      searchTableRows({ ...input, q, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(input.workspaceId && q),
  });
}

export default useSearchTableRows;
