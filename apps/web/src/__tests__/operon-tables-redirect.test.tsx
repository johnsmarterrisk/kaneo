import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operon fork check (John's ruling 2026-10-11, Tables spec section 15; docs/fork-discipline.md
 * row 18): `/dashboard/tables`, where Operon's phone "Tables" tab lands, opens the Tables page
 * of the workspace `/dashboard` would pick — including a session fresh from the sign-in
 * hand-off, which has no active workspace yet (the Walk's journey 8 found that case).
 */

const state = vi.hoisted(() => ({
  workspaces: [] as { id: string }[],
  activeId: null as string | null,
  setActive: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  redirect: (target: unknown) => ({ redirect: target }),
}));
vi.mock("@/fetchers/workspace/get-workspaces", () => ({
  default: async () => state.workspaces,
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    getSession: async () => ({
      data: { session: { activeOrganizationId: state.activeId } },
    }),
    organization: { setActive: state.setActive },
  },
}));

const { Route } = await import(
  "@/routes/_layout/_authenticated/dashboard/tables"
);
const beforeLoad = (Route as unknown as { beforeLoad: () => Promise<void> })
  .beforeLoad;

async function target() {
  try {
    await beforeLoad();
  } catch (thrown) {
    return (thrown as { redirect: unknown }).redirect;
  }
  throw new Error("no redirect");
}

beforeEach(() => {
  state.workspaces = [{ id: "w1" }, { id: "w2" }];
  state.activeId = null;
  state.setActive.mockClear();
});

describe("/dashboard/tables", () => {
  it("opens the active workspace's Tables page", async () => {
    state.activeId = "w2";
    expect(await target()).toEqual({
      to: "/dashboard/workspace/$workspaceId/tables",
      params: { workspaceId: "w2" },
    });
    expect(state.setActive).not.toHaveBeenCalled();
  });

  it("with no active workspace (fresh sign-in) opens the first workspace's and makes it active", async () => {
    expect(await target()).toEqual({
      to: "/dashboard/workspace/$workspaceId/tables",
      params: { workspaceId: "w1" },
    });
    expect(state.setActive).toHaveBeenCalledWith({ organizationId: "w1" });
  });

  it("with no workspace at all falls to /dashboard", async () => {
    state.workspaces = [];
    expect(await target()).toEqual({ to: "/dashboard" });
  });
});
