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

/**
 * The unforgeable marker can be written only by a SERVER-side mint
 * (`hooks.before` refuses client-supplied metadata), which is exactly how the
 * workspace bootstrap marks Operon's service key.
 */
async function mintMarkedServiceKeyFor(
  userId: string,
  permissions: Record<string, string[]>,
) {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: `operon-service-${Date.now() % 100000}`,
      permissions,
      metadata: { operonService: true },
    },
  });
  const key = created?.key;
  if (!key) throw new Error("failed to mint a marked service key");
  return key;
}

/** Put a real user in an EXISTING workspace with the named role. */
async function addMemberToWorkspace(workspaceId: string, role: string) {
  const member = await createWorkspaceMember({ role });
  await db.insert(schema.workspaceUserTable).values({
    workspaceId,
    userId: member.user.id,
    role,
    joinedAt: new Date(),
  });
  return member.user;
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

  it("accepts a file resourceType and still refuses an upstream resource kind", async () => {
    const { member, task, integration } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const fileResponse = await post(app, {
      ...attachBody(task.id, integration.id),
      resourceType: "file",
      externalId: "11111111-1111-4111-8111-111111111111",
      url: "https://operon.test/#/files/11111111-1111-4111-8111-111111111111",
    });
    expect(fileResponse.status).toBe(200);
    expect((await fileResponse.json()).resourceType).toBe("file");

    const issueResponse = await post(app, {
      ...attachBody(task.id, integration.id),
      resourceType: "issue",
    });
    expect(issueResponse.status).toBe(400);
  });

  it("keeps a message and a file link with the SAME externalId apart on one task", async () => {
    // `resource_type` is in migration 0045's unique key, so one task through one
    // telegraph integration can carry both kinds for the same id.
    const { member, task, integration } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const fileId = "22222222-2222-4222-8222-222222222222";
    const message = await post(app, attachBody(task.id, integration.id));
    const file = await post(app, {
      ...attachBody(task.id, integration.id),
      resourceType: "file",
      externalId: fileId,
      url: `https://operon.test/#/files/${fileId}`,
    });
    expect([message.status, file.status]).toEqual([200, 200]);

    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.resourceType))).toEqual(
      new Set(["message", "file"]),
    );
  });

  it("converges on one row when the same file link is attached twice", async () => {
    const { member, task, integration } = await seedTelegraphProject();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const fileId = "33333333-3333-4333-8333-333333333333";
    const body = {
      ...attachBody(task.id, integration.id),
      resourceType: "file",
      externalId: fileId,
      url: `https://operon.test/#/files/${fileId}`,
    };

    expect((await post(app, body)).status).toBe(200);
    expect((await post(app, { ...body, title: "retitled" })).status).toBe(200);

    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resourceType).toBe("file");
    expect(rows[0]?.title).toBe("retitled");
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

  // ── S11: the on-behalf-of gate ────────────────────────────────────────────────
  //
  // The service key is minted against the owner, so without this gate every
  // server-side write would happen AS THE OWNER. The header is honoured only for
  // a key whose ROW carries the unforgeable marker, which is why re-reading the
  // row is the assertion that catches a gate reading `c.get("apiKey").metadata`.

  it("refuses the service key acting for a VIEWER with 403, and writes nothing", async () => {
    const { member, task, integration } = await seedTelegraphProject("admin");
    const viewer = await addMemberToWorkspace(member.workspace.id, "viewer");
    const serviceKey = await mintMarkedServiceKeyFor(member.user.id, {
      task: ["update"],
    });
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, integration.id), {
      "x-api-key": serviceKey,
      "X-Operon-On-Behalf-Of": viewer.id,
    });

    expect(response.status).toBe(403);
    const rows = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(rows).toHaveLength(0);
  });

  it("honours the header for a MEMBER, proving the marker is actually found", async () => {
    // If the gate read `c.get("apiKey").metadata` it would be undefined and the
    // viewer test above would 200 (the owner's authority). This direction is the
    // positive control that the marker is read from the row.
    const { member, task, integration } = await seedTelegraphProject("admin");
    const teammate = await addMemberToWorkspace(member.workspace.id, "member");
    const serviceKey = await mintMarkedServiceKeyFor(member.user.id, {
      task: ["update"],
    });
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, integration.id), {
      "x-api-key": serviceKey,
      "X-Operon-On-Behalf-Of": teammate.id,
    });

    expect(response.status).toBe(200);
  });

  it("refuses a NON-MEMBER id with 403", async () => {
    const { member, task, integration } = await seedTelegraphProject("admin");
    const outsider = await createWorkspaceMember();
    const serviceKey = await mintMarkedServiceKeyFor(member.user.id, {
      task: ["update"],
    });
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, integration.id), {
      "x-api-key": serviceKey,
      "X-Operon-On-Behalf-Of": outsider.user.id,
    });

    expect(response.status).toBe(403);
  });

  it("IGNORES the header on a credential whose row carries no marker", async () => {
    // The control for "ignored": the header names a non-member, so a gate that
    // trusted the header anyway would 403. The write proceeds as the key's own
    // user, which is what an unmarked credential must always get.
    const { member, task, integration } = await seedTelegraphProject("admin");
    const outsider = await createWorkspaceMember();
    const ordinaryKey = await mintKeyFor(member.user.id, {
      task: ["update"],
    });
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, integration.id), {
      "x-api-key": ordinaryKey,
      "X-Operon-On-Behalf-Of": outsider.user.id,
    });

    expect(response.status).toBe(200);
  });

  it("IGNORES the header on a key whose metadata lacks the marker", async () => {
    // Finding 3's second control: metadata present but NOT the marker must not
    // accidentally honour the header. A non-member id keeps the two apart.
    const { member, task, integration } = await seedTelegraphProject("admin");
    const outsider = await createWorkspaceMember();
    const created = await auth.api.createApiKey({
      body: {
        userId: member.user.id,
        name: `metadata-without-marker-${Date.now() % 100000}`,
        permissions: { task: ["update"] },
        metadata: { somethingElse: true },
      },
    });
    const key = created?.key;
    if (!key) throw new Error("failed to mint the metadata control key");
    const { app } = createApp();

    const response = await post(app, attachBody(task.id, integration.id), {
      "x-api-key": key,
      "X-Operon-On-Behalf-Of": outsider.user.id,
    });

    expect(response.status).toBe(200);
  });
});
