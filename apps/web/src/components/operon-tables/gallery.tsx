import type { OperonTable } from "@/fetchers/operon-tables/get-table";
import type { TableRow } from "@/fetchers/operon-tables/get-table-rows";
import { formatDay } from "./group-section";
import {
  previewPlaceholder,
  useInView,
  useStashThumbnail,
} from "./use-stash-thumbnail";

/**
 * Operon fork addition (Tables task 11, docs/fork-discipline.md row 18, spec 7.10 US5): the
 * gallery of a table with an image column. One tile per entry that holds an image: the
 * first image column's Stash preview (lazy, four in flight), the title, the group option,
 * the date and the maker; a tile opens the record panel. A refused preview shows its named
 * placeholder ("Removed from Stash", "Not an image", …), never a broken image.
 */
type Column = OperonTable["columns"][number];

function Tile({
  row,
  image,
  group,
  dateColumn,
  onOpen,
}: {
  row: TableRow;
  image: Column;
  group: Column | null;
  dateColumn: Column | null;
  onOpen: (rowId: string) => void;
}) {
  const fileId = row.values[image.name];
  const [ref, inView] = useInView<HTMLButtonElement>();
  const thumb = useStashThumbnail(
    typeof fileId === "string" ? fileId : null,
    inView,
  );
  const meta = [
    group ? row.values[group.name] : null,
    dateColumn ? formatDay(row.values[dateColumn.name]) : null,
    row.madeBy.name,
  ].filter((part): part is string => typeof part === "string" && part !== "");
  return (
    <button
      ref={ref}
      type="button"
      data-testid="gallery-tile"
      onClick={() => onOpen(row.rowId)}
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left text-card-foreground transition-colors hover:bg-accent/60"
    >
      <div className="flex aspect-square w-full items-center justify-center bg-muted/40">
        {thumb.status === "ready" ? (
          <img
            src={thumb.url}
            alt={row.title}
            className="h-full w-full object-cover"
          />
        ) : thumb.status === "error" ? (
          <span className="px-3 text-center text-xs text-muted-foreground">
            {previewPlaceholder(thumb.httpStatus)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Loading…</span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 p-2">
        <span className="truncate text-sm font-medium">{row.title}</span>
        {meta.length > 0 && (
          <span className="truncate text-xs text-muted-foreground">
            {meta.join(" · ")}
          </span>
        )}
      </div>
    </button>
  );
}

export default function Gallery({
  table,
  rows,
  onOpen,
}: {
  table: OperonTable;
  rows: TableRow[];
  onOpen: (rowId: string) => void;
}) {
  const image = table.columns.find((c) => c.kind === "image");
  if (!image) return null;
  const group = table.columns.find((c) => c.id === table.groupFieldId) ?? null;
  const dateColumn =
    table.columns.find((c) => c.id === table.dateFieldId) ?? null;
  const withImage = rows.filter(
    (row) => typeof row.values[image.name] === "string",
  );
  return (
    <div className="flex flex-col gap-3 p-4">
      {withImage.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No entries with an image yet.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {withImage.map((row) => (
            <Tile
              key={row.rowId}
              row={row}
              image={image}
              group={group}
              dateColumn={dateColumn}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Each tile is the graphic itself, stored in Stash.
      </p>
    </div>
  );
}
