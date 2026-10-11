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

/** The widest cell of one column in the list, so double-click can fit to content. */
function contentWidth(from: HTMLElement, key: string): number | null {
  const list = from.closest('[data-testid="table-list"]') ?? document;
  let widest = 0;
  for (const cell of list.querySelectorAll<HTMLElement>("[data-col]")) {
    if (cell.dataset.col === key) widest = Math.max(widest, cell.scrollWidth);
  }
  return widest > 0 ? widest + 4 : null;
}

/**
 * The drag handle on the border right of a column header: drag resizes the column to its
 * left, double-click fits it to its content, Left/Right arrows step it by KEY_STEP. A
 * button so it is focusable and named ("Resize <column>") without extra ARIA wiring.
 */
export function ResizeHandle({
  columnKey,
  label,
}: {
  columnKey: string;
  label: string;
}) {
  const { width, setWidth } = useColumnWidthsContext();

  // Same window-listener drag as the fork's gantt bar resize (gantt-task-bar.tsx).
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width(columnKey);
    const onMove = (ev: PointerEvent) =>
      setWidth(columnKey, startWidth + ev.clientX - startX);
    const onUp = () => {
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
      className="absolute top-0 -right-[9px] z-10 h-full w-[6px] cursor-col-resize rounded-sm bg-border/0 hover:bg-border focus-visible:bg-primary focus-visible:outline-none"
    />
  );
}
