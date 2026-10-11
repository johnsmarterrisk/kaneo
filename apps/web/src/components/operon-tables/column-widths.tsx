import { createContext, useCallback, useContext, useState } from "react";

/**
 * Operon fork addition (Tables follow-up, John 2026-10-11, spec §16, docs/fork-discipline.md
 * row 18): resizable columns in the table list view. Widths are a view preference kept per
 * table in THIS browser only (localStorage, keyed by table id) — never on the relay, never in
 * the API, never per user on the server. Rule 23 forbids persisting private keys; a column
 * width is not key material, so browser storage is allowed here. Storage that throws
 * (private mode, blocked site data) leaves the view on the defaults, in memory.
 */
export const TITLE_KEY = "title";
export const MADE_BY_KEY = "madeBy";
/** Smallest width a column can take: a short value plus its ellipsis stays readable. */
export const MIN_WIDTH = 64;
export const MAX_WIDTH = 800;
/** Title no longer takes the rest of the row (was flex-1); the other columns keep w-28. */
export const TITLE_DEFAULT = 280;
export const COLUMN_DEFAULT = 112;
/** One Left/Right arrow press on a resize handle. */
export const KEY_STEP = 16;

export type ColumnWidths = Record<string, number>;

export function widthsKey(tableId: string) {
  return `operon:table-column-widths:${tableId}`;
}

export function clampWidth(px: number) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
}

export function readWidths(tableId: string): ColumnWidths {
  try {
    const stored = window.localStorage.getItem(widthsKey(tableId));
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const widths: ColumnWidths = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        widths[key] = clampWidth(value);
      }
    }
    return widths;
  } catch {
    // Best-effort preference: unreadable storage means the defaults.
    return {};
  }
}

function writeWidths(tableId: string, widths: ColumnWidths) {
  try {
    window.localStorage.setItem(widthsKey(tableId), JSON.stringify(widths));
  } catch {
    // Best-effort preference: a blocked write keeps the width for this visit only.
  }
}

/** The Columns page's "Reset widths": forgets this table's widths on this browser. */
export function clearColumnWidths(tableId: string): boolean {
  try {
    window.localStorage.removeItem(widthsKey(tableId));
    return true;
  } catch {
    return false;
  }
}

export type ColumnWidthsApi = {
  width: (key: string) => number;
  setWidth: (key: string, px: number) => void;
};

export function useColumnWidths(tableId: string): ColumnWidthsApi {
  const [state, setState] = useState(() => ({
    tableId,
    widths: readWidths(tableId),
  }));
  const widths = state.tableId === tableId ? state.widths : readWidths(tableId);
  const width = useCallback(
    (key: string) =>
      widths[key] ?? (key === TITLE_KEY ? TITLE_DEFAULT : COLUMN_DEFAULT),
    [widths],
  );
  const setWidth = useCallback(
    (key: string, px: number) =>
      setState((prev) => {
        const base =
          prev.tableId === tableId ? prev.widths : readWidths(tableId);
        const next = { ...base, [key]: clampWidth(px) };
        writeWidths(tableId, next);
        return { tableId, widths: next };
      }),
    [tableId],
  );
  return { width, setWidth };
}

/** Without a provider (no table view around) every column sits at its default. */
const fallback: ColumnWidthsApi = {
  width: (key) => (key === TITLE_KEY ? TITLE_DEFAULT : COLUMN_DEFAULT),
  setWidth: () => {},
};

export const ColumnWidthsContext = createContext<ColumnWidthsApi>(fallback);

export function useColumnWidthsContext() {
  return useContext(ColumnWidthsContext);
}

/**
 * The widest cell of one column in the list, so double-click can fit to content. Each cell
 * is measured at its natural width (`width: max-content` for the read, then put back):
 * a fixed-width cell's scrollWidth never reports less than the cell itself, so fit could
 * only ever grow a column, never shrink an oversized one (Codex round 2, item 4). All
 * widths are set, then read, then restored, so the list lays out once.
 */
function contentWidth(from: HTMLElement, key: string): number | null {
  const list = from.closest('[data-testid="table-list"]') ?? document;
  const cells = [...list.querySelectorAll<HTMLElement>("[data-col]")].filter(
    (cell) => cell.dataset.col === key,
  );
  const before = cells.map((cell) => cell.style.width);
  for (const cell of cells) cell.style.width = "max-content";
  const widest = Math.max(
    0,
    ...cells.map((cell) => Math.ceil(cell.getBoundingClientRect().width)),
  );
  cells.forEach((cell, index) => {
    cell.style.width = before[index] ?? "";
  });
  return widest > 0 ? widest + 4 : null;
}

/**
 * The drag handle on the border right of a column header: drag resizes the column to its
 * left, double-click fits it to its content, Left/Right arrows step it by KEY_STEP. A
 * button so it is focusable and named ("Resize <column>") without extra ARIA wiring.
 *
 * Spreadsheet look (John, 2026-10-11): invisible at rest; an 8px hit strip centred on the
 * boundary shows a 2px line on hover, focus and drag, and while dragging the line runs down
 * the visible rows. `data-touch-compact` opts out of index.css's 44px touch-target minimum,
 * which otherwise turned the strip into a 44px grey bubble below the header baseline.
 */
export function ResizeHandle({
  columnKey,
  label,
}: {
  columnKey: string;
  label: string;
}) {
  const { width, setWidth } = useColumnWidthsContext();
  // While dragging: how far the line reaches below the header (to the list's visible bottom).
  const [dragLine, setDragLine] = useState<number | null>(null);

  // Same window-listener drag as the fork's gantt bar resize (gantt-task-bar.tsx).
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width(columnKey);
    const handle = event.currentTarget.getBoundingClientRect();
    const list = event.currentTarget
      .closest('[data-testid="table-list"]')
      ?.getBoundingClientRect();
    setDragLine(list ? Math.max(0, list.bottom - handle.top) : null);
    const onMove = (ev: PointerEvent) =>
      setWidth(columnKey, startWidth + ev.clientX - startX);
    const onUp = () => {
      setDragLine(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <button
      type="button"
      aria-label={`Resize ${label}`}
      data-testid="column-resize-handle"
      data-touch-compact=""
      data-dragging={dragLine !== null ? "" : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={(event) => {
        const fit = contentWidth(event.currentTarget, columnKey);
        if (fit !== null) setWidth(columnKey, fit);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const step = event.key === "ArrowLeft" ? -KEY_STEP : KEY_STEP;
          setWidth(columnKey, width(columnKey) + step);
        }
      }}
      // The header's gap-3 is 12px, so the boundary sits 6px right of the cell; the 8px
      // strip starts 4px before it. -top/-bottom-1.5 cover the header's py-1.5.
      className="group absolute -top-1.5 -bottom-1.5 -right-[10px] z-10 m-0 w-2 cursor-col-resize appearance-none border-0 bg-transparent p-0 outline-none"
    >
      <span
        aria-hidden="true"
        data-testid="column-resize-line"
        style={dragLine !== null ? { height: dragLine } : undefined}
        className={
          dragLine !== null
            ? "pointer-events-none absolute top-0 left-[3px] w-0.5 bg-primary"
            : "pointer-events-none absolute top-0 bottom-0 left-[3px] w-0.5 bg-primary opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }
      />
    </button>
  );
}
