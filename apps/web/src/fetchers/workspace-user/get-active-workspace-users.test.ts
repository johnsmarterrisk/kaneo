import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import useGetWorkspaceUsers from "@/hooks/queries/workspace-users/use-get-workspace-users";
import getActiveWorkspaceUsers, {
  WORKSPACE_MEMBERS_PAGE_SIZE,
} from "./get-active-workspace-users";

/**
 * Operon fork: the member list is complete at any workspace size (agent-initiative walk
 * finding W1; open-items 317). Better Auth answers one page per call, so the fetch must
 * page; these fail if the paging is removed.
 */
const { listMembers } = vi.hoisted(() => ({ listMembers: vi.fn() }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { organization: { listMembers } },
}));

type Query = {
  organizationId: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDirection?: "asc" | "desc";
};

function member(index: number) {
  const id = `m-${String(index).padStart(4, "0")}`;
  return {
    id,
    userId: `u-${id}`,
    organizationId: "ws",
    role: "member",
    createdAt: new Date(0),
    user: { id: `u-${id}`, name: `Person ${index}`, email: "", image: null },
  };
}

/** A server like better-auth 1.6.25: without a limit it answers 100 rows. */
function serve(count: number, failAtOffset?: number) {
  const all = Array.from({ length: count }, (_, i) => member(i));
  listMembers.mockImplementation(async ({ query }: { query: Query }) => {
    if (failAtOffset !== undefined && (query.offset ?? 0) === failAtOffset) {
      return { data: null, error: { message: "boom" } };
    }
    const sorted =
      query.sortBy === "id"
        ? [...all].sort((a, b) => a.id.localeCompare(b.id))
        : [...all].reverse();
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    return {
      data: { members: sorted.slice(offset, offset + limit), total: count },
      error: null,
    };
  });
  return all;
}

beforeEach(() => {
  listMembers.mockReset();
});

describe("getActiveWorkspaceUsers pages to a complete list", () => {
  it("returns every member of a workspace larger than one page, in a stable order", async () => {
    const all = serve(379);
    const result = await getActiveWorkspaceUsers({ workspaceId: "ws" });
    expect(result.members).toHaveLength(379);
    expect(new Set(result.members.map((m) => m.id)).size).toBe(379);
    expect(result.members.map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect(result.total).toBe(379);
    expect(listMembers.mock.calls.map(([arg]) => arg.query)).toEqual([
      {
        organizationId: "ws",
        limit: WORKSPACE_MEMBERS_PAGE_SIZE,
        offset: 0,
        sortBy: "id",
        sortDirection: "asc",
      },
      {
        organizationId: "ws",
        limit: WORKSPACE_MEMBERS_PAGE_SIZE,
        offset: WORKSPACE_MEMBERS_PAGE_SIZE,
        sortBy: "id",
        sortDirection: "asc",
      },
    ]);
  });

  it("asks once more after exactly one full page, and stops on the empty page", async () => {
    serve(WORKSPACE_MEMBERS_PAGE_SIZE);
    const result = await getActiveWorkspaceUsers({ workspaceId: "ws" });
    expect(result.members).toHaveLength(WORKSPACE_MEMBERS_PAGE_SIZE);
    expect(listMembers).toHaveBeenCalledTimes(2);
  });

  it("answers an empty workspace in one request", async () => {
    serve(0);
    const result = await getActiveWorkspaceUsers({ workspaceId: "ws" });
    expect(result).toEqual({ members: [], total: 0 });
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it("answers one member in one request", async () => {
    serve(1);
    const result = await getActiveWorkspaceUsers({ workspaceId: "ws" });
    expect(result.members.map((entry) => entry.id)).toEqual([member(0).id]);
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it("answers a small workspace in one request", async () => {
    serve(3);
    const result = await getActiveWorkspaceUsers({ workspaceId: "ws" });
    expect(result.members).toHaveLength(3);
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it("fails when a page after the first fails, never a silently short list", async () => {
    serve(379, WORKSPACE_MEMBERS_PAGE_SIZE);
    await expect(
      getActiveWorkspaceUsers({ workspaceId: "ws" }),
    ).rejects.toThrow("boom");
  });

  it("fails loudly when the server ignores the offset", async () => {
    const all = Array.from({ length: WORKSPACE_MEMBERS_PAGE_SIZE }, (_, i) =>
      member(i),
    );
    listMembers.mockResolvedValue({
      data: { members: all, total: 999 },
      error: null,
    });
    await expect(
      getActiveWorkspaceUsers({ workspaceId: "ws" }),
    ).rejects.toThrow("repeated a member");
  });

  it("fails when a short page omits members reported by the server", async () => {
    listMembers.mockResolvedValue({
      data: { members: [member(0)], total: 2 },
      error: null,
    });
    await expect(
      getActiveWorkspaceUsers({ workspaceId: "ws" }),
    ).rejects.toThrow("ended before the reported total");
  });

  it("fails when a later page repeats a member among otherwise new rows", async () => {
    serve(WORKSPACE_MEMBERS_PAGE_SIZE + 1);
    const first = Array.from({ length: WORKSPACE_MEMBERS_PAGE_SIZE }, (_, i) =>
      member(i),
    );
    listMembers.mockResolvedValueOnce({
      data: { members: first, total: WORKSPACE_MEMBERS_PAGE_SIZE + 1 },
      error: null,
    });
    listMembers.mockResolvedValueOnce({
      data: {
        members: [member(0), member(WORKSPACE_MEMBERS_PAGE_SIZE)],
        total: WORKSPACE_MEMBERS_PAGE_SIZE + 1,
      },
      error: null,
    });
    await expect(
      getActiveWorkspaceUsers({ workspaceId: "ws" }),
    ).rejects.toThrow("repeated a member");
  });

  it("fails when the reported total changes between pages", async () => {
    serve(WORKSPACE_MEMBERS_PAGE_SIZE + 1);
    listMembers.mockResolvedValueOnce({
      data: {
        members: Array.from({ length: WORKSPACE_MEMBERS_PAGE_SIZE }, (_, i) =>
          member(i),
        ),
        total: WORKSPACE_MEMBERS_PAGE_SIZE + 1,
      },
      error: null,
    });
    listMembers.mockResolvedValueOnce({
      data: {
        members: [member(WORKSPACE_MEMBERS_PAGE_SIZE)],
        total: WORKSPACE_MEMBERS_PAGE_SIZE + 2,
      },
      error: null,
    });
    await expect(
      getActiveWorkspaceUsers({ workspaceId: "ws" }),
    ).rejects.toThrow("inconsistent page");
  });
});

describe("the activity feed's member list (useGetWorkspaceUsers)", () => {
  it("finds an actor who is past the first page", async () => {
    serve(379);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(
      () => useGetWorkspaceUsers({ workspaceId: "ws" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(379);
    expect(
      result.current.data?.find((m) => m.user?.id === "u-m-0378")?.user?.name,
    ).toBe("Person 378");
  });
});
