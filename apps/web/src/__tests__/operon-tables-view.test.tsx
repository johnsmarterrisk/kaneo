import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TableView from "@/components/operon-tables/table-view";
import TablesSection, {
  groupLine,
  statusLine,
} from "@/components/operon-tables/tables-section";
import type {
  TableRow,
  TableRowsQuery,
} from "@/fetchers/operon-tables/get-table-rows";
import type { TableSummary } from "@/fetchers/operon-tables/get-tables-summary";

/**
 * Operon fork check (Tables task 8, docs/fork-discipline.md row 18, spec 7.10 US2/US4,
 * RF-11): the table view groups in option order with counts and a "No <group>" section,
 * sorts by date under month headers with "No date" on top, sends its sort and column filters
 * to the rows route, and searches on the server (a row the loaded pages do not hold is found).
 * Tables filter bar (spec tables-filter-bar §8): the real ui/menu.tsx in jsdom — one
 * multi-select menu per choice column, OR within and AND across, no Year anywhere.
 */
const table = {
  projectId: "p1",
  name: "Risk tips",
  isTable: true as const,
  groupFieldId: "topic",
  dateFieldId: "posted",
  statusFieldId: "status",
  columns: [
    {
      id: "topic",
      name: "Topic",
      kind: "dropdown",
      required: false,
      options: ["Cyber", "Fleet", "Fraud"],
      position: 1,
    },
    {
      id: "status",
      name: "Status",
      kind: "dropdown",
      required: false,
      options: ["Idea", "In progress", "Published"],
      position: 2,
    },
    {
      id: "posted",
      name: "Posted",
      kind: "date",
      required: false,
      options: null,
      position: 3,
    },
    {
      id: "channel",
      name: "Channel",
      kind: "dropdown",
      required: false,
      options: ["LinkedIn", "Newsletter", "Site"],
      position: 4,
    },
  ],
};

