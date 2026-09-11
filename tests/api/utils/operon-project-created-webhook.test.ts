import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOperonProjectCreatedPayload,
  deliverOperonProjectCreated,
  initOperonProjectCreatedDelivery,
  OPERON_PROJECT_CREATED_RETRY_BACKOFF_MS,
  OPERON_PROJECT_CREATED_TIMEOUT_MS,
  startOperonProjectCreatedDelivery,
} from "../../../apps/api/src/operon-project-created";
import { postToGenericWebhook } from "../../../apps/api/src/plugins/generic-webhook/client";

/**
 * A PROJECT ANNOUNCES ITSELF — the creation event, and who created it.
 *
 * At the fork point `project/controllers/create-project.ts` published nothing: it was the
 * only lifecycle write in the codebase with no `publishEvent`. Operon's consequence was not
 * a missing feed row but a missing DELIVERY PATH — the platform provisioned each project's
 * `generic-webhook` integration from a five-minute polling sweep, so every event in a new
 * project's first minutes was lost, and the project's own creation never reached the ledger
 * at all.
 *
 * The three properties asserted here are the ones that make the fix real rather than
 * plausible:
 *
 *   PUBLISHED    the controller publishes `project.created`, with the CREATOR on it. A fix
 *                that only added the delivery would deliver nothing, forever.
 *   DELIVERED    the subscriber posts it to Operon's receiver, signed, with the actor
 *                resolved — and with NO `task` key, because there is no task.
 *   INERT        both configuration values absent — every deployment that is not Operon's —
 *                delivers nothing and raises nothing.
 *   AWAITED      `createProject()` does not resolve until the delivery has settled. Code gate
 *                round 1, finding 1: `publishEvent` is `EventEmitter.emit`, which does not
 *                await an async listener, so publishing alone reopened the very window this
 *                event closes — one frame narrower.
 *   BOUNDED      …but a delivery that never answers does not hold the project hostage: the
 *                create resolves after `OPERON_PROJECT_CREATED_TIMEOUT_MS` and the delivery
 *                keeps retrying behind it.
 *   RETRIED      a refused delivery (Operon down, 503) is retried on the backoff ladder and
 *                stops the moment a 2xx — Operon's 202 included — comes back.
 *
 * Upstream's own suites are not edited, the standing choice of rows 8, 10 and 11.
 */

const { selectMock, txMock, subscriptions } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  txMock: vi.fn(),
  subscriptions: new Map<string, (data: unknown) => Promise<void>>(),
}));

vi.mock("../../../apps/api/src/plugins/generic-webhook/client", () => ({
  postToGenericWebhook: vi.fn(),
}));

// The real bus is an `EventEmitter`; capturing the subscription instead lets the published
// body be inspected directly, which is the half of the fix that lives in the controller.
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
  default: { select: selectMock, transaction: txMock },
}));

/** `resolveActor`'s single lookup. */
function selectChain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({ limit: () => Promise.resolve(rows) }),
    }),
  };
}

const EVENT = {
  projectId: "project-1",
  workspaceId: "workspace-1",
  name: "Roadmap",
  slug: "ROAD",
  icon: "Layers",
  currentUserId: "user-a",
};

const DESTINATION = "http://platform-service:3001";
const SECRET = "test-only-secret";

function lastPost() {
  const [url, payload, secret] =
    vi.mocked(postToGenericWebhook).mock.calls[0] ?? [];
  return { url, payload: payload as Record<string, never>, secret };
}

