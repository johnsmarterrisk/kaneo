import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operon fork check (John's ruling 2026-10-11, Tables spec section 15; docs/fork-discipline.md
 * row 18): the Tables page at `/dashboard/workspace/$workspaceId/tables`. It shows the table
 * cards with their counts, the "New table" card to admins only, "Recently added", "No tables
 * yet" to a member of a workspace without tables, and a search across every table whose
 * results (table name, title, status, date) open the row's record panel.
 */

const state = vi.hoisted(() => ({
  isAdmin: true,
  summary: null as unknown,
  isError: false,
  refetch: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    ...(options as Record<string, unknown>),
    useParams: () => ({ workspaceId: "w1" }),
  }),
  useNavigate: () => state.navigate,
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ isAdmin: state.isAdmin }),
}));
vi.mock("@/hooks/queries/operon-tables/use-tables-summary", () => ({
  default: () => ({
    data: state.isError ? undefined : state.summary,
    isLoading: false,
    isError: state.isError,
    refetch: state.refetch,
  }),
}));
vi.mock("@/components/common/workspace-layout", () => ({
  default: ({ title, children }: { title: string; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));
vi.mock("@/components/page-title", () => ({ default: () => null }));
vi.mock("@/components/operon-tables/create-table-modal", () => ({
  default: () => null,
}));

const searchTableRows = vi.fn();
vi.mock("@/fetchers/operon-tables/search-table-rows", () => ({
  searchTableRows: (...args: unknown[]) => searchTableRows(...args),
}));
const getTable = vi.fn();
vi.mock("@/fetchers/operon-tables/get-table", () => ({
  getTable: (...args: unknown[]) => getTable(...args),
}));

const { Route } = await import(
  "@/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/tables"
);
const TablesPage = (Route as unknown as { component: () => ReactNode })
  .component;

const SUMMARY = {
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
        { option: "Published", count: 38 },
      ],
      lastAdded: null,
    },
    {
      tableId: "t2",
      name: "Roadmap",
      entries: 3,
      group: null,
      status: [],
      lastAdded: null,
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

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TablesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.isAdmin = true;
  state.summary = SUMMARY;
  state.navigate.mockClear();
  state.isError = false;
  state.refetch.mockClear();
  searchTableRows.mockReset();
  getTable.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("The Tables page", () => {
  it("is titled Tables and shows a card per table with its counts, then Recently added", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Tables" })).toBeTruthy();
    const cards = screen.getAllByTestId("table-card");
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Risk tips42 entries · 7 topics"),
      expect.stringContaining("Roadmap3 entries"),
    ]);
    expect(cards[0].textContent).toContain("38 published · 1 idea");
    expect(screen.getByText("Recently added")).toBeTruthy();
    fireEvent.click(cards[1]);
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/dashboard/workspace/$workspaceId/project/$projectId/table",
        params: { workspaceId: "w1", projectId: "t2" },
      }),
    );
  });

  it("offers New table to an admin and not to a member", () => {
    renderPage();
    expect(screen.getByText("New table")).toBeTruthy();
    cleanup();
    state.isAdmin = false;
    renderPage();
    expect(screen.queryByText("New table")).toBeNull();
    expect(screen.queryByText("No tables yet")).toBeNull();
  });

  it("empty: a member sees No tables yet, an admin sees New table", () => {
    state.summary = { tables: [], nextCursor: null, recent: [] };
    state.isAdmin = false;
    renderPage();
    expect(screen.getByText("No tables yet")).toBeTruthy();
    expect(screen.queryByText("New table")).toBeNull();
    cleanup();
    state.isAdmin = true;
    renderPage();
    expect(screen.getByText("New table")).toBeTruthy();
    expect(screen.queryByText("No tables yet")).toBeNull();
  });

  it("a failed or forbidden summary shows the error and Retry, never No tables yet or New table (Codex round 1, finding 3)", () => {
    state.isError = true;
    state.isAdmin = false;
    renderPage();
    expect(screen.getByText("Tables could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("No tables yet")).toBeNull();
    cleanup();
    state.isAdmin = true;
    renderPage();
    expect(screen.getByText("Tables could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("New table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refetch).toHaveBeenCalled();
  });

  it("searches every table on the server and lists table name, title, status and date; a row opens its record", async () => {
    searchTableRows.mockResolvedValue({
      rows: [
        {
          rowId: "r1",
          tableId: "t1",
          tableName: "Risk tips",
          title: "Phishing drill recap",
          notes: "",
          assigneeId: null,
          values: { Status: "Published", Posted: "2026-10-06" },
          madeBy: { id: null, name: "Dana" },
          createdAt: "2026-09-01T10:00:00Z",
          lastChange: {
            by: { id: null, name: null },
            at: null,
            columns: [],
            summary: null,
          },
          url: "",
        },
        {
          rowId: "r2",
          tableId: "t2",
          tableName: "Roadmap",
          title: "Phishing training rollout",
          notes: "",
          assigneeId: null,
          values: { State: "Planned" },
          madeBy: { id: null, name: null },
          createdAt: "2026-08-15T10:00:00Z",
          lastChange: {
            by: { id: null, name: null },
            at: null,
            columns: [],
            summary: null,
          },
          url: "",
        },
      ],
      nextCursor: null,
    });
    getTable.mockImplementation(async (id: string) =>
      id === "t1"
        ? {
            projectId: "t1",
            name: "Risk tips",
            isTable: true,
            groupFieldId: null,
            dateFieldId: "posted",
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
              {
                id: "posted",
                name: "Posted",
                kind: "date",
                required: false,
                options: null,
                position: 2,
              },
            ],
          }
        : {
            projectId: "t2",
            name: "Roadmap",
            isTable: true,
            groupFieldId: null,
            dateFieldId: null,
            statusFieldId: "state",
            columns: [
              {
                id: "state",
                name: "State",
                kind: "dropdown",
                required: false,
                options: ["Planned"],
                position: 1,
              },
            ],
          },
    );
    renderPage();
    fireEvent.change(screen.getByPlaceholderText("Search all tables"), {
      target: { value: "phishing" },
    });
    const results = await screen.findByTestId("tables-search-results");
    expect(searchTableRows).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", q: "phishing" }),
    );
    // Not scoped to one table: the cross-table search.
    expect(searchTableRows.mock.calls[0][0].tableId).toBeUndefined();
    // The results replace the cards while the box holds text.
    expect(screen.queryAllByTestId("table-card")).toHaveLength(0);
    await waitFor(() =>
      expect(within(results).getByText("Published")).toBeTruthy(),
    );
    const rows = within(results).getAllByTestId("tables-search-row");
    expect(rows[0].textContent).toBe(
      "Risk tipsPhishing drill recapPublished6 Oct 2026",
    );
    // A table without a date column shows the row's creation date; its status column is its own.
    await waitFor(() => expect(rows[1].textContent).toContain("Planned"));
    expect(rows[1].textContent).toMatch(
      /^RoadmapPhishing training rolloutPlanned.*2026$/,
    );
    fireEvent.click(rows[1]);
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { workspaceId: "w1", projectId: "t2" },
        search: { taskId: "r2" },
      }),
    );
    // Clearing the box restores the cards.
    fireEvent.change(screen.getByPlaceholderText("Search all tables"), {
      target: { value: "" },
    });
    expect(screen.getAllByTestId("table-card")).toHaveLength(2);
  });
});
