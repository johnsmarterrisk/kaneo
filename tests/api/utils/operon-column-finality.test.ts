/**
 * OPERON FORK TEST — column finality on the outbound task transition webhook
 * (Operon spec R5, F3).
 *
 * WHY THE FACT IS RESOLVED HERE AT ALL. Kaneo keeps finality on the COLUMN
 * (`column.is_final`), per project and configurable, while the webhook payload
 * carries status SLUGS. So a consumer that matched on the word would be wrong in
 * both directions — a final column named "Shipped" reads as unfinished, a
 * non-final column named "Done" reads as complete. Both of those cases are
 * asserted below, because they are the whole reason this module exists.
 *
 * A separate file rather than cases in
 * `tests/api/plugins/generic-webhook/events.test.ts`: that file is upstream's,
 * is byte-identical to `v2.23.1`, and stays that way — one fewer conflict at the
 * next merge. Everything Operon adds to the generic-webhook payload is here.
 *
 * NO DATABASE. `apps/api/src/database` is mocked, so this runs in the unit tier
 * (`pnpm test`) rather than the integration tier, which needs a real Postgres.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveColumnFinality } from "../../../apps/api/src/operon-column-finality";
import { postToGenericWebhook } from "../../../apps/api/src/plugins/generic-webhook/client";
import {
  handleTaskMoved,
  handleTaskStatusChanged,
} from "../../../apps/api/src/plugins/generic-webhook/events";

const { findColumnMock, selectMock, findIntegrationMock } = vi.hoisted(() => ({
  findColumnMock: vi.fn(),
  selectMock: vi.fn(),
  findIntegrationMock: vi.fn(),
}));

vi.mock("../../../apps/api/src/plugins/generic-webhook/client", () => ({
  postToGenericWebhook: vi.fn(),
}));

// The REAL resolver, wrapped in a spy: the behaviour under test is unchanged, and the two
// (projectId, slug) pairs the move handler resolves become assertable. Nothing else about the
// module is replaced.
vi.mock(
  "../../../apps/api/src/operon-column-finality",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../apps/api/src/operon-column-finality")
      >();
    return {
      ...actual,
      resolveColumnFinality: vi.fn(actual.resolveColumnFinality),
    };
  },
);

vi.mock("../../../apps/api/src/database", () => ({
  default: {
    select: selectMock,
    query: {
      columnTable: { findFirst: findColumnMock },
      integrationTable: { findFirst: findIntegrationMock },
    },
  },
}));

/** The shape `getTaskData` and `getActor` walk: `.from().where().limit()`. */
function selectChain(rows: unknown[]) {
  return {
    from: () => ({
      innerJoin: () => selectChain(rows).from(),
      leftJoin: () => selectChain(rows).from(),
      where: () => ({ limit: () => Promise.resolve(rows) }),
    }),
  };
}

const taskRow = {
  id: "task-1",
  title: "Test Task",
  number: 7,
  status: "done",
  priority: "medium",
  columnName: "Done",
  projectId: "project-1",
  projectName: "Roadmap",
  workspaceId: "workspace-1",
};

function mockOneDelivery() {
  selectMock
    .mockImplementationOnce(() => selectChain([taskRow]))
    .mockImplementationOnce(() => selectChain([{ id: "user-1", name: "Ada" }]));
}

function deliveredData(): Record<string, unknown> {
  const [, payload] = vi.mocked(postToGenericWebhook).mock.calls[0] ?? [];
  return (payload as { data: Record<string, unknown> }).data;
}

const enabledContext = {
  integrationId: "integration-1",
  projectId: "project-1",
  config: {
    webhookUrl: "https://example.com/hooks/operon",
    events: { taskStatusChanged: true, taskMoved: true },
  },
};

const statusChangedEvent = {
  taskId: "task-1",
  projectId: "project-1",
  userId: "user-1",
  oldStatus: "in-progress",
  newStatus: "done",
  title: "Test Task",
};

const movedEvent = {
  taskId: "task-1",
  projectId: "project-2",
  userId: "user-1",
  fromProjectId: "project-1",
  fromProjectName: "Roadmap",
  toProjectId: "project-2",
  toProjectName: "Shipping",
  oldStatus: "in-progress",
  newStatus: "shipped",
};