function row(
  id: string,
  title: string,
  values: Record<string, unknown>,
): TableRow {
  return {
    rowId: id,
    tableId: "p1",
    title,
    notes: "",
    assigneeId: null,
    values: {
      Topic: null,
      Status: null,
      Posted: null,
      Channel: null,
      ...values,
    },
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

const fixture = [
  row("r1", "Fleet one", {
    Topic: "Fleet",
    Posted: "2026-10-06",
    Channel: "LinkedIn",
  }),
  row("r2", "Cyber one", {
    Topic: "Cyber",
    Posted: "2026-09-12",
    Channel: "Site",
  }),
  row("r3", "Cyber two", {
    Topic: "Cyber",
    Posted: "2026-10-01",
    Channel: "LinkedIn",
  }),
  row("r4", "Loose one", { Posted: null }),
];

const getTableRows = vi.fn(
  async (_projectId: string, query: TableRowsQuery) => {
    let rows = fixture.filter((r) =>
      Object.entries(query.filters).every(([id, options]) => {
        const column = table.columns.find((c) => c.id === id);
        return column && options.includes(r.values[column.name] as string);
      }),
    );
    if (query.sort === "date") {
      const key = (r: TableRow) => (r.values.Posted as string | null) ?? "";
      rows = [
        ...rows.filter((r) => !r.values.Posted),
        ...rows
          .filter((r) => r.values.Posted)
          .sort((a, b) => key(b).localeCompare(key(a))),
      ];
    }
    return {
      rows,
      nextCursor: null,
      total: rows.length,
      entries: fixture.length,
    };
  },
);
const searchTableRows = vi.fn(async () => ({
  rows: [{ ...row("far", "Ancient MFA tip", {}), tableName: "Risk tips" }],
  nextCursor: null,
}));

vi.mock("@/hooks/queries/operon-tables/use-get-table", () => ({
  default: () => ({ data: table, isLoading: false }),
}));
vi.mock("@/fetchers/operon-tables/get-table-rows", () => ({
  getTableRows: (...args: Parameters<typeof getTableRows>) =>
    getTableRows(...args),
}));
vi.mock("@/fetchers/operon-tables/search-table-rows", () => ({
  searchTableRows: (...args: unknown[]) =>
    (searchTableRows as (...a: unknown[]) => unknown)(...args),
}));

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/components/operon-tables/create-table-modal", () => ({
  default: () => null,
}));
const summary = {
  tables: [
    {
      tableId: "t1",
      name: "Risk tips",
      entries: 42,
      group: {
        fieldId: "topic",
        name: "Topic",
        isTemplateTopic: true,
        options: 7,
        counts: [],
      },
      status: [
        { option: "Idea", count: 1 },
        { option: "In progress", count: 3 },
        { option: "Published", count: 38 },
      ],
      lastAdded: { at: new Date().toISOString(), by: "Dana" },
    },
  ],
  nextCursor: null,
  recent: [
    {
      rowId: "row-9",
      tableId: "t1",
      tableName: "Risk tips",
      title: "MFA for contractors",
      madeBy: "Dana",
      createdAt: "2026-10-06T10:00:00Z",
    },
  ],
};
vi.mock("@/hooks/queries/operon-tables/use-tables-summary", () => ({
  default: () => ({ data: summary }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onOpenRow = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TableView
        projectId="p1"
        workspaceId="w1"
        isAdmin={true}
        onOpenRow={onOpenRow}
        onAddEntry={vi.fn()}
        onOpenColumns={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { onOpenRow };
}

/** The column-menu triggers, by their visible text, in document order. */
function menuButtons() {
  return screen
    .queryAllByRole("button")
    .filter((b) => b.getAttribute("aria-haspopup") === "menu")
    .map((b) => b.textContent);
}

function menuButton(name: string | RegExp) {
  return screen.getByRole("button", { name });
}

/** Opens a column menu and ticks the options in one opening (the menu stays open). */
async function tick(menu: string | RegExp, ...options: string[]) {
  fireEvent.click(menuButton(menu));
  for (const option of options) {
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: option }),
    );
  }
}

function lastQuery() {
  return getTableRows.mock.calls.at(-1)?.[1];
}

function expectNoYear() {
  expect(screen.queryByText(/Year/)).toBeNull();
  expect(screen.queryByRole("group", { name: "Year" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Year/ })).toBeNull();
}

function sectionTitles() {
  return screen
    .getAllByTestId("table-section")
    .map((s) => s.getAttribute("aria-label"));
}

describe("Table view", () => {
  it("groups by topic in option order with counts and a final No topic section", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    expect(screen.getByTestId("table-header").textContent).toBe(
      "Risk tips · 4 entries · 3 topics",
    );
    expect(sectionTitles()).toEqual(["Cyber", "Fleet", "No topic"]);
    const cyber = screen.getAllByTestId("table-section")[0] as HTMLElement;
    expect(within(cyber).getAllByTestId("table-row")).toHaveLength(2);
    expect(within(cyber).getByText("2")).toBeTruthy();

    // Collapse and expand.
    fireEvent.click(within(cyber).getByRole("button", { expanded: true }));
    expect(within(cyber).queryAllByTestId("table-row")).toHaveLength(0);
    fireEvent.click(within(cyber).getByRole("button", { expanded: false }));
    expect(within(cyber).getAllByTestId("table-row")).toHaveLength(2);

    expect(getTableRows).toHaveBeenLastCalledWith(
      "p1",
      { sort: "created", filters: {} },
      null,
    );
  });

  it("stripes rows as Operon does (bg-row-alt, first row tinted), never the group headers", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    const cyber = screen.getAllByTestId("table-section")[0] as HTMLElement;
    const [first, second] = within(cyber).getAllByTestId("table-row");
    expect(first.className).toContain("bg-row-alt");
    expect(second.className).not.toContain("bg-row-alt");
    expect(
      within(cyber).getByRole("button", { expanded: true }).className,
    ).not.toContain("bg-row-alt");
  });

  it("sorts by date: No date on top, months newest first, the topic becomes a menu", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    expect(screen.queryByRole("button", { name: "Topic" })).toBeNull();
    fireEvent.click(screen.getByText("Sort by date"));
    await waitFor(() =>
      expect(sectionTitles()).toEqual([
        "No date",
        "October 2026",
        "September 2026",
      ]),
    );
    expect(getTableRows).toHaveBeenLastCalledWith(
      "p1",
      { sort: "date", filters: {} },
      null,
    );
    expect(menuButtons()).toEqual(["Status", "Topic", "Channel"]);
    expectNoYear();
    await tick("Topic", "Cyber");
    await waitFor(() =>
      expect(getTableRows).toHaveBeenLastCalledWith(
        "p1",
        { sort: "date", filters: { topic: ["Cyber"] } },
        null,
      ),
    );
  });

  it("narrows by the Status and Channel menus through the rows request", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    expect(menuButtons()).toEqual(["Status", "Channel"]);
    expectNoYear();
    await tick("Channel", "LinkedIn");
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(2),
    );
    expect(screen.queryByText("Cyber one")).toBeNull();
    expect(getTableRows).toHaveBeenLastCalledWith(
      "p1",
      { sort: "created", filters: { channel: ["LinkedIn"] } },
      null,
    );
  });

  it("ticks several options in one opening: OR within a column", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    await tick("Channel", "LinkedIn", "Site");
    await waitFor(() =>
      expect(lastQuery()).toEqual({
        sort: "created",
        filters: { channel: ["LinkedIn", "Site"] },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByTestId("table-row").map((r) => r.textContent),
      ).toHaveLength(3),
    );
    for (const title of ["Fleet one", "Cyber one", "Cyber two"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.queryByText("Loose one")).toBeNull();
  });

  it("ANDs across columns", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    fireEvent.click(screen.getByText("Sort by date"));
    await tick("Channel", "LinkedIn");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await tick("Topic", "Cyber");
    await waitFor(() =>
      expect(lastQuery()).toEqual({
        sort: "date",
        filters: { channel: ["LinkedIn"], topic: ["Cyber"] },
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(1),
    );
    expect(screen.getByText("Cyber two")).toBeTruthy();
  });

  it("labels the button with the chosen values in option order, +n past two", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    await tick("Status", "Published", "Idea");
    expect(menuButtons()[0]).toBe("Status: Idea, Published");
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "In progress" }),
    );
    expect(menuButtons()[0]).toBe("Status: Idea, In progress +1");
    expect(
      screen.getByRole("button", {
        name: "Status: Idea, In progress +1 (selected: Idea, In progress, Published)",
      }),
    ).toBeTruthy();
  });

  it("clears one column from its menu's first item", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    await tick("Channel", "LinkedIn");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("menuitemcheckbox")).toBeNull(),
    );
    fireEvent.click(menuButton("Channel: LinkedIn"));
    const menu = await screen.findByRole("menu");
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemcheckbox"]',
      ),
    );
    expect(items[0].textContent).toBe("Clear");
    expect(items[0].getAttribute("role")).toBe("menuitem");
    fireEvent.click(items[0]);
    await waitFor(() =>
      expect(lastQuery()).toEqual({ sort: "created", filters: {} }),
    );
    expect(menuButtons()).toEqual(["Status", "Channel"]);
    await waitFor(() =>
      expect(screen.queryByRole("menuitemcheckbox")).toBeNull(),
    );
    fireEvent.click(menuButton("Channel"));
    await screen.findAllByRole("menuitemcheckbox");
    expect(screen.queryByRole("menuitem", { name: "Clear" })).toBeNull();
  });

  it("offers Clear filters only while a choice is active, and it clears every column", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    await tick("Status", "Idea");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("menuitemcheckbox")).toBeNull(),
    );
    await tick("Channel", "Site");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(lastQuery()).toEqual({
        sort: "created",
        filters: { status: ["Idea"], channel: ["Site"] },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(lastQuery()).toEqual({ sort: "created", filters: {} }),
    );
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    expect(menuButtons()).toEqual(["Status", "Channel"]);
  });

  it("keeps a hidden group-column choice in state but does not send it while grouped", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    fireEvent.click(screen.getByText("Sort by date"));
    await tick("Topic", "Cyber");
    await waitFor(() =>
      expect(lastQuery()).toEqual({
        sort: "date",
        filters: { topic: ["Cyber"] },
      }),
    );
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    fireEvent.click(screen.getByText("Group by topic"));
    await waitFor(() =>
      expect(lastQuery()).toEqual({ sort: "created", filters: {} }),
    );
    fireEvent.click(screen.getByText("Sort by date"));
    await waitFor(() =>
      expect(lastQuery()).toEqual({
        sort: "date",
        filters: { topic: ["Cyber"] },
      }),
    );
  });

  it("searches on the server and finds a row the loaded pages do not hold", async () => {
    const { onOpenRow } = renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    fireEvent.change(screen.getByPlaceholderText("Search risk tips"), {
      target: { value: "MFA" },
    });
    await waitFor(() =>
      expect(screen.getByText("Ancient MFA tip")).toBeTruthy(),
    );
    expect(searchTableRows).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", tableId: "p1", q: "MFA" }),
    );
    expect(screen.queryByText("Fleet one")).toBeNull();
    fireEvent.click(screen.getByText("Ancient MFA tip"));
    expect(onOpenRow).toHaveBeenCalledWith("far");

    fireEvent.change(screen.getByPlaceholderText("Search risk tips"), {
      target: { value: "" },
    });
    await waitFor(() => expect(screen.getByText("Fleet one")).toBeTruthy());
    expect(sectionTitles()).toEqual(["Cyber", "Fleet", "No topic"]);
  });
});

