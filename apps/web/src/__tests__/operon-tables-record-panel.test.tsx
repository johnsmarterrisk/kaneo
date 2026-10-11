import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TaskDetailsSheet from "@/components/task/task-details-sheet";
import type { TableRow } from "@/fetchers/operon-tables/get-table-rows";

/**
 * Operon fork check (Tables task 9, docs/fork-discipline.md row 18, spec 7.10 US3 / R-E):
 * the task details sheet opens a table entry in the record panel — Made by read-only, the
 * Last change line updated by a save, Topic's options first and "New topic…" last for an
 * admin only, Delete confirmed — and never renders comments, relations or subtasks, even
 * when the row read carries them.
 */
const permission = { isAdmin: true };
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
      options: ["Cyber", "Fleet"],
      position: 1,
    },
    {
      id: "status",
      name: "Status",
      kind: "dropdown",
      required: false,
      options: ["Idea", "Published"],
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
  ],
};

const baseRow: TableRow & Record<string, unknown> = {
  rowId: "r1",
  tableId: "p1",
  title: "MFA tip",
  notes: "Turn on MFA",
  assigneeId: null,
  values: { Topic: "Cyber", Status: "Idea", Posted: "2026-10-06" },
  madeBy: { id: "u1", name: "Dana" },
  createdAt: "2026-10-06T14:05:00Z",
  lastChange: {
    by: { id: "u1", name: "Dana" },
    at: "2026-10-06T14:05:00Z",
    columns: ["Title", "Topic", "Status"],
    summary: "changed 3 columns",
  },
  url: "",
  // Dirty data the panel must ignore (R-E).
  comments: [{ id: "c1", content: "a stray comment" }],
  relations: [{ id: "rel1", title: "a stray relation" }],
  subtasks: [{ id: "s1", title: "a stray subtask" }],
};

const getTableRow = vi.fn(async () => ({
  row: baseRow,
  table: {
    tableId: "p1",
    name: "Risk tips",
    groupColumn: "Topic",
    statusColumn: "Status",
    dateColumn: "Posted",
  },
}));
const updateTableRow = vi.fn(
  async (
    _p: string,
    _t: string,
    write: { values: Record<string, unknown> },
  ) => ({
    row: {
      ...baseRow,
      values: { ...baseRow.values, ...write.values },
      lastChange: {
        by: { id: "u2", name: "Sam" },
        at: "2026-10-07T09:00:00Z",
        columns: ["Status"],
        summary: "set Status to Published",
      },
    },
    unchanged: false,
  }),
);
const addTableRow = vi.fn(async () => ({ row: { ...baseRow, rowId: "r2" } }));
const deleteTableRow = vi.fn(async () => undefined);

vi.mock("@/fetchers/operon-tables/table-row", () => ({
  getTableRow: () => getTableRow(),
  updateTableRow: (...a: Parameters<typeof updateTableRow>) =>
    updateTableRow(...a),
  addTableRow: (...a: unknown[]) =>
    (addTableRow as (...b: unknown[]) => unknown)(...a),
  deleteTableRow: (...a: unknown[]) =>
    (deleteTableRow as (...b: unknown[]) => unknown)(...a),
}));
vi.mock("@/hooks/queries/operon-tables/use-get-table", () => ({
  default: () => ({ data: table, isLoading: false }),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => permission,
}));
vi.mock("@/components/task/task-description-editor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <textarea
      aria-label="Notes"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  permission.isAdmin = true;
  vi.clearAllMocks();
});

function renderSheet(taskId = "r1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TaskDetailsSheet
        taskId={taskId}
        projectId="p1"
        workspaceId="w1"
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

function topicOptions() {
  const select = screen.getByLabelText("Topic") as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.textContent);
}

describe("Record panel", () => {
  it("shows the entry's columns, Made by read-only, Last change and the ledger line", async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByText("Edit entry")).toBeTruthy());
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "MFA tip",
    );
    expect(screen.getByTestId("made-by").textContent).toMatch(
      /^Made by Dana · 6 Oct 2026, \d\d:05$/,
    );
    // Made by is text, never an input.
    expect(screen.queryByLabelText("Made by")).toBeNull();
    expect(screen.getByTestId("last-change").textContent).toBe(
      "Last change Dana changed 3 columns",
    );
    expect(
      screen.getByText("Ledger: every change is a Proof-of-Work signal"),
    ).toBeTruthy();
    for (const stray of [
      "a stray comment",
      "a stray relation",
      "a stray subtask",
      "Comments",
      "Subtasks",
      "Relations",
    ]) {
      expect(screen.queryByText(stray)).toBeNull();
    }
  });

  it("updates Last change after a save through the row route", async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByText("Edit entry")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "Published" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(screen.getByTestId("last-change").textContent).toBe(
        "Last change Sam set Status to Published",
      ),
    );
    expect(updateTableRow).toHaveBeenCalledWith(
      "p1",
      "r1",
      expect.objectContaining({
        title: "MFA tip",
        values: { Topic: "Cyber", Status: "Published", Posted: "2026-10-06" },
      }),
    );
  });

  it("offers Topic's options first and New topic… last to an admin only", async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByText("Edit entry")).toBeTruthy());
    expect(topicOptions()).toEqual(["—", "Cyber", "Fleet", "New topic…"]);
    // Status (not the group column) never offers it.
    const status = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(Array.from(status.options).map((o) => o.textContent)).not.toContain(
      "New topic…",
    );
    cleanup();
    permission.isAdmin = false;
    renderSheet();
    await waitFor(() => expect(screen.getByText("Edit entry")).toBeTruthy());
    expect(topicOptions()).toEqual(["—", "Cyber", "Fleet"]);
  });

  it("sends a New topic… save as the value and the new option together", async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByText("Edit entry")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Topic"), {
      target: { value: "__new_topic__" },
    });
    fireEvent.change(screen.getByLabelText("New topic name"), {
      target: { value: "Fraud" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateTableRow).toHaveBeenCalled());
    expect(updateTableRow.mock.calls[0]?.[2]).toMatchObject({
      values: { Topic: "Fraud" },
      newTopic: { fieldId: "topic", label: "Fraud" },
    });
  });

  it("asks to confirm before deleting", async () => {
    const { onClose } = renderSheet();
    await waitFor(() => expect(screen.getByText("Edit entry")).toBeTruthy());
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() =>
      expect(screen.getByText("Delete this entry?")).toBeTruthy(),
    );
    expect(deleteTableRow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Delete entry"));
    await waitFor(() =>
      expect(deleteTableRow).toHaveBeenCalledWith("p1", "r1"),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("opens an empty entry for Add entry and adds it with a request id", async () => {
    const { onClose } = renderSheet("new");
    await waitFor(() => expect(screen.getByText("Edit entry")).toBeTruthy());
    expect(getTableRow).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete")).toBeNull();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "New tip" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(addTableRow).toHaveBeenCalled());
    const [projectId, requestId, write] = addTableRow.mock
      .calls[0] as unknown as [string, string, { title: string }];
    expect(projectId).toBe("p1");
    expect(requestId).toMatch(/\S{8,}/);
    expect(write.title).toBe("New tip");
    expect(onClose).toHaveBeenCalled();
  });
});
