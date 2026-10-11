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
 * sorts by date under month headers with "No date" on top, sends its sort and chips to the
 * rows route, and searches on the server (a row the loaded pages do not hold is found).
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
      Object.entries(query.filters).every(([id, option]) => {
        const column = table.columns.find((c) => c.id === id);
        return column && r.values[column.name] === option;
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
      { sort: "created", filters: {}, year: null },
      null,
    );
  });

  it("sorts by date: No date on top, months newest first, the topic becomes a chip", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    expect(screen.queryByRole("group", { name: "Topic" })).toBeNull();
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
      { sort: "date", filters: {}, year: null },
      null,
    );
    const topicChips = screen.getByRole("group", { name: "Topic" });
    fireEvent.click(within(topicChips).getByText("Cyber"));
    await waitFor(() =>
      expect(getTableRows).toHaveBeenLastCalledWith(
        "p1",
        { sort: "date", filters: { topic: "Cyber" }, year: null },
        null,
      ),
    );
  });

  it("narrows by the Status, Year and Channel chips through the rows request", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(4),
    );
    const groups = screen
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Status", "Channel", "Year"]);
    fireEvent.click(
      within(screen.getByRole("group", { name: "Channel" })).getByText(
        "LinkedIn",
      ),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("table-row")).toHaveLength(2),
    );
    expect(screen.queryByText("Cyber one")).toBeNull();
    fireEvent.click(
      within(screen.getByRole("group", { name: "Year" })).getByText("2026"),
    );
    await waitFor(() =>
      expect(getTableRows).toHaveBeenLastCalledWith(
        "p1",
        { sort: "created", filters: { channel: "LinkedIn" }, year: 2026 },
        null,
      ),
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
