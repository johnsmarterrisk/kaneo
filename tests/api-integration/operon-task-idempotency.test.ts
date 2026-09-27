import { and, count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auth, OPERON_SERVICE_KEY_PERMISSIONS } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

/**
 * Operon fork checks (Smart Desk F0b, task T1: F1–F7, D1–D3).
 *
 * `POST /task/{projectId}` honours `Idempotency-Key` from Operon's MARKED service key
 * only. A repeat of a key answers with the task that already carries it (200,
 * `Idempotent-Replay: true`) and creates no task, number or activity row; a key owned
 * by a task in another workspace answers 409 with no task data; two concurrent creates
 * leave one task. Every other caller, and every create without the header, behaves as
 * upstream built it.
 *
 * See `docs/fork-discipline.md` in the Operon repository.
 */

const ON_BEHALF_OF = "X-Operon-On-Behalf-Of";
const IDEMPOTENCY_KEY = "Idempotency-Key";

type App = ReturnType<typeof createApp>["app"];

async function mintKey(userId: string, marked: boolean) {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: `f0b-${marked ? "service" : "plain"}-${Date.now() % 100000}`,
      permissions: OPERON_SERVICE_KEY_PERMISSIONS,
      ...(marked ? { metadata: { operonService: true } } : {}),
    },
  });
  if (!created?.key) throw new Error("failed to mint a test api key");
  return created.key;
}

async function seedDesk() {
  const owner = await createWorkspaceMember({ role: "owner" });
  const { project, columns } = await createProjectFixture({
    workspaceId: owner.workspace.id,
  });
  const teammate = await createWorkspaceMember({
    role: "member",
    userName: "Teammate Tess",
  });
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: owner.workspace.id,
    userId: teammate.user.id,
    role: "member",
    joinedAt: new Date(),
  });
  const serviceKey = await mintKey(owner.user.id, true);
  const { app } = createApp();
  const headers = (key: string) => ({
    "x-api-key": serviceKey,
    [ON_BEHALF_OF]: teammate.user.id,
    [IDEMPOTENCY_KEY]: key,
  });
  return { owner, teammate: teammate.user, project, columns, app, headers };
}