beforeEach(() => {
  vi.mocked(postToGenericWebhook).mockClear();
  vi.mocked(resolveColumnFinality).mockClear();
  selectMock.mockReset();
  findColumnMock.mockReset();
  findIntegrationMock.mockReset();
  findIntegrationMock.mockResolvedValue(undefined);
});

describe("resolveColumnFinality", () => {
  it("reports a final column as final", async () => {
    findColumnMock.mockResolvedValue({ isFinal: true });

    await expect(resolveColumnFinality("project-1", "done")).resolves.toBe(
      true,
    );
    expect(findColumnMock).toHaveBeenCalledTimes(1);
  });

  it("reports a non-final column as non-final", async () => {
    findColumnMock.mockResolvedValue({ isFinal: false });

    await expect(
      resolveColumnFinality("project-1", "in-progress"),
    ).resolves.toBe(false);
  });

  it('reports a column named "Shipped" as final when it is', async () => {
    // The word says nothing; the column's own is_final does.
    findColumnMock.mockResolvedValue({ isFinal: true });

    await expect(resolveColumnFinality("project-1", "shipped")).resolves.toBe(
      true,
    );
  });

  it('reports a column named "Done" as NOT final when it is not', async () => {
    findColumnMock.mockResolvedValue({ isFinal: false });

    await expect(resolveColumnFinality("project-1", "done")).resolves.toBe(
      false,
    );
  });

  it("yields undefined when the column row cannot be read", async () => {
    findColumnMock.mockRejectedValue(new Error("connection terminated"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      resolveColumnFinality("project-1", "done"),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledTimes(1);

    consoleError.mockRestore();
  });

  it("yields undefined when no column carries that slug", async () => {
    findColumnMock.mockResolvedValue(undefined);

    await expect(
      resolveColumnFinality("project-1", "nonexistent"),
    ).resolves.toBeUndefined();
  });

  it("yields undefined without a lookup when either argument is absent", async () => {
    await expect(
      resolveColumnFinality(undefined, "done"),
    ).resolves.toBeUndefined();
    await expect(
      resolveColumnFinality("project-1", ""),
    ).resolves.toBeUndefined();
    expect(findColumnMock).not.toHaveBeenCalled();
  });
});

describe("the transition payload carries the fact", () => {
  it("sends both finality flags on task.status_changed", async () => {
    findColumnMock
      .mockResolvedValueOnce({ isFinal: false })
      .mockResolvedValueOnce({ isFinal: true });
    mockOneDelivery();

    await handleTaskStatusChanged(statusChangedEvent, enabledContext);

    expect(postToGenericWebhook).toHaveBeenCalledTimes(1);
    expect(deliveredData()).toMatchObject({
      oldStatus: "in-progress",
      newStatus: "done",
      oldStatusIsFinal: false,
      newStatusIsFinal: true,
    });
  });

  it("omits a flag rather than sending false when the lookup fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    findColumnMock.mockRejectedValue(new Error("connection terminated"));
    mockOneDelivery();

    await handleTaskStatusChanged(statusChangedEvent, enabledContext);

    const data = deliveredData();
    expect(data).toMatchObject({ oldStatus: "in-progress", newStatus: "done" });
    expect(data).not.toHaveProperty("oldStatusIsFinal");
    expect(data).not.toHaveProperty("newStatusIsFinal");

    consoleError.mockRestore();
  });

  it("resolves each slug against its own project on task.moved", async () => {
    // Finality is a per-project column setting, so the old slug belongs to the
    // SOURCE project and the new slug to the DESTINATION. Resolving both against
    // one project would report a same-named column from the wrong board.
    findColumnMock.mockResolvedValue({ isFinal: false });
    mockOneDelivery();

    await handleTaskMoved(movedEvent, enabledContext);

    expect(vi.mocked(resolveColumnFinality).mock.calls).toEqual([
      ["project-1", "in-progress"],
      ["project-2", "shipped"],
    ]);
    expect(postToGenericWebhook).toHaveBeenCalledTimes(1);
    expect(deliveredData()).toMatchObject({
      oldStatus: "in-progress",
      newStatus: "shipped",
      oldStatusIsFinal: false,
      newStatusIsFinal: false,
    });
  });
});
