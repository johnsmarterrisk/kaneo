import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Task from "@/types/task";
import TaskAssigneePopover from "./task-assignee-popover";

/**
 * Operon fork check — spec R16.
 *
 * A control the caller may not use renders DISABLED with a reason; it never
 * disappears. The upstream line was `if (!canAssign) return <>{children}</>;`,
 * which turned the assignee chip into inert markup — indistinguishable, from the
 * outside, from a broken button.
 *
 * See `docs/fork-discipline.md` §3 row 6 in the Operon repository.
 */

const mocks = vi.hoisted(() => ({
  canAssignTasks: vi.fn(),
  updateTaskAssignee: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-assignee", () => ({
  useUpdateTaskAssignee: () => ({ mutateAsync: mocks.updateTaskAssignee }),
}));
vi.mock(
  "@/hooks/queries/workspace-users/use-get-active-workspace-users",
  () => ({
    useGetActiveWorkspaceUsers: () => ({
      data: {
        members: [{ userId: "user-1", user: { name: "Ada", image: "" } }],
      },
    }),
  }),
);
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canAssignTasks: mocks.canAssignTasks }),
}));
vi.mock("@/hooks/use-numbered-shortcuts", () => ({
  useNumberedShortcuts: () => {},
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const task = { id: "task-1", userId: null } as unknown as Task;

/** The `task: assign` permission's own description string — see the component. */
const ASSIGN_PERMISSION =
  "settings:workspaceRoles.permissions.task.assign.description";

beforeEach(() => {
  mocks.canAssignTasks.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskAssigneePopover", () => {
  it("renders the trigger disabled, with a tooltip naming the missing permission", () => {
    mocks.canAssignTasks.mockReturnValue(false);

    render(
      <TaskAssigneePopover task={task} workspaceId="workspace-1">
        <button type="button">Assignee</button>
      </TaskAssigneePopover>,
    );

    const wrapper = screen.getByTitle(ASSIGN_PERMISSION);
    expect(wrapper.getAttribute("aria-disabled")).toBe("true");
    // The chip is still THERE — disabled, not gone — which is the whole point.
    expect(screen.getByRole("button", { name: "Assignee" })).toBeTruthy();
    expect(
      wrapper.contains(screen.getByRole("button", { name: "Assignee" })),
    ).toBe(true);
  });

  it("renders a live trigger with no disabled wrapper when the caller may assign", () => {
    render(
      <TaskAssigneePopover task={task} workspaceId="workspace-1">
        <button type="button">Assignee</button>
      </TaskAssigneePopover>,
    );

    expect(screen.queryByTitle(ASSIGN_PERMISSION)).toBeNull();
    const trigger = screen.getByRole("button", { name: "Assignee" });
    expect(trigger.getAttribute("aria-disabled")).toBeNull();
  });
});
