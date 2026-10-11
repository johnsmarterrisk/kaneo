import { useQuery } from "@tanstack/react-query";
import {
  getTablesSummary,
  type TablesSummary,
} from "@/fetchers/operon-tables/get-tables-summary";

/**
 * Operon fork addition (Tables task 8, row 18): every table the caller may read, with
 * counts. The route pages 50 tables at a time and applies the per-table read checks, so this
 * follows `nextCursor` until it is exhausted (Codex round 1, finding 2); "Recently added"
 * comes with the first page. The Tables page and the sidebar's TABLES group share this query.
 */
async function getAllTablesSummary(
  workspaceId: string,
): Promise<TablesSummary> {
  const first = await getTablesSummary(workspaceId);
  const tables = [...first.tables];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await getTablesSummary(workspaceId, cursor);
    tables.push(...page.tables);
    cursor = page.nextCursor;
  }
  return { ...first, tables, nextCursor: null };
}

function useTablesSummary(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: ["operon-tables-summary", workspaceId],
    queryFn: () => getAllTablesSummary(workspaceId),
    enabled: Boolean(workspaceId) && enabled,
  });
}

export default useTablesSummary;
