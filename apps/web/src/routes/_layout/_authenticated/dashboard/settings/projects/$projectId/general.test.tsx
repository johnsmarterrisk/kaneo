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
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  loadingProject: false,
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
    invalidateQueries: mocks.invalidateQueries,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// `fetchedProject` is a STABLE object (never a new reference), which is exactly what "no
// refetch happened since the last save" looks like — the same shape a real 30s poll gap
// produces. This is what lets the test catch the stale-`project` bug deterministically.
vi.mock("@/hooks/queries/task/use-get-tasks", () => ({
  useGetTasks: () => ({
    data: mocks.loadingProject ? undefined : mocks.fetchedProject,
  }),
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
  mocks.invalidateQueries.mockClear();
  mocks.loadingProject = false;
  mocks.fetchedProject = {
    ...mocks.fetchedProject,
    name: "Testt",
    slug: "ZS1",
  };
  useProjectStore.setState({ project: undefined });
});

afterEach(() => {
  cleanup();
});

describe("project general settings — two saves in a row (operator report, 2026-09-28)", () => {
  it("does not allow edits before the first project snapshot seeds the form", async () => {
    mocks.loadingProject = true;
    const view = render(<GeneralRoute />);
    const nameInput = screen.getByRole("textbox", {
      name: "settings:projectGeneral.projectNameLabel",
    }) as HTMLInputElement;
    expect(nameInput).toBeDisabled();

    mocks.loadingProject = false;
    view.rerender(<GeneralRoute />);
    await waitFor(() => expect(nameInput).not.toBeDisabled());
    expect(nameInput.value).toBe("Testt");
  });

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
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "proj-1"],
    });
  });

  it("never sends isPublic — general settings must not be able to flip visibility", async () => {
    render(<GeneralRoute />);

    const nameInput = (await screen.findByDisplayValue(
      "Testt",
    )) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "renamed" } });
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1), {
      timeout: DEBOUNCE_MS * 4,
    });

    expect(mocks.mutateAsync.mock.calls[0][0]).not.toHaveProperty("isPublic");
  });
});

/**
 * Regression guard for review finding 1 (fork/initiative-settings, round 1): a save that
 * completes while the person keeps editing must not clobber what they typed, and an edit
 * queued during the in-flight request (by the debounce, or by the unmount flush which
 * drives the same `saveProject`/`queuedSaveRef` path) must still reach the server.
 * Pre-fix, the success path unconditionally called `projectForm.reset(normalizedData)`
 * with the JUST-SAVED (now stale) values and nulled `queuedSaveRef` before the `finally`
 * block's drain ever ran — so a newer edit was both reverted in the form and discarded
 * from the queue.
 */
