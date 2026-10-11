import { useInfiniteQuery } from "@tanstack/react-query";
import {
  type ColumnHistory,
  getColumnHistory,
} from "@/fetchers/operon-tables/get-column-history";

/**
 * Operon fork addition (Tables, row 18): a column's recovery read, fetched on demand, one
 * page of changes at a time (codex round 1, finding 5): `fetchNextPage` follows the API's
 * `nextCursor`, so changes older than the first page stay recoverable. The current values
 * come from the first page; the changes are every loaded page, newest first.
 */
function useGetColumnHistory(projectId: string, fieldId: string | null) {
  const result = useInfiniteQuery({
    queryKey: ["operon-table-history", projectId, fieldId],
    queryFn: ({ pageParam }) =>
      getColumnHistory(projectId, fieldId ?? "", pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(projectId && fieldId),
  });
  const pages = result.data?.pages ?? [];
  const first = pages[0];
  const data: ColumnHistory | undefined = first
    ? {
        ...first,
        history: pages.flatMap((page) => page.history),
        nextCursor: pages[pages.length - 1]?.nextCursor ?? null,
      }
    : undefined;
  return {
    data,
    isLoading: result.isLoading,
    error: result.error,
    hasNextPage: result.hasNextPage,
    isFetchingNextPage: result.isFetchingNextPage,
    fetchNextPage: result.fetchNextPage,
  };
}

export default useGetColumnHistory;
