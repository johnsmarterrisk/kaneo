import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  getTableRows,
  type TableRowsQuery,
} from "@/fetchers/operon-tables/get-table-rows";

/** The table view loads at most this many matching rows (spec 7.10). */
export const TABLE_VIEW_ROW_CAP = 2000;

/**
 * Operon fork addition (Tables task 8, row 18): every page of the table's matching rows up
 * to the 2,000-row cap, fetched one after another as each page lands.
 */
function useTableRows(projectId: string, query: TableRowsQuery) {
  const result = useInfiniteQuery({
    queryKey: ["operon-table-rows", projectId, query],
    queryFn: ({ pageParam }) => getTableRows(projectId, query, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.rows.length, 0);
      return last.nextCursor && loaded < TABLE_VIEW_ROW_CAP
        ? last.nextCursor
        : undefined;
    },
    enabled: Boolean(projectId),
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = result;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const pages = result.data?.pages ?? [];
  return {
    rows: pages.flatMap((page) => page.rows).slice(0, TABLE_VIEW_ROW_CAP),
    total: pages[0]?.total ?? null,
    entries: pages[0]?.entries ?? null,
    isLoading: result.isLoading,
    isError: result.isError,
  };
}

export default useTableRows;
