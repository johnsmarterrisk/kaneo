import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./visibility";

/**
 * Regression guard for review finding A (fork/initiative-settings, round 2): a visibility
 * toggle must never be able to revert a concurrent general-settings edit. Pre-fix, this
 * page's `handleToggle` built its payload from `project` (a `useGetProject` snapshot that
 * can be stale relative to an edit just made on the General tab) and sent
 * name/slug/description/icon back alongside `isPublic` — the mirror image of the bug
 * general.tsx already guards against (see general.test.tsx, "never sends isPublic").
 *
 * Fix: this page now sends only the field it owns, `isPublic`. The API route also makes
 * every field optional and leaves an omitted field untouched (apps/api update-project.ts).
 *
 * Mocking pattern copied from ./general.test.tsx.
 */

const routeParams = { projectId: "proj-1" };

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  fetchedProject: {
    id: "proj-1",
    workspaceId: "workspace-1",
    name: "Testt",
    slug: "ZS1",
    description: "a description",
    icon: "Rocket",
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

vi.mock("@/hooks/queries/project/use-get-project", () => ({
  default: () => ({ data: mocks.fetchedProject }),
}));

vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    hasPermission: async () => true,
  }),
}));

vi.mock("@/hooks/mutations/project/use-update-project", () => ({
  default: () => ({ mutateAsync: mocks.mutateAsync }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const VisibilityRoute = (Route as unknown as { component: ComponentType })
  .component;

beforeEach(() => {
  mocks.mutateAsync.mockReset();
  mocks.mutateAsync.mockResolvedValue({});
  mocks.invalidateQueries.mockClear();
  mocks.fetchedProject = { ...mocks.fetchedProject, isPublic: false };
});

describe("project visibility toggle — payload carries no general field (review finding A)", () => {
  it("sends only id and isPublic, never name/slug/description/icon", async () => {
    render(<VisibilityRoute />);

    const toggle = await waitFor(() => {
      const el = screen.getByRole("switch");
      expect(el).not.toBeDisabled();
      return el;
    });

    fireEvent.click(toggle);

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));

    // This is the assertion that fails on the pre-fix code: without the fix, this payload
    // also carries name/slug/description/icon taken from the stale `project` snapshot,
    // which can silently revert a concurrent General-tab edit.
    const payload = mocks.mutateAsync.mock.calls[0][0];
    expect(payload).toEqual({ id: "proj-1", isPublic: true });
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("slug");
    expect(payload).not.toHaveProperty("description");
    expect(payload).not.toHaveProperty("icon");
  });
});
