import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ColumnsPage from "@/components/operon-tables/columns-page";

/**
 * Operon fork check (Tables walk finding F1, docs/fork-discipline.md row 18): the app's
 * queries default to `refetchOnMount: false`, so the Topics counts showed an earlier visit's
 * numbers after a row save. Opening Columns re-reads the values: a topic saved since reads 1
 * without a reload. Remove the invalidation in `columns-page.tsx` and this reads 0.
 */
const values = vi.fn();
vi.mock("@/fetchers/custom-field/get-custom-field-values-by-project", () => ({
  default: () => values(),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ isAdmin: true }),
}));
vi.mock("@/hooks/queries/operon-tables/use-get-table", () => ({
  default: () => ({
    data: {
      projectId: "p1",
      name: "Risk tips",
      isTable: true,
      groupFieldId: "topic",
      dateFieldId: null,
      statusFieldId: null,
      columns: [
        {
          id: "topic",
          name: "Topic",
          kind: "dropdown",
          required: false,
          options: ["Cyber", "Cybersecurity"],
          position: 1,
        },
      ],
      hiddenColumns: [],
    },
    isLoading: false,
  }),
}));
vi.mock("@/hooks/queries/operon-tables/use-get-column-history", () => ({
  default: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("@/hooks/mutations/custom-field/use-create-custom-field", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/custom-field/use-delete-custom-field", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/custom-field/use-reorder-custom-field", () => ({
  useReorderCustomFields: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/operon-tables/use-edit-options", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/operon-tables/use-update-table-settings", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));

afterEach(() => cleanup());

describe("Columns page topic counts", () => {
  it("reads 1 for a topic saved after an earlier visit, without a reload", async () => {
    // The app's own defaults: a cached query is not re-read on mount.
    const client = new QueryClient({
      defaultOptions: { queries: { refetchOnMount: false, retry: false } },
    });
    // An earlier visit cached the values before the row was saved.
    client.setQueryData(["custom-field-values", "p1"], []);
    values.mockResolvedValue([
      { id: "v1", taskId: "r1", fieldId: "topic", value: "Cybersecurity" },
    ]);

    render(
      <QueryClientProvider client={client}>
        <ColumnsPage projectId="p1" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByText("Cybersecurity")
          .map((el) => el.closest("li")?.textContent ?? ""),
      ).toContainEqual(
        expect.stringContaining("Cybersecurity 1 · looks like Cyber"),
      ),
    );
  });
});