function createTask(
  app: App,
  projectId: string,
  headers: Record<string, string>,
  body: Record<string, unknown> = {},
) {
  return app.request(`/api/task/${projectId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      title: "From the desk",
      description: "",
      priority: "low",
      status: "to-do",
      ...body,
    }),
  });
}

async function taskCount() {
  const [row] = await db.select({ n: count() }).from(schema.taskTable);
  return row?.n ?? 0;
}

async function activityCount() {
  const [row] = await db.select({ n: count() }).from(schema.activityTable);
  return row?.n ?? 0;
}

async function tasksWithKey(key: string) {
  return db
    .select()
    .from(schema.taskTable)
    .where(eq(schema.taskTable.operonIdempotencyKey, key));
}

/**
 * The `task.created` subscriber writes its activity row fire-and-forget: wait for the
 * create's row to land, then let the bus settle so a replay's (absent) row would have
 * had time to appear before the count is compared.
 */
async function settledActivityCount(taskId?: string) {
  if (taskId) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const [row] = await db
        .select({ id: schema.activityTable.id })
        .from(schema.activityTable)
        .where(eq(schema.activityTable.taskId, taskId));
      if (row) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  return activityCount();
}

/** Create once, then return the create's body and the counts a replay must not move. */
async function createOnce(
  app: App,
  projectId: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
) {
  const response = await createTask(app, projectId, headers, body);
  expect(response.status).toBe(200);
  expect(response.headers.get("Idempotent-Replay")).toBeNull();
  const created = await response.json();
  return {
    created,
    tasks: await taskCount(),
    activities: await settledActivityCount(created.id),
  };
}

async function expectReplay(
  response: Response,
  expected: { tasks: number; activities: number },
) {
  expect(response.status).toBe(200);
  expect(response.headers.get("Idempotent-Replay")).toBe("true");
  expect(await taskCount()).toBe(expected.tasks);
  expect(await settledActivityCount()).toBe(expected.activities);
  return response.json();
}

describe("API integration: Operon Idempotency-Key on task create (Smart Desk F0b)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("F1/F3: the marked key's header is stored on the task and read back by GET /task/{id}", async () => {
    const { project, app, headers } = await seedDesk();

    const { created } = await createOnce(app, project.id, headers("desk:t1:0"));

    expect(created.operonIdempotencyKey).toBe("desk:t1:0");
    const rows = await tasksWithKey("desk:t1:0");
    expect(rows.map((row) => row.id)).toEqual([created.id]);

    const read = await app.request(`/api/task/${created.id}`, {
      headers: { "x-api-key": headers("x")["x-api-key"] },
    });
    expect(read.status).toBe(200);
    expect((await read.json()).operonIdempotencyKey).toBe("desk:t1:0");
  });

  it("F2: an invalid key answers 400 and creates nothing; 200 characters of the alphabet is accepted", async () => {
    const { project, app, headers } = await seedDesk();

    for (const bad of ["", "has space", "slash/key", "ü", "a".repeat(201)]) {
      const response = await createTask(app, project.id, headers(bad));
      expect(response.status).toBe(400);
    }
    expect(await taskCount()).toBe(0);

    const longest = `${"A".repeat(196)}:_-9`;
    expect(longest).toHaveLength(200);
    const ok = await createTask(app, project.id, headers(longest));
    expect(ok.status).toBe(200);
    expect(await tasksWithKey(longest)).toHaveLength(1);
  });

  it("F4: a repeat answers with the first task in the create's shape and creates no task, number or activity", async () => {
    const { project, app, headers } = await seedDesk();
    const first = await createOnce(app, project.id, headers("desk:t4:0"));

    const replayed = await expectReplay(
      await createTask(app, project.id, headers("desk:t4:0"), {
        title: "A different title the replay must not apply",
      }),
      first,
    );

    expect(replayed).toEqual(first.created);
    expect(await tasksWithKey("desk:t4:0")).toHaveLength(1);

    // No task number was consumed: the next ordinary create takes the next number.
    const next = await createTask(app, project.id, headers("desk:t4:1"));
    expect((await next.json()).number).toBe(first.created.number + 1);
  });

  it("F4: a replay still answers after the task's status column was removed", async () => {
    const { project, columns, app, headers } = await seedDesk();
    const first = await createOnce(app, project.id, headers("desk:col:0"));

    await db
      .delete(schema.columnTable)
      .where(eq(schema.columnTable.id, columns.todo.id));

    // Control: a fresh create with that status is now refused by createTask.
    expect(
      (await createTask(app, project.id, headers("desk:col:fresh"))).status,
    ).toBe(400);

    const replayed = await expectReplay(
      await createTask(app, project.id, headers("desk:col:0")),
      first,
    );
    expect(replayed.id).toBe(first.created.id);
  });

  it("F4: a replay with a schema-valid but invalid date range answers with the task", async () => {
    const { project, app, headers } = await seedDesk();
    const first = await createOnce(app, project.id, headers("desk:date:0"));
    const backwards = {
      startDate: "2026-10-10T00:00:00.000Z",
      dueDate: "2026-10-01T00:00:00.000Z",
    };

    // Control: the same body without a replay is refused by the range check.
    expect(
      (await createTask(app, project.id, headers("desk:date:fresh"), backwards))
        .status,
    ).toBe(400);

    const replayed = await expectReplay(
      await createTask(app, project.id, headers("desk:date:0"), backwards),
      first,
    );
    expect(replayed.id).toBe(first.created.id);
  });

  it("F4: a replay of an assigned task maps exactly as its create, assignee name included", async () => {
    const { project, teammate, app, headers } = await seedDesk();
    const first = await createOnce(app, project.id, headers("desk:asg:0"), {
      userId: teammate.id,
    });
    expect(first.created.assigneeName).toBe("Teammate Tess");

    // The replay's body names no assignee; the answer is the stored task.
    const replayed = await expectReplay(
      await createTask(app, project.id, headers("desk:asg:0")),
      first,
    );
    expect(replayed).toEqual(first.created);
  });

  it("F4: a replay of a task moved to another project in the workspace answers with its current project", async () => {
    const { owner, project, app, headers } = await seedDesk();
    const { project: other } = await createProjectFixture({
      workspaceId: owner.workspace.id,
    });
    const first = await createOnce(app, project.id, headers("desk:mv:0"));

    await db
      .update(schema.taskTable)
      .set({ projectId: other.id })
      .where(eq(schema.taskTable.id, first.created.id));

    const replayed = await expectReplay(
      await createTask(app, project.id, headers("desk:mv:0")),
      first,
    );
    expect(replayed.id).toBe(first.created.id);
    expect(replayed.projectId).toBe(other.id);
  });

  it("F5: a key owned by a task in another workspace answers 409 idempotency_key_conflict with no task data", async () => {
    const desk = await seedDesk();
    const first = await createOnce(
      desk.app,
      desk.project.id,
      desk.headers("desk:ws:0"),
    );

    const elsewhere = await createWorkspaceMember({ role: "owner" });
    const { project: foreign } = await createProjectFixture({
      workspaceId: elsewhere.workspace.id,
    });
    const foreignKey = await mintKey(elsewhere.user.id, true);

    const response = await createTask(desk.app, foreign.id, {
      "x-api-key": foreignKey,
      [ON_BEHALF_OF]: elsewhere.user.id,
      [IDEMPOTENCY_KEY]: "desk:ws:0",
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("idempotency_key_conflict");
    expect(JSON.stringify(body)).not.toContain(first.created.id);
    expect(JSON.stringify(body)).not.toContain("From the desk");
    expect(await taskCount()).toBe(first.tasks);
    expect(await settledActivityCount()).toBe(first.activities);
  });

  it("F6: concurrent creates with one key leave exactly one task, and every answer carries its id", async () => {
    const { project, app, headers } = await seedDesk();

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        createTask(app, project.id, headers("desk:race:0")),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    const ids = new Set(
      await Promise.all(
        responses.map(async (response) => (await response.json()).id),
      ),
    );
    const rows = await tasksWithKey("desk:race:0");
    expect(rows).toHaveLength(1);
    expect([...ids]).toEqual([rows[0]?.id]);
    expect(await taskCount()).toBe(1);
    expect(
      responses.filter(
        (response) => response.headers.get("Idempotent-Replay") === "true",
      ),
    ).toHaveLength(3);
  });

  it("F1: the header from a caller that is not the marked key is ignored", async () => {
    const { owner, project, app } = await seedDesk();
    const plainKey = await mintKey(owner.user.id, false);
    const plain = { "x-api-key": plainKey, [IDEMPOTENCY_KEY]: "desk:plain:0" };

    const a = await createTask(app, project.id, plain);
    const b = await createTask(app, project.id, plain);
    // An invalid key is not even validated for a caller it does not apply to.
    const c = await createTask(app, project.id, {
      "x-api-key": plainKey,
      [IDEMPOTENCY_KEY]: "not valid!",
    });

    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(b.headers.get("Idempotent-Replay")).toBeNull();
    expect((await a.json()).id).not.toBe((await b.json()).id);
    expect(await taskCount()).toBe(3);
    expect(await tasksWithKey("desk:plain:0")).toHaveLength(0);
  });

  it("F7: the marked key without the header creates a task each time, as today", async () => {
    const { project, app, headers } = await seedDesk();
    const unkeyed: Record<string, string> = headers("unused");
    delete unkeyed[IDEMPOTENCY_KEY];

    const a = await createTask(app, project.id, unkeyed);
    const b = await createTask(app, project.id, unkeyed);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await a.json()).id).not.toBe((await b.json()).id);
    const rows = await db
      .select()
      .from(schema.taskTable)
      .where(
        and(
          eq(schema.taskTable.projectId, project.id),
          eq(schema.taskTable.title, "From the desk"),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.operonIdempotencyKey === null)).toBe(true);
  });

  it("D3: deleting the task frees its key, and the next keyed create files a new task", async () => {
    const { project, app, headers } = await seedDesk();
    const { created } = await createOnce(
      app,
      project.id,
      headers("desk:del:0"),
    );

    // Upstream's delete is a hard delete (`delete-task.ts`); the service key's
    // ceiling carries no task:delete, so a person's delete is modelled directly.
    await db
      .delete(schema.taskTable)
      .where(eq(schema.taskTable.id, created.id));

    const again = await createTask(app, project.id, headers("desk:del:0"));
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replay")).toBeNull();
    const rows = await tasksWithKey("desk:del:0");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(created.id);
  });
});
