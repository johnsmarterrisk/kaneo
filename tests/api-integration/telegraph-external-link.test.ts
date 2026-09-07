import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

/**
 * Operon fork checks (spec R15, R16, R26, decisions 31 and 35, task B12).
 *
 * Seven claims, one test each. The eighth test B12 owes lives in
 * `apps/web/src/__tests__/telegraph-external-link.test.tsx`, because the rendered
 * href is a web concern.
 *
 * See `docs/fork-discipline.md` in the Operon repository for why these live in the
 * fork rather than in Operon.
 */

const EVENT_ID =
  "9f1c2d3e4a5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

const TELEGRAPH_URL = `https://operon.test/#/telegraph/msg/${EVENT_ID}`;

async function seedTelegraphProject(role = "member") {
  const member = await createWorkspaceMember({ role });
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });

  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Task created from a Telegraph message",
      status: "to-do",
      columnId: columns.todo.id,
      priority: "medium",
      number: 1,
      position: 1,
      // Explicitly stale, so "the update advanced it" cannot pass by accident on a
      // machine fast enough to write both timestamps inside the same millisecond.
      updatedAt: new Date(Date.now() - 120_000),
    })
    .returning();

  const [integration] = await db
    .insert(schema.integrationTable)
    .values({
      projectId: project.id,
      type: "telegraph",
      config: JSON.stringify({ apexUrl: "https://operon.test" }),
      isActive: true,
    })
    .returning();

  return { member, project, task, integration };
}

function attachBody(taskId: string, integrationId: string) {
  return {
    taskId,
    integrationId,
    resourceType: "message",
    externalId: EVENT_ID,
    url: TELEGRAPH_URL,
    title: "Ship the relay patch",
    metadata: { createdFrom: "telegraph", channelId: "channel-1" },
  };
}

function post(
  app: ReturnType<typeof createApp>["app"],
  body: Record<string, unknown>,
) {
  return app.request("/api/external-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("API integration: the telegraph external-link write route", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("creates a telegraph link on a task", async () => {
    const { member, task, integration } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, integration.id));

    expect(response.status).toBe(200);
    const created = await response.json();
    expect(created).toMatchObject({
      taskId: task.id,
      integrationId: integration.id,
      resourceType: "message",
      externalId: EVENT_ID,
      url: TELEGRAPH_URL,
      title: "Ship the relay patch",
      metadata: { createdFrom: "telegraph", channelId: "channel-1" },
      integration: { id: integration.id, type: "telegraph" },
    });
    // The write route mirrors the read route's projection: never `config`.
    expect(created.integration.config).toBeUndefined();

    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(1);
  });

  it("reads the created link back on GET /external-link/task/{taskId}", async () => {
    const { member, task, integration } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    expect((await post(app, attachBody(task.id, integration.id))).status).toBe(
      200,
    );

    const response = await app.request(`/api/external-link/task/${task.id}`);
    expect(response.status).toBe(200);

    const links = await response.json();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      externalId: EVENT_ID,
      resourceType: "message",
      url: TELEGRAPH_URL,
      metadata: { createdFrom: "telegraph" },
      integration: { id: integration.id, type: "telegraph" },
    });
  });

  it("refuses an unknown integrationId with 409, not a 500", async () => {
    const { member, task } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await post(
      app,
      attachBody(task.id, "integration-that-does-not-exist"),
    );

    expect(response.status).toBe(409);
    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(0);
  });

  it("refuses a caller with no access to the task's workspace with 403", async () => {
    const { task, integration } = await seedTelegraphProject();
    // A real user, fully signed in, who is simply not in this workspace.
    const outsider = await createWorkspaceMember();
    mockAuthenticatedSession(outsider.user);
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, integration.id));

    expect(response.status).toBe(403);
    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(0);
  });

  it("writes one row when the same link is attached twice", async () => {
    const { member, task, integration } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const first = await post(app, attachBody(task.id, integration.id));
    const second = await post(app, {
      ...attachBody(task.id, integration.id),
      title: "Ship the relay patch (retitled)",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(1);
    // ON CONFLICT ... DO UPDATE, so the retry converges rather than being dropped.
    expect(rows[0]?.title).toBe("Ship the relay patch (retitled)");
    expect(rows[0]?.id).toBe((await first.json()).id);
  });

  it("converges on one row when two writes of the same (taskId, externalId) race", async () => {
    const { member, task, integration } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    // Genuinely concurrent: both requests are in flight before either resolves, so
    // both reach the INSERT and the unique index — not a read-before-insert check —
    // is what makes them converge. Two separate Hono app instances, so they cannot
    // share any per-request state.
    const { app: appB } = createApp();
    const [a, b] = await Promise.all([
      post(app, attachBody(task.id, integration.id)),
      post(appB, attachBody(task.id, integration.id)),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);

    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe(EVENT_ID);
  });

  it("GET /task/tasks/{projectId} carries updatedAt, and it advances after an update", async () => {
    const { member, project, task } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const before = await app.request(`/api/task/tasks/${project.id}`);
    expect(before.status).toBe(200);
    const beforeBoard = await before.json();
    const beforeTask = beforeBoard.data.columns
      .flatMap((column: { tasks: unknown[] }) => column.tasks)
      .find((row: { id: string }) => row.id === task.id);

    // The exact response shape, not just "updatedAt is somewhere in there".
    expect(Object.keys(beforeTask).sort()).toEqual(
      [
        "assigneeId",
        "assigneeImage",
        "assigneeName",
        "createdAt",
        "description",
        "dueDate",
        "externalLinks",
        "id",
        "labels",
        "number",
        "position",
        "priority",
        "projectId",
        "startDate",
        "status",
        "title",
        "updatedAt",
        "userId",
      ].sort(),
    );
    expect(typeof beforeTask.updatedAt).toBe("string");

    await db
      .update(schema.taskTable)
      .set({ title: "Retitled by the test" })
      .where(eq(schema.taskTable.id, task.id));

    const after = await app.request(`/api/task/tasks/${project.id}`);
    const afterBoard = await after.json();
    const afterTask = afterBoard.data.columns
      .flatMap((column: { tasks: unknown[] }) => column.tasks)
      .find((row: { id: string }) => row.id === task.id);

    expect(Date.parse(afterTask.updatedAt)).toBeGreaterThan(
      Date.parse(beforeTask.updatedAt),
    );
    expect(afterTask.createdAt).toBe(beforeTask.createdAt);
  });

  it("GET /task/{id} carries updatedAt, and it advances after an update", async () => {
    const { member, task } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const before = await app.request(`/api/task/${task.id}`);
    expect(before.status).toBe(200);
    const beforeTask = await before.json();

    expect(Object.keys(beforeTask).sort()).toEqual(
      [
        "assigneeId",
        "assigneeName",
        "createdAt",
        "description",
        "dueDate",
        "id",
        "number",
        "position",
        "priority",
        "projectId",
        "startDate",
        "status",
        "title",
        "updatedAt",
        "userId",
      ].sort(),
    );
    expect(typeof beforeTask.updatedAt).toBe("string");

    await db
      .update(schema.taskTable)
      .set({ title: "Retitled by the test" })
      .where(eq(schema.taskTable.id, task.id));

    const after = await app.request(`/api/task/${task.id}`);
    const afterTask = await after.json();

    expect(Date.parse(afterTask.updatedAt)).toBeGreaterThan(
      Date.parse(beforeTask.updatedAt),
    );
    expect(afterTask.createdAt).toBe(beforeTask.createdAt);
  });
});