describe("Tables section lines", () => {
  const base: TableSummary = {
    tableId: "t",
    name: "Risk tips",
    entries: 42,
    group: {
      fieldId: "topic",
      name: "Topic",
      isTemplateTopic: true,
      options: 7,
      counts: [],
    },
    status: [
      { option: "Idea", count: 1 },
      { option: "In progress", count: 3 },
      { option: "Published", count: 38 },
    ],
    lastAdded: null,
  };

  it("renders the topic count and the status counts", () => {
    expect(groupLine(base)).toBe("7 topics");
    expect(statusLine(base)).toBe("38 published · 3 in progress · 1 idea");
  });

  it("renders per-group counts when the group column is not the template Topic", () => {
    expect(
      groupLine({
        ...base,
        group: {
          fieldId: "q",
          name: "Quarter",
          isTemplateTopic: false,
          options: 3,
          counts: [
            { option: "Q4 2026", count: 5 },
            { option: "Q1 2027", count: 6 },
            { option: "Q2 2027", count: 0 },
          ],
        },
      }),
    ).toBe("Q4 2026: 5 · Q1 2027: 6");
  });
});

describe("Tables section", () => {
  it("renders the cards, the admin New table card and Recently added", () => {
    render(<TablesSection workspaceId="w1" isAdmin={true} />);
    const card = screen.getByTestId("table-card");
    expect(card.textContent).toContain("Risk tips");
    expect(card.textContent).toContain("42 entries · 7 topics");
    expect(card.textContent).toContain("38 published · 3 in progress · 1 idea");
    expect(card.textContent).toMatch(/Last added .* by Dana/);
    expect(screen.getByText("New table")).toBeTruthy();
    expect(
      screen.getByText("Starts from the Marketing asset columns"),
    ).toBeTruthy();
    expect(screen.getByText("Recently added")).toBeTruthy();
    fireEvent.click(screen.getByText("MFA for contractors"));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { workspaceId: "w1", projectId: "t1" },
        search: { taskId: "row-9" },
      }),
    );
  });

  it("offers no New table card to a member", () => {
    render(<TablesSection workspaceId="w1" isAdmin={false} />);
    expect(screen.queryByText("New table")).toBeNull();
  });
});

