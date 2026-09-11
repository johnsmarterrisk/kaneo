import { beforeEach, describe, expect, it, vi } from "vitest";
import { postToGenericWebhook } from "../../../apps/api/src/plugins/generic-webhook/client";
import { handleTaskCreated } from "../../../apps/api/src/plugins/generic-webhook/events";
import {
  initializeEventSubscriptions,
  registerPlugin,
} from "../../../apps/api/src/plugins/registry";
import type { TaskCreatedEvent } from "../../../apps/api/src/plugins/types";

/**
 * WHO CREATED THE TASK — the actor on the outbound `task.created` webhook.
 *
 * `task.created` carries TWO people and upstream names only one of them `userId`: the
 * ASSIGNEE. `notification/index.ts` reads it that way (`data.userId !== data.currentUserId`
 * — notify the assignee unless they created it themselves), so the field cannot be
 * repurposed. `handleTaskCreated` nonetheless fed it to `getActor`, which named the assignee
 * as the actor on an assigned task and NOBODY on an unassigned one — every Operon ledger row
 * for a task creation lost its actor.
 *
 * Both halves of the fix are asserted here, because either one alone leaves the bug:
 * `registry.ts` rebuilds the event from named fields and dropped `currentUserId` before any
 * plugin could see it, so a handler reading it would have read `undefined`.
 *
 * Upstream's own `tests/api/plugins/generic-webhook/events.test.ts` is deliberately NOT
 * edited — one fewer conflict at the next upstream merge, the same choice rows 8 and 10 of
 * `docs/fork-discipline.md` made.
 */

const { selectMock, findFirstMock, findManyMock, subscriptions } = vi.hoisted(
  () => ({
    selectMock: vi.fn(),
    findFirstMock: vi.fn(),
    findManyMock: vi.fn(),
    subscriptions: new Map<string, (data: unknown) => Promise<void>>(),
  }),
);

vi.mock("../../../apps/api/src/plugins/generic-webhook/client", () => ({
  postToGenericWebhook: vi.fn(),
}));

// Captures what `registry.ts` subscribes, so the rebuilt event it hands each plugin can be
// inspected. The dropped field was invisible from `broadcastTaskCreated` downwards.
vi.mock("../../../apps/api/src/events", () => ({
  subscribeToEvent: (
    name: string,
    handler: (data: unknown) => Promise<void>,
  ) => {
    subscriptions.set(name, handler);
  },
  publishEvent: vi.fn(),
}));

vi.mock("../../../apps/api/src/database", () => ({
  default: {
    select: selectMock,
    query: {
      integrationTable: {
        findFirst: findFirstMock,
        findMany: findManyMock,
      },
    },
  },
}));

/** `getTaskData`'s join, then `getActor`'s lookup — the two selects `sendEvent` makes. */
function selectChain(rows: unknown[]) {
  return {
    from: () => ({
      innerJoin: () => ({
        innerJoin: () => ({
          leftJoin: () => ({
            where: () => ({ limit: () => Promise.resolve(rows) }),
          }),
        }),
      }),
      where: () => ({ limit: () => Promise.resolve(rows) }),
    }),
  };
}

const TASK_ROW = {
  id: "task-1",
  title: "Ship the release",
  number: 7,
  status: "to-do",
  priority: "low",
  columnName: "To Do",
  projectId: "project-1",
  projectName: "Roadmap",
  workspaceId: "workspace-1",
};

const enabledContext = {
  integrationId: "integration-1",
  projectId: "project-1",
  config: {
    webhookUrl: "https://example.com/hooks/kaneo",
    events: { taskCreated: true },
  },
};

/** Created by A, assigned to B — the two people the payload has to keep apart. */
const createdByAAssignedToB: TaskCreatedEvent = {
  taskId: "task-1",
  projectId: "project-1",
  userId: "user-b",
  currentUserId: "user-a",
  title: "Ship the release",
  description: "initial description",
  priority: "low",
  status: "to-do",
  number: 7,
};

function actorOfLastPost() {
  const [, payload] = vi.mocked(postToGenericWebhook).mock.calls[0] ?? [];
  return (payload as { actor: { id: string | null; name: string | null } })
    .actor;
}

describe("task.created actor attribution", () => {
  beforeEach(() => {
    vi.mocked(postToGenericWebhook).mockClear();
    selectMock.mockReset();
    findFirstMock.mockReset();
    findManyMock.mockReset();
    findFirstMock.mockResolvedValue(undefined);
    findManyMock.mockResolvedValue([]);
  });

  it("names the creator, not the assignee, when the two differ", async () => {
    // The user lookup answers NOTHING on purpose. `getActor` then echoes the id it was
    // handed, so the id in the payload is direct evidence of WHICH field was read — a mock
    // that returned a row would report the same person either way and prove nothing.
    selectMock
      .mockImplementationOnce(() => selectChain([TASK_ROW]))
      .mockImplementationOnce(() => selectChain([]));

    await handleTaskCreated(createdByAAssignedToB, enabledContext);

    expect(postToGenericWebhook).toHaveBeenCalledTimes(1);
    expect(actorOfLastPost()).toEqual({ id: "user-a", name: null });
  });

  it("names the creator on an UNASSIGNED task — the reported repro", async () => {
    selectMock
      .mockImplementationOnce(() => selectChain([TASK_ROW]))
      .mockImplementationOnce(() =>
        selectChain([{ id: "user-a", name: "Ada" }]),
      );

    // An unassigned task publishes `userId: ""`, which `getActor` treats as no actor at
    // all — this is the row that reached the ledger with a null actor.
    await handleTaskCreated(
      { ...createdByAAssignedToB, userId: "" },
      enabledContext,
    );

    expect(actorOfLastPost()).toEqual({ id: "user-a", name: "Ada" });
  });

  it("reports no actor rather than the assignee when the emitter names no creator", async () => {
    selectMock
      .mockImplementationOnce(() => selectChain([TASK_ROW]))
      .mockImplementationOnce(() =>
        selectChain([{ id: "user-b", name: "Bob" }]),
      );

    // The gitea webhook emitters publish no `currentUserId` — the creator is Gitea, not a
    // Kaneo user. A null actor is true; the assignee would be a lie. The assignee's row is
    // made available to the lookup so that reading it would be VISIBLE here.
    await handleTaskCreated(
      { ...createdByAAssignedToB, currentUserId: undefined },
      enabledContext,
    );

    expect(actorOfLastPost()).toEqual({ id: null, name: null });
  });

  it("carries currentUserId across the event bus to the plugin handler", async () => {
    const received: TaskCreatedEvent[] = [];
    registerPlugin({
      type: "operon-actor-probe",
      name: "Operon actor probe",
      onTaskCreated: async (event) => {
        received.push(event);
      },
      validateConfig: async () => ({ valid: true }),
    });
    findManyMock.mockResolvedValue([
      {
        id: "integration-1",
        projectId: "project-1",
        type: "operon-actor-probe",
        config: "{}",
      },
    ]);

    initializeEventSubscriptions();
    const onPublished = subscriptions.get("task.created");
    expect(onPublished).toBeTypeOf("function");

    // The shape `create-task.ts` and `import-tasks.ts` actually publish.
    await onPublished?.({
      taskId: "task-1",
      projectId: "project-1",
      userId: "user-b",
      currentUserId: "user-a",
      title: "Ship the release",
      description: "initial description",
      priority: "low",
      status: "to-do",
      number: 7,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.currentUserId).toBe("user-a");
    // Upstream's meaning of `userId` survives: `notification/index.ts` needs the assignee.
    expect(received[0]?.userId).toBe("user-b");
  });
});
