import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskTitle from "./task-title";

/**
 * task-title.tsx — Stage 1 round-1 finding 6's own assertion: a keystroke that changes the
 * title must register itself as protected state (`registerDirtyEditor`,
 * `@/lib/version-check`) for the WINDOW BETWEEN the keystroke and the 800 ms debounce
 * handing the save off to `useUpdateTaskTitle` — `useIsMutating()` alone cannot see that
 * window, because nothing is mutating yet. This proves the predicate flips true on a
 * keystroke and back to false once the debounced save actually fires — never before.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const getTaskMock = vi.fn(() => ({
  data: { id: "task-1", title: "Original title", projectId: "proj-1" },
}));
vi.mock("@/hooks/queries/task/use-get-task", () => ({
  default: () => getTaskMock(),
}));

const updateTaskTitleMock = vi.fn(async (task: unknown) => task);
vi.mock("@/hooks/mutations/task/use-update-task-title", () => ({
  useUpdateTaskTitle: () => ({ mutateAsync: updateTaskTitleMock }),
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canUpdateTasks: () => true }),
}));

const registered = vi.hoisted(() => ({
  check: null as (() => boolean) | null,
  unregister: vi.fn(),
}));
vi.mock("@/lib/version-check", () => ({
  registerDirtyEditor: (check: () => boolean) => {
    registered.check = check;
    return registered.unregister;
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  registered.check = null;
  registered.unregister.mockClear();
  updateTaskTitleMock.mockClear();
  getTaskMock.mockClear();
});

describe("TaskTitle registers a dirty-editor predicate (finding 6)", () => {
  it("registers on mount, and the predicate reads false before any edit", () => {
    render(<TaskTitle taskId="task-1" />);
    expect(registered.check).not.toBeNull();
    expect(registered.check?.()).toBe(false);
  });

  it("a keystroke flips the predicate true IMMEDIATELY — before the 800ms debounce fires", async () => {
    render(<TaskTitle taskId="task-1" />);
    const input = screen.getByPlaceholderText("tasks:detail.titlePlaceholder");
    fireEvent.change(input, { target: { value: "New title" } });

    expect(registered.check?.()).toBe(true);
    expect(updateTaskTitleMock).not.toHaveBeenCalled(); // debounce has not fired yet
  });

  it("the predicate returns to false once the debounce hands off to the mutation", async () => {
    render(<TaskTitle taskId="task-1" />);
    const input = screen.getByPlaceholderText("tasks:detail.titlePlaceholder");
    fireEvent.change(input, { target: { value: "New title" } });
    expect(registered.check?.()).toBe(true);

    await vi.advanceTimersByTimeAsync(800);

    expect(updateTaskTitleMock).toHaveBeenCalledTimes(1);
    expect(registered.check?.()).toBe(false);
  });

  it("unregisters on unmount", () => {
    const { unmount } = render(<TaskTitle taskId="task-1" />);
    expect(registered.unregister).not.toHaveBeenCalled();
    unmount();
    expect(registered.unregister).toHaveBeenCalledTimes(1);
  });
});