/**
 * Tables task 15 (spec 7.11, US8; journey 8): the same list at 375px — "By topic | By
 * date", the column menus folded behind "Filters · n" (tables-filter-bar §7.2), two-line
 * rows, no column header, nothing wider than the screen. The layout's bar carries the name and "+".
 */
describe("Table view on a phone (375px)", () => {
  const desktopWidth = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: desktopWidth,
    });
  });
  function atPhoneWidth() {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 375,
    });
  }

  it("reads By topic | By date, folds the filters and drops the desktop header row", async () => {
    atPhoneWidth();
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    expect(screen.getByRole("button", { name: "By topic" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "By date" })).toBeTruthy();
    expect(screen.queryByText("Group by topic")).toBeNull();
    // Name and "+" live in the phone bar (project-layout); none of these here.
    expect(screen.queryByTestId("table-header")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add entry" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Columns/ })).toBeNull();
    // The column menus fold behind "Filters", folded on mount.
    expect(screen.queryByTestId("chip-row-inline")).toBeNull();
    const filters = screen.getByRole("button", { name: "Filters" });
    expect(filters.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Status" })).toBeNull();
    expect(screen.queryByTestId("filters-panel")).toBeNull();
    expect(screen.getByPlaceholderText("Search risk tips")).toBeTruthy();
  });

  it("opens the Filters panel, counts ticked options live and keeps Clear filters last", async () => {
    atPhoneWidth();
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const panel = screen.getByTestId("filters-panel");
    expect(
      screen
        .getByRole("button", { name: "Filters" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(menuButtons()).toEqual(["Status", "Channel"]);
    expectNoYear();
    await tick("Status", "Idea", "Published");
    // The menu is still open and the count already reads 2.
    expect(screen.getByRole("menuitemcheckbox", { name: "Idea" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filters · 2" })).toBeTruthy();
    const clear = within(panel).getByRole("button", { name: "Clear filters" });
    // Clear filters is the panel's last element, in its own full-width child.
    const wrapper = clear.parentElement as HTMLElement;
    expect(wrapper.className).toContain("w-full");
    expect(wrapper.parentElement?.lastElementChild).toBe(wrapper);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("menuitemcheckbox")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters · 2" }));
    expect(screen.queryByTestId("filters-panel")).toBeNull();
    expect(screen.getByRole("button", { name: "Filters · 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Filters · 2" }));
    expect(screen.getByTestId("filters-panel")).toBeTruthy();
    expectNoYear();
  });

  it("draws two-line rows and never scrolls sideways", async () => {
    atPhoneWidth();
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    const fleet = screen
      .getAllByTestId("table-row")
      .find((r) => r.textContent?.startsWith("Fleet one")) as HTMLElement;
    expect(fleet.children).toHaveLength(2);
    expect(fleet.children[1].textContent).toBe("6 Oct · LinkedIn · Dana");
    const list = screen.getByTestId("table-list");
    expect(list.className).toContain("overflow-x-hidden");
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
    expect(screen.queryByText("Made by")).toBeNull();
  });

  it("By date switches to month headers, as Sort by date does on desktop", async () => {
    atPhoneWidth();
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    fireEvent.click(screen.getByRole("button", { name: "By date" }));
    await waitFor(() => expect(sectionTitles()[0]).toBe("No date"));
  });
});

describe("tableRowsSearch", () => {
  it("sends one filter per ticked option and no year", async () => {
    const { tableRowsSearch } = await vi.importActual<
      typeof import("@/fetchers/operon-tables/get-table-rows")
    >("@/fetchers/operon-tables/get-table-rows");
    const search = tableRowsSearch({
      sort: "date",
      filters: { status: ["Idea", "Published"] },
    });
    expect(search).toContain("filter=status%3AIdea&filter=status%3APublished");
    expect(search).not.toContain("year");
  });
});
