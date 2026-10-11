import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Operon fork check (Tables codex round 1, finding 4, docs/fork-discipline.md row 18): a
 * project socket's task message invalidates the table queries, so a row another client
 * saved re-reads here. Remove the invalidation in `use-project-websocket.ts` and this fails.
 */
vi.mock("@kaneo/libs", () => ({ windowId: "w1" }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "u1" } } }) },
}));

const sockets: Array<{ onmessage?: (e: { data: string }) => void }> = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  onmessage?: (e: { data: string }) => void;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor() {
    sockets.push(this);
  }
  send() {}
  close() {}
}

afterEach(() => {
  cleanup();
  sockets.length = 0;
  vi.unstubAllGlobals();
});

describe("the project socket and table queries", () => {
  it("invalidates the table's rows, the row, search and summary on TASK_UPDATED", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { useProjectWebSocket } = await import(
      "@/hooks/use-project-websocket"
    );
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useProjectWebSocket("table-1"), { wrapper });
    expect(sockets).toHaveLength(1);

    sockets[0].onmessage?.({
      data: JSON.stringify({
        type: "TASK_UPDATED",
        projectId: "table-1",
        taskId: "row-1",
      }),
    });
    const keys = spy.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(["operon-table-rows", "table-1"]);
    expect(keys).toContainEqual(["operon-table-row", "row-1"]);
    expect(keys).toContainEqual(["operon-table-search"]);
    expect(keys).toContainEqual(["operon-tables-summary"]);
  });
});
