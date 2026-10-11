import useSearchTableRows from "@/hooks/queries/operon-tables/use-search-table-rows";
import { ColumnHeader, RowLine, type ShownColumn } from "./group-section";

/**
 * Operon fork addition (Tables task 8, docs/fork-discipline.md row 18, RF-11): the search
 * results that replace the grouped list while the search box holds text. They come from
 * the server search route, so a row outside the loaded pages is found too.
 */
export default function TableSearchResults({
  workspaceId,
  tableId,
  query,
  columns,
  onOpen,
}: {
  workspaceId: string;
  tableId: string;
  query: string;
  columns: ShownColumn[];
  onOpen: (rowId: string) => void;
}) {
  const search = useSearchTableRows({ workspaceId, tableId, q: query });
  const rows = search.data?.pages.flatMap((page) => page.rows) ?? [];
  if (search.isError) {
    return (
      <p className="px-4 py-6 text-sm text-destructive">
        The search did not run. Try again.
      </p>
    );
  }
  if (search.isLoading) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">Searching…</p>
    );
  }
  return (
    <div data-testid="table-search-results">
      <ColumnHeader columns={columns} />
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No entries match “{query.trim()}”.
        </p>
      ) : (
        rows.map((row, index) => (
          <RowLine
            key={row.rowId}
            row={row}
            columns={columns}
            onOpen={onOpen}
            alt={index % 2 === 0}
          />
        ))
      )}
      {search.hasNextPage && (
        <button
          type="button"
          onClick={() => void search.fetchNextPage()}
          className="w-full px-4 py-2 text-left text-xs text-muted-foreground hover:bg-accent/60"
        >
          More results
        </button>
      )}
    </div>
  );
}
