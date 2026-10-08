import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { initializePlugins } from "../../apps/api/src/plugins";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

/**
 * Operon fork checks (social agent S9, task 5): `task.social_revision`.
 *
 * Every title, description, due date, status or project write adds 1 in the same UPDATE;
 * the status-change and move webhooks carry the revision that write returned, and
 * `GET /task/{id}` returns the current one. Operon posts an approved card only when the two
 * agree. Comments, priority and reorders never advance it.
 *
 * The webhook is captured at the real generic-webhook transport (`fetch`), signed with the
 * integration's secret, so the test sees exactly the body Operon's /webhooks/kaneo reads.
 * Only the public-destination DNS check is stubbed, because the test destination is local.
 *
 * See `docs/fork-discipline.md` in the Operon repository.
 */

vi.mock("../../apps/api/src/plugins/generic-webhook/config", async (orig) => ({
  ...(await orig<
    typeof import("../../apps/api/src/plugins/generic-webhook/config")
  >()),
  assertPublicWebhookDestination: async () => {},
}));

const HOOK_URL = "https://operon.example.test/webhooks/kaneo";
const SECRET = "social-revision-test-secret";

type Delivery = {
  event: string;
  task: { id: string };
  data: Record<string, unknown>;
};

let deliveries: Delivery[] = [];

beforeAll(() => {
  // The server's boot registers the plugins (apps/api/src/index.ts); createApp does not.
  initializePlugins();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === HOOK_URL) {
        const body = String(init.body);
        const signature = (init.headers as Record<string, string>)[
          "X-Kaneo-Signature"
        ];
        expect(signature).toBe(
          createHmac("sha256", SECRET).update(body).digest("hex"),
        );
        deliveries.push(JSON.parse(body) as Delivery);
      }
      return new Response("ok", { status: 200 });
    }),
  );
});

async function waitForDeliveries(
  predicate: (all: Delivery[]) => boolean,
): Promise<Delivery[]> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate(deliveries)) return deliveries;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `webhook not delivered; got ${JSON.stringify(deliveries.map((d) => d.event))}`,
  );
}

async function seed() {
  const member = await createWorkspaceMember();
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
    name: "Rella",
  });
  const { project: other } = await createProjectFixture({
    workspaceId: member.workspace.id,
    name: "Elsewhere",
  });
  for (const projectId of [project.id, other.id]) {
    await db.insert(schema.integrationTable).values({
      projectId,
      type: "generic-webhook",
      config: JSON.stringify({
        webhookUrl: HOOK_URL,
        secret: SECRET,
        events: { taskStatusChanged: true, taskMoved: true },
      }),
      isActive: true,
    });
  }
  const insertTask = async (title: string, number: number) => {
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title,
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number,
        position: number,
      })
      .returning();
    if (!task) throw new Error("task insert failed");
    return task;
  };
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api/task${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const revisionOf = async (taskId: string) => {
    const response = await send("GET", `/${taskId}`);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { socialRevision: number };
    return json.socialRevision;
  };
  return { app, project, other, insertTask, send, revisionOf };
}

