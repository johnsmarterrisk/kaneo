import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useProjectStore from "@/store/project.ts";
import { Route } from "./general";

/**
 * Regression guard for the operator's 2026-09-28 report: on a project's settings page he
 * changed the name from "Testt" to "bug-board"; afterwards the page showed name "Testt"
 * again (key "BB" — the change he made second — did stick). Reproduced locally (see the
 * build's report): PUT #1 saved the new name correctly; PUT #2 — triggered by the key
 * change landing inside the same ~30s window as PUT #1 — carried the OLD, stale name and
 * silently reverted it.
 *
 * Root cause: `saveProject`'s payload picked each field as
 * `<field>Changed ? normalizedData.<field> : project.<field>`. `project` comes from
 * `useGetTasks(projectId)` (query key ["tasks", projectId]), which the save never
 * invalidated — it only refreshes on its own 30s poll. On the second save, `nameChanged`
 * is false (the name hasn't changed since the FIRST save), so the payload fell back to
 * `project.name` — which, without a refetch, is still the pre-rename value.
 *
 * Fix: the payload now always takes every form field from the form's own normalized
 * values (the form is what the person sees, so it is the source of truth), and the save
 * also invalidates the `["tasks", project.id]` query so `project` stays fresh too.
 *
 * This test reproduces the exact trigger — two saves in a row, second inside the poll
 * window — by mocking `useGetTasks` to return a value that never changes across renders
 * (exactly what "no refetch happened yet" looks like), and asserts the SECOND payload
 * still carries the name from the first save, not the pre-test stale value.
 *
 * Mocking pattern (`createFileRoute` returning `options` so `Route.component` is directly
 * renderable) copied from `members.test.tsx`/`information.test.tsx`.
 */

const routeParams = { projectId: "proj-1" };

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  fetchedProject: {
    id: "proj-1",
    workspaceId: "workspace-1",
    name: "Testt",
    slug: "ZS1",
    description: "",
    icon: "Layout",
    isPublic: false,
    createdAt: "2026-09-28T00:00:00.000Z",
    archivedAt: null,
    lastTaskNumber: 0,
    position: 1,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    ...(options as Record<string, unknown>),
    useParams: () => routeParams,
  }),
  useNavigate: () => vi.fn(),
  useParams: () => routeParams,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// `fetchedProject` is a STABLE object (never a new reference), which is exactly what "no
// refetch happened since the last save" looks like — the same shape a real 30s poll gap
// produces. This is what lets the test catch the stale-`project` bug deterministically.
vi.mock("@/hooks/queries/task/use-get-tasks", () => ({
  useGetTasks: () => ({ data: mocks.fetchedProject }),
}));

vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageProjects: () => true,
    canDeleteProjects: () => true,
  }),
}));

vi.mock("@/hooks/mutations/project/use-update-project", () => ({
  default: () => ({ mutateAsync: mocks.mutateAsync }),
}));

vi.mock("@/hooks/mutations/project/use-delete-project", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/components/project/tasks-import-export.tsx", () => ({
  TasksImportExport: () => null,
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const GeneralRoute = (Route as unknown as { component: ComponentType })
  .component;

const DEBOUNCE_MS = 800;

function savedNames() {
  return mocks.mutateAsync.mock.calls.map((call) => call[0].name);
}

beforeEach(() => {
  mocks.mutateAsync.mockReset();
  mocks.mutateAsync.mockResolvedValue({});
  useProjectStore.setState({ project: undefined });
});

afterEach(() => {
  cleanup();
});

describe("project general settings — two saves in a row (operator report, 2026-09-28)", () => {
  it("the second save's payload carries the NEW name, not the stale pre-save value", async () => {
    render(<GeneralRoute />);

    const nameInput = (await screen.findByDisplayValue(
      "Testt",
    )) as HTMLInputElement;
    const slugInput = screen.getByDisplayValue("ZS1") as HTMLInputElement;

    // Step 1: rename, and wait past the 800ms debounce for the first save to land.
    fireEvent.change(nameInput, { target: { value: "bug-board" } });
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1), {
      timeout: DEBOUNCE_MS * 4,
    });
    expect(mocks.mutateAsync.mock.calls[0][0].name).toBe("bug-board");

    // Step 2: change the key — inside the window before `fetchedProject`/`project`
    // would ever refresh (it never does in this test, mirroring the 30s poll gap).
    fireEvent.change(slugInput, { target: { value: "BB" } });
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(2), {
      timeout: DEBOUNCE_MS * 4,
    });

    const secondPayload = mocks.mutateAsync.mock.calls[1][0];
    expect(secondPayload.slug).toBe("BB");
    // This is the assertion that fails on the pre-fix code: without the fix, this reads
    // "Testt" (`project.name`, stale) rather than "bug-board" (the form's own value).
    expect(secondPayload.name).toBe("bug-board");
    expect(savedNames()).toEqual(["bug-board", "bug-board"]);
  });
});
