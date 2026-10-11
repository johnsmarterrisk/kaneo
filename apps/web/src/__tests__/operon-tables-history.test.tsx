import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import useGetColumnHistory from "@/hooks/queries/operon-tables/use-get-column-history";

/**
 * Operon fork check (Tables codex round 1, finding 5, docs/fork-discipline.md row 18): the
 * recovery read follows the API's `nextCursor`, so a change older than the first page of
 * 100 is still recoverable. Drop the cursor from the fetcher and page 2 never loads.
 */
afterEach(() => vi.unstubAllGlobals());

const page = (history: string[], nextCursor: string | null) => ({
  field: { id: "f1", name: "Series", kind: "text", hidden: true },
  current: [{ rowId: "r1", title: "Tip", value: "Now" }],
  history: history.map((v) => ({
    rowId: "r1",
    oldValue: null,
    newValue: v,
    reason: "save",
    at: "2026-10-09T00:00:00Z",
  })),
  nextCursor,
});

describe("a column's history pages", () => {
  it("loads the next page through nextCursor and appends it", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = url.includes("cursor=c2")
          ? page(["oldest"], null)
          : page(["newest"], "c2");
        return { ok: true, status: 200, json: async () => body };
      }),
    );
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useGetColumnHistory("p1", "f1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() =>
      expect(result.current.data?.history.map((h) => h.newValue)).toEqual([
        "newest",
        "oldest",
      ]),
    );
    expect(result.current.hasNextPage).toBe(false);
    expect(urls[1]).toContain("/history?cursor=c2");
  });
});