describe("API integration: Operon social revision (social agent S9)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    deliveries = [];
  });

  it("starts an existing card at revision 0 and returns it on GET /task", async () => {
    const { insertTask, revisionOf } = await seed();
    const task = await insertTask("Launch post", 1);
    expect(task.socialRevision).toBe(0);
    expect(await revisionOf(task.id)).toBe(0);
  });

  it("advances on title, description, due date and status edits, and the status webhook carries the returned revision", async () => {
    const { insertTask, send, revisionOf } = await seed();
    const task = await insertTask("Launch post", 1);

    expect(
      (await send("PUT", `/title/${task.id}`, { title: "Launch post v2" }))
        .status,
    ).toBe(200);
    expect(await revisionOf(task.id)).toBe(1);
    expect(
      (
        await send("PUT", `/description/${task.id}`, {
          description: "Caption: hello",
        })
      ).status,
    ).toBe(200);
    expect(await revisionOf(task.id)).toBe(2);
    expect(
      (
        await send("PUT", `/due-date/${task.id}`, {
          dueDate: "2026-10-09T15:00:00.000Z",
        })
      ).status,
    ).toBe(200);
    expect(await revisionOf(task.id)).toBe(3);

    expect(
      (await send("PUT", `/status/${task.id}`, { status: "in-review" })).status,
    ).toBe(200);
    expect(await revisionOf(task.id)).toBe(4);

    const [delivery] = await waitForDeliveries((all) =>
      all.some((d) => d.event === "task.status_changed"),
    );
    expect(delivery?.event).toBe("task.status_changed");
    expect(delivery?.data.newStatus).toBe("in-review");
    expect(delivery?.data.socialRevision).toBe(4);
  });

  it("does not advance on a comment, a priority change or an unchanged title", async () => {
    const { app, insertTask, send, revisionOf } = await seed();
    const task = await insertTask("Launch post", 1);

    const comment = await app.request(`/api/comment/${task.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Looks good" }),
    });
    expect(comment.status).toBe(200);
    expect(
      (await send("PUT", `/priority/${task.id}`, { priority: "high" })).status,
    ).toBe(200);
    expect(
      (await send("PUT", `/title/${task.id}`, { title: "Launch post" })).status,
    ).toBe(200);
    // A status write to the status the card already has is not an edit.
    expect(
      (await send("PUT", `/status/${task.id}`, { status: "to-do" })).status,
    ).toBe(200);

    expect(await revisionOf(task.id)).toBe(0);
  });

  it("gives two concurrent edits distinct increasing revisions", async () => {
    const { insertTask, send, revisionOf } = await seed();
    const task = await insertTask("Launch post", 1);

    const results = await Promise.all([
      send("PUT", `/title/${task.id}`, { title: "Edit A" }),
      send("PUT", `/description/${task.id}`, { description: "Edit B" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const [rowA, rowB] = (await Promise.all(results.map((r) => r.json()))) as {
      socialRevision: number;
    }[];
    expect([rowA?.socialRevision, rowB?.socialRevision].sort()).toEqual([1, 2]);
    expect(await revisionOf(task.id)).toBe(2);
  });

  it("sends each bulk status move its own returned revision", async () => {
    const { insertTask, send, revisionOf } = await seed();
    const first = await insertTask("Post one", 1);
    const second = await insertTask("Post two", 2);
    expect(
      (await send("PUT", `/title/${second.id}`, { title: "Post two, edited" }))
        .status,
    ).toBe(200);

    const bulk = await send("PATCH", "/bulk", {
      taskIds: [first.id, second.id],
      operation: "updateStatus",
      value: "in-review",
    });
    expect(bulk.status).toBe(200);

    const all = await waitForDeliveries(
      (d) => d.filter((x) => x.event === "task.status_changed").length === 2,
    );
    const byTask = new Map(
      all
        .filter((d) => d.event === "task.status_changed")
        .map((d) => [d.task.id, d.data.socialRevision]),
    );
    expect(byTask.get(first.id)).toBe(1);
    expect(byTask.get(second.id)).toBe(2);
    expect(await revisionOf(first.id)).toBe(1);
    expect(await revisionOf(second.id)).toBe(2);
  });

  it("sends no status_changed for a bulk write to a card's existing status, and oldStatus for a real move", async () => {
    const { insertTask, send } = await seed();
    const already = await insertTask("Already there", 1);
    const moving = await insertTask("Moving", 2);
    expect(
      (await send("PUT", `/status/${already.id}`, { status: "in-review" }))
        .status,
    ).toBe(200);
    await waitForDeliveries(
      (d) => d.filter((x) => x.event === "task.status_changed").length === 1,
    );
    deliveries = [];

    const bulk = await send("PATCH", "/bulk", {
      taskIds: [already.id, moving.id],
      operation: "updateStatus",
      value: "in-review",
    });
    expect(bulk.status).toBe(200);

    await waitForDeliveries(
      (d) => d.filter((x) => x.event === "task.status_changed").length >= 1,
    );
    // Give a wrongly emitted second delivery time to arrive before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const changed = deliveries.filter((d) => d.event === "task.status_changed");
    expect(changed.map((d) => d.task.id)).toEqual([moving.id]);
    expect(changed[0]?.data.oldStatus).toBe("to-do");
    expect(changed[0]?.data.newStatus).toBe("in-review");
  });

  it("advances on a cross-project move and the move webhook carries the returned revision", async () => {
    const { other, insertTask, send, revisionOf } = await seed();
    const task = await insertTask("Moving post", 1);

    const moved = await send("PUT", `/move/${task.id}`, {
      destinationProjectId: other.id,
      destinationStatus: "in-review",
    });
    expect(moved.status).toBe(200);

    const all = await waitForDeliveries((d) =>
      d.some((x) => x.event === "task.moved"),
    );
    const delivery = all.find((d) => d.event === "task.moved");
    expect(delivery?.data.toProjectId).toBe(other.id);
    expect(delivery?.data.socialRevision).toBe(1);
    expect(await revisionOf(task.id)).toBe(1);
  });

  it("counts only covered fields through the full update route", async () => {
    const { project, insertTask, send, revisionOf } = await seed();
    const task = await insertTask("Full update", 1);
    const base = {
      title: "Full update",
      status: "to-do",
      projectId: project.id,
      description: "",
      priority: "medium",
      position: 1,
    };
    const [row] = await db
      .select({ description: schema.taskTable.description })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    // The seeded description is NULL; the full update stores "" and that IS a change.
    expect(row?.description).toBeNull();
    expect((await send("PUT", `/${task.id}`, base)).status).toBe(200);
    expect(await revisionOf(task.id)).toBe(1);

    // Priority and position only: no covered field changes.
    expect(
      (
        await send("PUT", `/${task.id}`, {
          ...base,
          priority: "high",
          position: 7,
        })
      ).status,
    ).toBe(200);
    expect(await revisionOf(task.id)).toBe(1);

    expect(
      (await send("PUT", `/${task.id}`, { ...base, status: "in-review" }))
        .status,
    ).toBe(200);
    expect(await revisionOf(task.id)).toBe(2);
    const all = await waitForDeliveries((d) =>
      d.some((x) => x.event === "task.status_changed"),
    );
    expect(
      all.find((d) => d.event === "task.status_changed")?.data.socialRevision,
    ).toBe(2);
  });
});
