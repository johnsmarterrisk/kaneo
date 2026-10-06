import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MentionList from "@/components/task/extensions/mention-list";
import {
  mentionSuggestionItems,
  operonGroupMentionItems,
} from "@/components/task/extensions/mention-suggestion";
import getOperonGroups from "@/fetchers/operon-groups/get-operon-groups";
import { useGetOperonGroups } from "@/hooks/queries/operon-groups/use-get-operon-groups";

// The signed-in Initiative user, switched in place to act out a same-tab account change.
const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/components/providers/auth-provider/hooks/use-auth", () => ({
  default: () => ({ user: auth.user }),
  useAuth: () => ({ user: auth.user }),
}));

// Operon group mentions (Operon spec D10, fork-discipline row 15): Operon's people groups
// follow the people in the `@` list, counted by members who have an Initiative account,
// with a hover text when some do not.

const people = Array.from({ length: 10 }, (_, i) => ({
  id: `user-${i}`,
  label: `Teammate ${i}`,
  image: null,
}));

describe("group mention items", () => {
  it("counts members with an Initiative account, with the hover text only when fewer than all", () => {
    const [partial, full, single] = operonGroupMentionItems([
      {
        slug: "marketing-team",
        name: "Marketing team",
        initiativeCount: 2,
        memberCount: 3,
      },
      { slug: "ops", name: "Ops", initiativeCount: 3, memberCount: 3 },
      { slug: "solo", name: "Solo", initiativeCount: 1, memberCount: 1 },
    ]);
    expect(partial).toEqual({
      id: "group:marketing-team",
      label: "marketing-team",
      name: "Marketing team",
      image: null,
      secondary: "group · 2 people",
      title: "2 of 3 in this group use Initiative",
    });
    expect(full?.secondary).toBe("group · 3 people");
    expect(full).not.toHaveProperty("title");
    expect(single?.secondary).toBe("group · 1 person");
  });

  it("lists the first 8 matching people, then up to 3 groups matched by handle or name", () => {
    const groups = operonGroupMentionItems(
      ["alpha", "beta", "gamma", "delta"].map((slug) => ({
        slug: `${slug}-team`,
        name: `Teammates ${slug}`,
        initiativeCount: 2,
        memberCount: 2,
      })),
    );
    const items = mentionSuggestionItems("team", people, groups);
    expect(items.map((i) => i.id)).toEqual([
      ...people.slice(0, 8).map((p) => p.id),
      "group:alpha-team",
      "group:beta-team",
      "group:gamma-team",
    ]);
    // A group's NAME matches too ("Teammates beta"), its handle does not contain "mates".
    expect(
      mentionSuggestionItems("mates beta", people, groups).map((i) => i.id),
    ).toEqual(["group:beta-team"]);
  });

  it("renders a group row with the group badge, its count line and its hover text", () => {
    const command = vi.fn();
    const [group] = operonGroupMentionItems([
      {
        slug: "marketing-team",
        name: "Marketing team",
        initiativeCount: 2,
        memberCount: 3,
      },
    ]);
    render(
      <MentionList
        items={[people[0], group].filter((i) => i !== undefined)}
        command={command}
      />,
    );
    const row = screen.getByRole("button", { name: /marketing-team/ });
    expect(row.textContent).toContain("group · 2 people");
    expect(row.getAttribute("title")).toBe(
      "2 of 3 in this group use Initiative",
    );
    expect(row.querySelector("[data-testid='mention-group-badge']")).not.toBe(
      null,
    );
    const person = screen.getByRole("button", { name: /Teammate 0/ });
    expect(person.querySelector("[data-testid='mention-group-badge']")).toBe(
      null,
    );
    fireEvent.click(row);
    expect(command).toHaveBeenCalledWith(group);
  });
});

describe("getOperonGroups", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the route with the session cookie and fails loudly on a refusal", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ groups: [{ slug: "ops" }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getOperonGroups()).resolves.toEqual([{ slug: "ops" }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /\/api\/operon\/groups$/,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ credentials: "include" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );
    await expect(getOperonGroups()).rejects.toThrow("403");
  });
});

// Operon review round 1, finding 5: the editor's group list belongs to one signed-in user
// and is never trusted past the read that produced it.
describe("useGetOperonGroups", () => {
  const OPS = { slug: "ops", name: "Ops", initiativeCount: 1, memberCount: 1 };
  const answer = (groups: unknown[], status = 200) =>
    new Response(JSON.stringify({ groups }), { status });
  let client: QueryClient;
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const fresh = () => {
    client = new QueryClient();
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    auth.user = null;
  });

  it("a same-tab account switch never shows the previous account's groups", async () => {
    fresh();
    auth.user = { id: "user-a" };
    let releaseB!: (r: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => answer([OPS]))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseB = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(() => useGetOperonGroups(true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toEqual([OPS]));
    auth.user = { id: "user-b" };
    rerender();
    // Before B's own answer lands, nothing of A's list is on show.
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releaseB(answer([]));
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it("a demotion in Operon is seen when the next editor opens, not up to a minute later", async () => {
    fresh();
    auth.user = { id: "user-a" };
    const fetchMock = vi.fn(async () => answer([OPS]));
    vi.stubGlobal("fetch", fetchMock);
    const first = renderHook(() => useGetOperonGroups(true), { wrapper });
    await waitFor(() => expect(first.result.current.data).toEqual([OPS]));
    first.unmount();
    // The list is not kept once no editor shows it (gcTime 0 collects on the next tick).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getQueryData(["operon-groups", "user-a"])).toBeUndefined();
    // Operon now answers this person as a guest: no groups.
    fetchMock.mockImplementation(async () => answer([]));
    const second = renderHook(() => useGetOperonGroups(true), { wrapper });
    expect(second.result.current.data).toBeUndefined();
    await waitFor(() => expect(second.result.current.data).toEqual([]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a failed refresh after a good load hides the old groups", async () => {
    fresh();
    auth.user = { id: "user-a" };
    const fetchMock = vi.fn(async () => answer([OPS]));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useGetOperonGroups(true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([OPS]));
    fetchMock.mockImplementation(async () => answer([], 503));
    await result.current.refetch();
    await waitFor(() => expect(result.current.data).toBeUndefined());
  });

  it("asks nothing while nobody is signed in", async () => {
    fresh();
    const fetchMock = vi.fn(async () => answer([OPS]));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useGetOperonGroups(true), { wrapper });
    expect(result.current.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
