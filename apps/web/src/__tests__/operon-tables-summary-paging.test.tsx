import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * Operon fork check (Codex round 1, finding 2; docs/fork-discipline.md row 18): the Tables
 * summary route pages 50 tables at a time; the hook behind the Tables page and the TABLES
 * sidebar group follows `nextCursor` until it is exhausted, so a 51st table is not lost.
 */

const getTablesSummary = vi.fn();
vi.mock("@/fetchers/operon-tables/get-tables-summary", () => ({
  getTablesSummary: (...args: unknown[]) => getTablesSummary(...args),
}));

const { default: useTablesSummary } = await import(
  "@/hooks/queries/operon-tables/use-tables-summary"
);

const table = (n: number) => ({
  tableId: `t${n}`,
  name: `Table ${n}`,
  entries: 0,
  group: null,
  status: [],
  lastAdded: null,
});

describe("useTablesSummary", () => {
  it("loads every page of a workspace with more than 50 tables", async () => {
    const all = Array.from({ length: 120 }, (_, i) => table(i + 1));
    getTablesSummary.mockImplementation(
      async (_workspaceId: string, cursor?: string | null) => {
        const start = cursor ? Number(cursor) : 0;
        return {
          tables: all.slice(start, start + 50),
          nextCursor: start + 50 < all.length ? String(start + 50) : null,
          ...(cursor ? {} : { recent: [] }),
        };
      },
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTablesSummary("w1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.tables).toHaveLength(120);
    expect(result.current.data?.tables.at(-1)?.name).toBe("Table 120");
    expect(result.current.data?.recent).toEqual([]);
    expect(getTablesSummary).toHaveBeenCalledTimes(3);
  });
});
