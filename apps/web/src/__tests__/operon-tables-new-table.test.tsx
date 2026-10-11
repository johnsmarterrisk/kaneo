import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NewTableAction from "@/components/operon-tables/new-table-action";

/**
 * Operon fork check (Tables task 3, docs/fork-discipline.md row 18): "New table" is offered
 * to workspace owners and admins only. The server's table-admin gate is the check of record;
 * this keeps the entry out of a member's menu.
 */
const permission = { isAdmin: false };

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => permission,
}));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "ws-1", name: "Smarter Risk" } }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

function renderAction() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NewTableAction />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  permission.isAdmin = false;
});

describe("New table entry", () => {
  it("is absent for a member", () => {
    renderAction();
    expect(screen.queryByText("New table")).toBeNull();
  });

  it("is offered to an admin", () => {
    permission.isAdmin = true;
    renderAction();
    expect(screen.getByText("New table")).toBeTruthy();
  });
});
