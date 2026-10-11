import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ColumnsPage, {
  looksLike,
} from "@/components/operon-tables/columns-page";

/**
 * Operon fork check (Tables task 10, docs/fork-discipline.md row 18, spec 7.10 US6): the
 * Columns page — admins add, reorder and hide columns, rename and merge topics, and read a
 * hidden column's history; a member sees "Admins only." and no controls.
 */
const permission = { isAdmin: true };
const create = vi.fn(async () => ({}));
const hide = vi.fn(async () => ({}));
const reorder = vi.fn(async () => ({}));
const editOptions = vi.fn(async () => ({ rowsRewritten: 2 }));
const settings = vi.fn(async () => ({}));

const table = {
  projectId: "p1",
  name: "Risk tips",
  isTable: true,
  groupFieldId: "topic",
  dateFieldId: "posted",
  statusFieldId: "status",
  columns: [
    {
      id: "topic",
      name: "Topic",
      kind: "dropdown",
      required: false,
      options: ["Cyber", "Cybersecurity", "Fraud"],
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
  hiddenColumns: [
    {
      id: "series",
      name: "Series",
      kind: "text",
      hiddenAt: "2026-10-10T00:00:00Z",
    },
  ],
};

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => permission,
}));
vi.mock("@/hooks/queries/operon-tables/use-get-table", () => ({
  default: () => ({ data: table, isLoading: false }),
}));
vi.mock(
  "@/hooks/queries/custom-field/use-get-custom-field-values-by-project",
  () => ({
    default: () => ({
      data: [
        { fieldId: "topic", value: "Cyber" },
        { fieldId: "topic", value: "Cyber" },
        { fieldId: "topic", value: "Fraud" },
        { fieldId: "status", value: "Idea" },
      ],
    }),
  }),
);
vi.mock("@/hooks/queries/operon-tables/use-get-column-history", () => ({
  default: (_p: string, fieldId: string | null) => ({
    data: fieldId
      ? {
          field: { id: fieldId, name: "Series", kind: "text", hidden: true },
          current: [{ rowId: "r1", title: "Phishing tip", value: "Summer" }],
          history: [
            {
              rowId: "r1",
              oldValue: "Spring",
              newValue: "Summer",
              reason: "save",
              at: "2026-10-09T00:00:00Z",
            },
          ],
          nextCursor: null,
        }
      : undefined,
    isLoading: false,
  }),
}));
vi.mock("@/hooks/mutations/custom-field/use-create-custom-field", () => ({
  default: () => ({ mutateAsync: create }),
}));
vi.mock("@/hooks/mutations/custom-field/use-delete-custom-field", () => ({
  default: () => ({ mutateAsync: hide }),
}));
vi.mock("@/hooks/mutations/custom-field/use-reorder-custom-field", () => ({
  useReorderCustomFields: () => ({ mutateAsync: reorder }),
}));
vi.mock("@/hooks/mutations/operon-tables/use-edit-options", () => ({
  default: () => ({ mutateAsync: editOptions }),
}));
vi.mock("@/hooks/mutations/operon-tables/use-update-table-settings", () => ({
  default: () => ({ mutateAsync: settings }),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  permission.isAdmin = true;
  vi.clearAllMocks();
});

describe("Columns page", () => {
  it("lists the template rows and the columns with their kind labels", () => {
    render(<ColumnsPage projectId="p1" />);
    expect(screen.getByText("Risk tips · Columns")).toBeTruthy();
    expect(
      screen.getByText("Started from the Marketing asset columns"),
    ).toBeTruthy();
    expect(screen.getAllByText("Template")).toHaveLength(2);
    expect(screen.getByText("set automatically · Always")).toBeTruthy();
    expect(screen.getAllByText("Choice").length).toBeGreaterThan(0);
  });

  it("adds, reorders and hides a column for an admin", async () => {
    render(<ColumnsPage projectId="p1" />);
    fireEvent.change(screen.getByLabelText("New column name"), {
      target: { value: "Channel" },
    });
    fireEvent.change(screen.getByLabelText("New column kind"), {
      target: { value: "dropdown" },
    });
    fireEvent.change(screen.getByLabelText("Options"), {
      target: { value: "LinkedIn, Site" },
    });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          name: "Channel",
          type: "dropdown",
          options: ["LinkedIn", "Site"],
        }),
      ),
    );

    fireEvent.click(screen.getByLabelText("Move Status up"));
    await waitFor(() =>
      expect(reorder).toHaveBeenCalledWith({
        projectId: "p1",
        fields: [
          { id: "status", position: 1 },
          { id: "topic", position: 2 },
          { id: "posted", position: 3 },
        ],
      }),
    );

    fireEvent.click(screen.getByLabelText("Hide Posted"));
    await waitFor(() => expect(hide).toHaveBeenCalledWith({ id: "posted" }));
  });

  it("shows topics with counts, the looks-like hint, rename and merge", async () => {
    render(<ColumnsPage projectId="p1" />);
    expect(screen.getByText("Topics in this table")).toBeTruthy();
    const cyber = screen.getAllByText("Cyber")[0].closest("li") as HTMLElement;
    expect(cyber.textContent).toContain("2");
    expect(cyber.textContent).toContain("looks like Cybersecurity");
    fireEvent.change(screen.getByLabelText("Merge Cybersecurity into"), {
      target: { value: "Cyber" },
    });
    await waitFor(() =>
      expect(editOptions).toHaveBeenCalledWith({
        projectId: "p1",
        fieldId: "topic",
        edit: { action: "merge", from: "Cybersecurity", into: "Cyber" },
      }),
    );
    fireEvent.click(screen.getAllByText("Rename")[2]);
    fireEvent.change(screen.getByLabelText("New name for Fraud"), {
      target: { value: "Fraud risk" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(editOptions).toHaveBeenCalledWith({
        projectId: "p1",
        fieldId: "topic",
        edit: { action: "rename", from: "Fraud", to: "Fraud risk" },
      }),
    );
  });

  it("lists Series under Hidden columns with its history", () => {
    render(<ColumnsPage projectId="p1" />);
    expect(screen.getByText("Hidden columns")).toBeTruthy();
    expect(screen.getByText("Series")).toBeTruthy();
    fireEvent.click(screen.getByText("View history"));
    expect(screen.getByText("Phishing tip: Summer")).toBeTruthy();
    expect(screen.getByText(/Spring → Summer/)).toBeTruthy();
  });

  it("changes the group column through the settings route", async () => {
    render(<ColumnsPage projectId="p1" />);
    fireEvent.change(screen.getByLabelText("Group by"), {
      target: { value: "status" },
    });
    await waitFor(() =>
      expect(settings).toHaveBeenCalledWith({
        projectId: "p1",
        settings: { groupFieldId: "status" },
      }),
    );
  });

  it("shows a member Admins only. and no controls", () => {
    permission.isAdmin = false;
    render(<ColumnsPage projectId="p1" />);
    expect(screen.getByText("Admins only.")).toBeTruthy();
    expect(screen.queryByText("Hide")).toBeNull();
    expect(screen.queryByText("Add")).toBeNull();
    expect(screen.queryByText("Rename")).toBeNull();
    expect(screen.queryByText("Hidden columns")).toBeNull();
    expect(screen.queryByLabelText("Group by")).toBeNull();
  });

  it("finds look-alike options by a three-letter prefix", () => {
    expect(looksLike("Cyber", ["Cyber", "cybersecurity"])).toBe(
      "cybersecurity",
    );
    expect(looksLike("Fr", ["Fr", "Fraud"])).toBeNull();
    expect(looksLike("Fraud", ["Fraud", "Phishing"])).toBeNull();
  });
});
