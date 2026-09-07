import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auth } from "../../apps/api/src/auth";
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
 * One claim per test. The rendered-href claim lives in
 * `apps/web/src/__tests__/telegraph-external-link.test.tsx`, because that is a web
 * concern.
 *
 * The authorization block is what a Codex review turned up: `workspaceAccess` alone
 * answers "are you IN this workspace" and nothing about what you may DO there, so a
 * viewer and a read-scoped API key could both write links, and the route accepted a
 * GitHub or Gitea integration id — rows upstream's own synchronisers trust.
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
  headers: Record<string, string> = {},
) {
  return app.request("/api/external-link", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * A real API key for a real user, minted SERVER-side so `permissions` can be named
 * without a session — the same call the workspace bootstrap makes.
 */
async function mintKeyFor(
  userId: string,
  permissions: Record<string, string[]>,
) {
  const created = await auth.api.createApiKey({
    body: { userId, name: `test-${Date.now() % 100000}`, permissions },
  });
  const key = created?.key;
  if (!key) throw new Error("failed to mint a test api key");
  return key;
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

  it("converges on one row when two writes of the same link race", async () => {
    const { member, task, integration } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    // Genuinely concurrent: both requests are in flight before either resolves, so
    // both reach the INSERT and the unique index on
    // (task_id, integration_id, external_id) — not a read-before-insert check — is
    // what makes them converge. Two separate Hono app instances, so they cannot
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

  it("refuses a VIEWER with 403 — reading a task is not writing to one", async () => {
    // `workspaceAccess.fromTaskId` only asks "are you in this workspace", which a viewer
    // is. The permission this route now also demands, `task: ["update"]`, is the one
    // every upstream task-mutating route demands, and viewers do not have it.
    const { member, task, integration } = await seedTelegraphProject("viewer");
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, integration.id));

    expect(response.status).toBe(403);
    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(0);
  });

  it("refuses an API KEY whose scope omits task:update with 403", async () => {
    // An API key's `permissions` are a CEILING over its holder's role
    // (`utils/require-workspace-permission.ts`), so a key minted by a full workspace
    // member is still refused when its scope does not name this action. Operon's own
    // service key carries `task: ["update"]` deliberately.
    const { member, task, integration } = await seedTelegraphProject("admin");
    const readOnlyKey = await mintKeyFor(member.user.id, {
      task: ["read"],
      workspace: ["read"],
    });
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, integration.id), {
      "x-api-key": readOnlyKey,
    });

    expect(response.status).toBe(403);
    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(0);
  });

  it("accepts an API key that does carry task:update", async () => {
    // The negative above would also pass against a route that refused every API key.
    const { member, task, integration } = await seedTelegraphProject("admin");
    const serviceKey = await mintKeyFor(member.user.id, {
      workspace: ["manage_settings"],
      task: ["update"],
      operon: ["rekey"],
    });
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, integration.id), {
      "x-api-key": serviceKey,
    });

    expect(response.status).toBe(200);
  });

  it("refuses a NON-TELEGRAPH integration with 409", async () => {
    // A project may legitimately carry a `github` or `gitea` integration beside its
    // telegraph one, and upstream's own link managers treat the rows under those
    // integrations as their synchronisation state. This fork route must not be a way for
    // a workspace member to write them.
    const { member, project, task } = await seedTelegraphProject();
    const [gitea] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "gitea",
        config: JSON.stringify({ baseUrl: "https://gitea.example" }),
        isActive: true,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, gitea.id));

    expect(response.status).toBe(409);
    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(0);
  });

  it("refuses a resourceType other than message", async () => {
    const { member, task, integration } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await post(app, {
      ...attachBody(task.id, integration.id),
      resourceType: "issue",
    });

    expect(response.status).toBe(400);
  });

  it("keeps an upstream issue and branch with the SAME id apart on one task", async () => {
    // Migration 0045's whole correction. Upstream's link manager recognises the
    // `{number}` branch pattern, so branch "5" and issue #5 are two real links from one
    // task through ONE integration. Written directly, because these rows are upstream's
    // writers' and this fork's route is telegraph-only — the claim is about the
    // CONSTRAINT, not about the route.
    const { member, project, task } = await seedTelegraphProject();
    const [gitea] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "gitea",
        config: JSON.stringify({ baseUrl: "https://gitea.example" }),
        isActive: true,
      })
      .returning();

    await db.insert(schema.externalLinkTable).values([
      {
        taskId: task.id,
        integrationId: gitea.id,
        resourceType: "issue",
        externalId: "5",
        url: "https://gitea.example/owner/repo/issues/5",
      },
      {
        taskId: task.id,
        integrationId: gitea.id,
        resourceType: "branch",
        externalId: "5",
        url: "https://gitea.example/owner/repo/src/branch/5",
      },
    ]);

    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.resourceType))).toEqual(
      new Set(["issue", "branch"]),
    );
    expect(member.user.id).toBeTruthy();
  });

  it("still refuses a genuine duplicate of the same resource kind", async () => {
    // The other half: widening the key must not have turned it off.
    const { project, task } = await seedTelegraphProject();
    const [gitea] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "gitea",
        config: JSON.stringify({ baseUrl: "https://gitea.example" }),
        isActive: true,
      })
      .returning();

    const row = {
      taskId: task.id,
      integrationId: gitea.id,
      resourceType: "issue",
      externalId: "5",
      url: "https://gitea.example/owner/repo/issues/5",
    };
    await db.insert(schema.externalLinkTable).values(row);

    await expect(
      db.insert(schema.externalLinkTable).values(row),
    ).rejects.toThrow();
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
