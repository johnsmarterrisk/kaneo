import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLUMN_DEFAULT,
  KEY_STEP,
  MIN_WIDTH,
  TITLE_DEFAULT,
} from "@/components/operon-tables/column-widths";
import TableView from "@/components/operon-tables/table-view";
import type { TableRow } from "@/fetchers/operon-tables/get-table-rows";

/**
 * Operon fork check (Tables follow-up, spec §16, docs/fork-discipline.md row 18): the table
 * list's columns resize — drag a header border, double-click to fit, Left/Right arrows on
 * the focused handle — and the widths are remembered per table in this browser only. A
 * phone has no handles; storage that throws leaves the defaults.
 */
function tableFor(projectId: string) {
  return {
    projectId,
    name: "Risk tips",
    isTable: true as const,
    groupFieldId: null,
    dateFieldId: null,
    statusFieldId: "status",
    columns: [
      {
        id: "status",
        name: "Status",
        kind: "dropdown",
        required: false,
        options: ["Idea", "Published"],
        position: 1,
      },
    ],
  };
}

function row(id: string, title: string): TableRow {
  return {
    rowId: id,
    tableId: "p1",
    title,
    notes: "",
    assigneeId: null,
    values: { Status: "Idea" },
    madeBy: { id: "u1", name: "Dana" },
    createdAt: "2026-10-01T00:00:00Z",
    lastChange: {
      by: { id: null, name: null },
      at: null,
      columns: [],
      summary: null,
    },
    url: "",
  };
}

vi.mock("@/hooks/queries/operon-tables/use-get-table", () => ({
  default: (projectId: string) => ({
    data: tableFor(projectId),
    isLoading: false,
  }),
}));
vi.mock("@/fetchers/operon-tables/get-table-rows", () => ({
  getTableRows: async () => ({
    rows: [row("r1", "A fairly long title"), row("r2", "Short")],
    nextCursor: null,
    total: 2,
    entries: 2,
  }),
}));
vi.mock("@/fetchers/operon-tables/search-table-rows", () => ({
  searchTableRows: async () => ({ rows: [], nextCursor: null }),
}));

function renderView(projectId = "p1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TableView
        projectId={projectId}
        workspaceId="w1"
        isAdmin={true}
        onOpenRow={vi.fn()}
        onAddEntry={vi.fn()}
        onOpenColumns={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

async function ready() {
  await waitFor(() =>
    expect(screen.getAllByTestId("table-row")).toHaveLength(2),
  );
}

/** Rendered width of every cell of a column (header label + row cells). */
function widths(key: string) {
  return [...document.querySelectorAll<HTMLElement>(`[data-col="${key}"]`)].map(
    (cell) =>
      cell.closest("[data-testid='table-row']")
        ? cell.style.width
        : (cell.parentElement as HTMLElement).style.width,
  );
}

function drag(handle: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(handle, { button: 0, clientX: from });
  fireEvent.pointerMove(window, { clientX: to });
  fireEvent.pointerUp(window, { clientX: to });
}

const desktopWidth = window.innerWidth;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: desktopWidth,
  });
});

describe("Table view column resize", () => {
  it("starts Title at its default, not the rest of the row", async () => {
    renderView();
    await ready();
    expect(new Set(widths("title"))).toEqual(new Set([`${TITLE_DEFAULT}px`]));
    expect(new Set(widths("status"))).toEqual(new Set([`${COLUMN_DEFAULT}px`]));
  });

  it("drags a header border to resize the column on its left, with a minimum", async () => {
    renderView();
    await ready();
    const handle = screen.getByRole("button", { name: "Resize Title" });
    drag(handle, 500, 560);
    expect(new Set(widths("title"))).toEqual(
      new Set([`${TITLE_DEFAULT + 60}px`]),
    );
    drag(handle, 500, -1000);
    expect(new Set(widths("title"))).toEqual(new Set([`${MIN_WIDTH}px`]));
  });

  it("fits a column to its widest cell on double-click", async () => {
    renderView();
    await ready();
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.textContent === "A fairly long title" ? 190 : 40;
      },
    );
    fireEvent.doubleClick(screen.getByRole("button", { name: "Resize Title" }));
    expect(new Set(widths("title"))).toEqual(new Set(["194px"]));
  });

  it("resizes from the keyboard with Left and Right arrows", async () => {
    renderView();
    await ready();
    const handle = screen.getByRole("button", { name: "Resize Status" });
    handle.focus();
    expect(document.activeElement).toBe(handle);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(new Set(widths("status"))).toEqual(
      new Set([`${COLUMN_DEFAULT + KEY_STEP}px`]),
    );
  });

  it("remembers widths across a remount for the same table, not for another", async () => {
    const first = renderView("p1");
    await ready();
    drag(screen.getByRole("button", { name: "Resize Title" }), 0, 100);
    first.unmount();

    const again = renderView("p1");
    await ready();
    expect(new Set(widths("title"))).toEqual(
      new Set([`${TITLE_DEFAULT + 100}px`]),
    );
    again.unmount();

    renderView("p2");
    await ready();
    expect(new Set(widths("title"))).toEqual(new Set([`${TITLE_DEFAULT}px`]));
  });

  it("works on the defaults when browser storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderView();
    await ready();
    expect(new Set(widths("title"))).toEqual(new Set([`${TITLE_DEFAULT}px`]));
    drag(screen.getByRole("button", { name: "Resize Title" }), 0, 40);
    expect(new Set(widths("title"))).toEqual(
      new Set([`${TITLE_DEFAULT + 40}px`]),
    );
  });

  it("draws a thin line, not a touch-sized button, and runs it down the rows while dragging", async () => {
    renderView();
    await ready();
    const handle = screen.getByRole("button", { name: "Resize Title" });
    // Opts out of index.css's 44px touch-target minimum (the grey bubble John saw).
    expect(handle.hasAttribute("data-touch-compact")).toBe(true);
    const line = handle.querySelector<HTMLElement>(
      "[data-testid='column-resize-line']",
    );
    expect(line?.className).toContain("opacity-0");
    expect(line?.className).toContain("w-0.5");
    const list = screen.getByTestId("table-list");
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
    } as DOMRect);
    vi.spyOn(handle, "getBoundingClientRect").mockReturnValue({
      top: 100,
    } as DOMRect);
    fireEvent.pointerDown(handle, { button: 0, clientX: 0 });
    expect(handle.hasAttribute("data-dragging")).toBe(true);
    expect(line?.style.height).toBe("500px");
    expect(line?.className).not.toContain("opacity-0");
    fireEvent.pointerUp(window, { clientX: 0 });
    expect(handle.hasAttribute("data-dragging")).toBe(false);
    expect(line?.className).toContain("opacity-0");
  });

  it("shows no resize handles on a phone (375px)", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 375,
    });
    renderView();
    await ready();
    expect(screen.queryAllByTestId("column-resize-handle")).toHaveLength(0);
  });
});
