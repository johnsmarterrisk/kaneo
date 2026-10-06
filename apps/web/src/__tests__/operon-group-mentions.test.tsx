import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MentionList from "@/components/task/extensions/mention-list";
import {
  mentionSuggestionItems,
  operonGroupMentionItems,
} from "@/components/task/extensions/mention-suggestion";
import getOperonGroups from "@/fetchers/operon-groups/get-operon-groups";

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