describe("project.created — publication and workspace-level delivery", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.mocked(postToGenericWebhook).mockReset();
    vi.mocked(postToGenericWebhook).mockResolvedValue(undefined);
    selectMock.mockReset();
    // `resolveActor`'s lookup, for every case that does not override it with `…Once`.
    selectMock.mockImplementation(() =>
      selectChain([{ id: "user-a", name: "Ada" }]),
    );
    txMock.mockReset();
    process.env.OPERON_INTERNAL_API_URL = DESTINATION;
    process.env.KANEO_WEBHOOK_SECRET = SECRET;
    process.env.KANEO_CLIENT_URL = "https://initiative.example";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("publishes project.created, naming the creator, once the row has COMMITTED", async () => {
    const { publishEvent } = await import("../../../apps/api/src/events");
    const createProject = (
      await import("../../../apps/api/src/project/controllers/create-project")
    ).default;

    const row = {
      id: "project-1",
      workspaceId: "workspace-1",
      name: "Roadmap",
      slug: "ROAD",
      icon: "Layers",
    };
    // The transaction resolves to the created row, exactly as the real one does; the publish
    // has to happen after this callback returns, never inside it.
    txMock.mockImplementation(async () => row);

    await createProject("workspace-1", "Roadmap", "Layers", "ROAD", "user-a");

    expect(publishEvent).toHaveBeenCalledWith("project.created", {
      projectId: "project-1",
      workspaceId: "workspace-1",
      name: "Roadmap",
      slug: "ROAD",
      icon: "Layers",
      currentUserId: "user-a",
    });
  });

  it("delivers the event to Operon's receiver, signed, with the actor resolved", async () => {
    selectMock.mockImplementationOnce(() =>
      selectChain([{ id: "user-a", name: "Ada" }]),
    );

    const result = await deliverOperonProjectCreated(
      EVENT,
      new Date("2026-09-11T14:00:00.000Z"),
    );

    expect(result).toEqual({ delivered: true, skipped: null });
    const { url, payload, secret } = lastPost();
    expect(url).toBe("http://platform-service:3001/webhooks/kaneo");
    expect(secret).toBe(SECRET);
    expect(payload.event).toBe("project.created");
    expect(payload.actor).toEqual({ id: "user-a", name: "Ada" });
    expect(payload.project).toEqual({
      id: "project-1",
      name: "Roadmap",
      workspaceId: "workspace-1",
      url: "https://initiative.example/dashboard/workspace/workspace-1/project/project-1",
    });
    // There is no task, so the envelope must not claim one — a receiver that reads `task.id`
    // on every delivery has to be able to tell this event apart by more than its name.
    expect(payload).not.toHaveProperty("task");
  });

  it("reports a null actor rather than inventing one when no creator is named", async () => {
    const payload = buildOperonProjectCreatedPayload(
      { ...EVENT, currentUserId: null },
      { id: null, name: null },
      "2026-09-11T14:00:00.000Z",
    );

    expect(payload.actor).toEqual({ id: null, name: null });
  });

  it("delivers NOTHING when the instance is not configured for Operon", async () => {
    process.env.OPERON_INTERNAL_API_URL = "";
    process.env.KANEO_WEBHOOK_SECRET = "";

    const result = await deliverOperonProjectCreated(EVENT);

    expect(result).toEqual({ delivered: false, skipped: "not_configured" });
    expect(postToGenericWebhook).not.toHaveBeenCalled();
  });

  it("swallows a receiver failure — the project is already created", async () => {
    selectMock.mockImplementationOnce(() => selectChain([]));
    vi.mocked(postToGenericWebhook).mockRejectedValueOnce(
      new Error("connection refused"),
    );

    await expect(deliverOperonProjectCreated(EVENT)).resolves.toEqual({
      delivered: false,
      skipped: "delivery_failed",
    });
  });

  it("does not answer the create until the delivery has SETTLED", async () => {
    const createProject = (
      await import("../../../apps/api/src/project/controllers/create-project")
    ).default;

    txMock.mockImplementation(async () => ({
      id: "project-awaited",
      workspaceId: "workspace-1",
      name: "Roadmap",
      slug: "ROAD",
      icon: "Layers",
    }));

    // The delivery is held open. `EventEmitter.emit` would have let the create sail past it.
    let release = () => {};
    vi.mocked(postToGenericWebhook).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );

    let resolved = false;
    const create = createProject(
      "workspace-1",
      "Roadmap",
      "Layers",
      "ROAD",
      "user-a",
    ).then((value) => {
      resolved = true;
      return value;
    });

    // Several turns of the loop — far more than an un-awaited publish would need.
    await new Promise((r) => setTimeout(r, 0));
    expect(postToGenericWebhook).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    release();
    await create;
    expect(resolved).toBe(true);
  });

  it("answers the create anyway when the delivery never comes back", async () => {
    vi.useFakeTimers();
    try {
      const createProject = (
        await import("../../../apps/api/src/project/controllers/create-project")
      ).default;

      txMock.mockImplementation(async () => ({
        id: "project-timeout",
        workspaceId: "workspace-1",
        name: "Roadmap",
        slug: "ROAD",
        icon: "Layers",
      }));

      // An Operon that accepts the connection and never answers. Unbounded, this would hang
      // project creation for the whole 10 s client timeout and then some.
      vi.mocked(postToGenericWebhook).mockImplementation(
        () => new Promise<void>(() => {}),
      );

      const create = createProject(
        "workspace-1",
        "Roadmap",
        "Layers",
        "ROAD",
        "user-a",
      );

      await vi.advanceTimersByTimeAsync(OPERON_PROJECT_CREATED_TIMEOUT_MS + 1);

      await expect(create).resolves.toMatchObject({ id: "project-timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a refused delivery in the background, and stops on a 2xx", async () => {
    vi.useFakeTimers();
    try {
      // What `postToGenericWebhook` throws for a 503 — the shape Operon returns when its
      // signal writer is not running. The third attempt is Operon's 202/200: `response.ok`,
      // so the client resolves and the ladder stops.
      vi.mocked(postToGenericWebhook)
        .mockRejectedValueOnce(
          new Error("Generic webhook request failed (503): unavailable"),
        )
        .mockRejectedValueOnce(
          new Error("Generic webhook request failed (503): unavailable"),
        )
        .mockResolvedValueOnce(undefined);

      const delivery = startOperonProjectCreatedDelivery({
        ...EVENT,
        projectId: "project-retried",
      });

      await vi.advanceTimersByTimeAsync(
        OPERON_PROJECT_CREATED_RETRY_BACKOFF_MS[0] +
          OPERON_PROJECT_CREATED_RETRY_BACKOFF_MS[1] +
          10,
      );

      await expect(delivery).resolves.toEqual({
        delivered: true,
        skipped: null,
      });
      // Three attempts, not four: a delivered 2xx ends the ladder.
      expect(postToGenericWebhook).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires the published event to the delivery", async () => {
    initOperonProjectCreatedDelivery();
    const onPublished = subscriptions.get("project.created");
    expect(onPublished).toBeTypeOf("function");

    selectMock.mockImplementationOnce(() =>
      selectChain([{ id: "user-a", name: "Ada" }]),
    );
    await onPublished?.(EVENT);

    expect(postToGenericWebhook).toHaveBeenCalledTimes(1);
    expect(lastPost().payload.project).toMatchObject({ id: "project-1" });
  });
});