describe("project general settings — an edit made mid-save is never lost (review finding 1)", () => {
  it("flushes a valid edit on unmount before the debounce fires", async () => {
    const view = render(<GeneralRoute />);
    const nameInput = (await screen.findByDisplayValue(
      "Testt",
    )) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "leaving-now" } });
    view.unmount();

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync.mock.calls[0][0].name).toBe("leaving-now");
  });

  it("does not revert the input to the stale saved value once the in-flight save resolves", async () => {
    let resolveFirstSave: (value: unknown) => void = () => {};
    mocks.mutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstSave = resolve;
        }),
    );

    render(<GeneralRoute />);
    const nameInput = (await screen.findByDisplayValue(
      "Testt",
    )) as HTMLInputElement;

    // First edit — triggers the debounced save, which we hold pending (mocked above).
    fireEvent.change(nameInput, { target: { value: "first-edit" } });
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1), {
      timeout: DEBOUNCE_MS * 4,
    });

    // A newer edit lands while that save is still in flight. Pre-fix, `reset` would
    // later stomp this back to "first-edit" as soon as the save resolved.
    fireEvent.change(nameInput, { target: { value: "second-edit" } });
    expect(nameInput.value).toBe("second-edit");

    resolveFirstSave({});

    // Give the resolved save's synchronous success path (including the guarded
    // `reset`) a chance to run, well inside the second edit's own 800ms debounce
    // window — on pre-fix code the input reverts to "first-edit" right here.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(nameInput.value).toBe("second-edit");

    // The second edit's own debounce now fires and saves the retained value.
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(2), {
      timeout: DEBOUNCE_MS * 4,
    });
    const secondPayload = mocks.mutateAsync.mock.calls[1][0];
    expect(secondPayload.name).toBe("second-edit");
    expect(secondPayload).not.toHaveProperty("isPublic");
  });

  it("queues an edit whose debounce fires while a save is in flight, and drains it once that save resolves", async () => {
    // Two real 800ms+ debounce windows plus the drain wait can exceed vitest's default
    // 5000ms test timeout on a slow run — this is exercising real timers, not a hang.
    let resolveFirstSave: (value: unknown) => void = () => {};
    mocks.mutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstSave = resolve;
        }),
    );

    render(<GeneralRoute />);
    const nameInput = (await screen.findByDisplayValue(
      "Testt",
    )) as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: "first-edit" } });
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1), {
      timeout: DEBOUNCE_MS * 4,
    });

    // The second edit's OWN debounce timer fires here, while the first save is still
    // pending — `saveProject` sees `isSavingRef.current` true and must queue this
    // rather than fire a second concurrent request.
    fireEvent.change(nameInput, { target: { value: "second-edit" } });
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 200));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);

    // Resolving the in-flight save must drain the queued edit — this is the "drain
    // the queued save" half of the fix (pre-fix, the success path nulled the queue
    // before the `finally` block's drain ever ran).
    resolveFirstSave({});
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(2), {
      timeout: DEBOUNCE_MS * 4,
    });

    const [firstPayload, secondPayload] = mocks.mutateAsync.mock.calls.map(
      (call) => call[0],
    );
    expect(firstPayload.name).toBe("first-edit");
    expect(secondPayload.name).toBe("second-edit");
    expect(firstPayload).not.toHaveProperty("isPublic");
    expect(secondPayload).not.toHaveProperty("isPublic");
  }, 10_000);

  it("drains the latest edit even when the queued debounce captured an older value", async () => {
    let resolveFirstSave: (value: unknown) => void = () => {};
    mocks.mutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstSave = resolve;
        }),
    );

    render(<GeneralRoute />);
    const nameInput = (await screen.findByDisplayValue(
      "Testt",
    )) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "first-edit" } });
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1), {
      timeout: DEBOUNCE_MS * 4,
    });
    fireEvent.change(nameInput, { target: { value: "queued-edit" } });
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 100));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    fireEvent.change(nameInput, { target: { value: "latest-edit" } });

    resolveFirstSave({});
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(2), {
      timeout: DEBOUNCE_MS * 4,
    });
    expect(mocks.mutateAsync.mock.calls[1][0].name).toBe("latest-edit");
    expect(nameInput.value).toBe("latest-edit");
  }, 10_000);

  it("saves a revert to the original value made while an earlier save is pending", async () => {
    let resolveFirstSave: (value: unknown) => void = () => {};
    mocks.mutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstSave = resolve;
        }),
    );

    render(<GeneralRoute />);
    const nameInput = (await screen.findByDisplayValue(
      "Testt",
    )) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "first-edit" } });
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1), {
      timeout: DEBOUNCE_MS * 4,
    });
    fireEvent.change(nameInput, { target: { value: "Testt" } });
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 100));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);

    resolveFirstSave({});
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(2), {
      timeout: DEBOUNCE_MS * 4,
    });
    expect(mocks.mutateAsync.mock.calls[1][0].name).toBe("Testt");
    expect(nameInput.value).toBe("Testt");
  }, 10_000);

  it("flushes a newer edit on unmount while the first save is pending", async () => {
    let resolveFirstSave: (value: unknown) => void = () => {};
    mocks.mutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstSave = resolve;
        }),
    );

    const view = render(<GeneralRoute />);
    const nameInput = (await screen.findByDisplayValue(
      "Testt",
    )) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "first-edit" } });
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1), {
      timeout: DEBOUNCE_MS * 4,
    });
    fireEvent.change(nameInput, { target: { value: "unmount-edit" } });
    view.unmount();
    resolveFirstSave({});

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(2), {
      timeout: DEBOUNCE_MS * 4,
    });
    expect(mocks.mutateAsync.mock.calls[1][0].name).toBe("unmount-edit");
  });

  it("does not let a stale tasks poll restore an older name after a successful save", async () => {
    const view = render(<GeneralRoute />);
    const nameInput = (await screen.findByDisplayValue(
      "Testt",
    )) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "saved-edit" } });
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1), {
      timeout: DEBOUNCE_MS * 4,
    });
    await waitFor(() =>
      expect(mocks.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["tasks", "proj-1"],
      }),
    );

    mocks.fetchedProject = { ...mocks.fetchedProject, name: "Testt" };
    view.rerender(<GeneralRoute />);
    expect(nameInput.value).toBe("saved-edit");
    fireEvent.change(nameInput, { target: { value: "next-edit" } });
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(2), {
      timeout: DEBOUNCE_MS * 4,
    });
    expect(mocks.mutateAsync.mock.calls[1][0].name).toBe("next-edit");
  });
});
