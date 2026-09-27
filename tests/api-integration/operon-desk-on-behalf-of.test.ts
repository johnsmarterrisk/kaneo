import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auth, OPERON_SERVICE_KEY_PERMISSIONS } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

/**
 * Operon fork checks (Smart Desk spec D25, task F0).
 *
 * The Smart Desk card bridge creates Initiative tasks and `desk-thread` links with
 * Operon's service key, always on behalf of a named Kaneo user. A MARKED service key
 * must therefore name that user on the three write routes (task create, task import,
 * external-link create) or be refused with 400; the rebound user is the actor
 * `activityTable` records. Any other credential — an unmarked key, a browser session —
 * behaves exactly as upstream: the header is ignored, never trusted.
 *
 * See `docs/fork-discipline.md` in the Operon repository.
 */

const HEADER = "X-Operon-On-Behalf-Of";

async function seedDeskProject() {
  const owner = await createWorkspaceMember({ role: "owner" });
  const { project, columns } = await createProjectFixture({
    workspaceId: owner.workspace.id,
  });

  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Existing task for a link",
      status: "to-do",
      columnId: columns.todo.id,
      priority: "medium",
      // Clear of the project's number counter, which the create routes claim from 1.
      number: 9001,
      position: 1,
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

  const teammate = await createWorkspaceMember({ role: "member" });
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: owner.workspace.id,
    userId: teammate.user.id,
    role: "member",
    joinedAt: new Date(),
  });

  return { owner, teammate: teammate.user, project, task, integration };
}

async function mintKey(
  userId: string,
  permissions: Record<string, string[]>,
  marked: boolean,
) {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: `desk-${marked ? "service" : "plain"}-${Date.now() % 100000}`,
      permissions,
      ...(marked ? { metadata: { operonService: true } } : {}),
    },
  });
  if (!created?.key) throw new Error("failed to mint a test api key");
  return created.key;
}

type App = ReturnType<typeof createApp>["app"];

function postJson(
  app: App,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function createTask(
  app: App,
  projectId: string,
  headers?: Record<string, string>,
) {
  return postJson(
    app,
    `/api/task/${projectId}`,
    {
      title: "From the desk",
      description: "",
      priority: "low",
      status: "to-do",
    },
    headers,
  );
}

function importTasks(
  app: App,
  projectId: string,
  headers?: Record<string, string>,
  title = "Imported from the desk",
) {
  return postJson(
    app,
    `/api/task/import/${projectId}`,
    {
      tasks: [{ title, status: "to-do", priority: "low" }],
    },
    headers,
  );
}

function createLink(
  app: App,
  taskId: string,
  integrationId: string,
  headers?: Record<string, string>,
  resourceType = "message",
  externalId = `thread-${Date.now()}`,
) {
  return postJson(
    app,
    "/api/external-link",
    {
      taskId,
      integrationId,
      resourceType,
      externalId,
      url: "https://operon.test/#/desk/thread-1",
      title: "Customer thread",
    },
    headers,
  );
}

/** The activity row the `task.created` subscriber writes, polled: the bus is fire-and-forget. */
async function createdActivityActor(taskId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const [row] = await db
      .select({ userId: schema.activityTable.userId })
      .from(schema.activityTable)
      .where(eq(schema.activityTable.taskId, taskId));
    if (row) return row.userId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

/** The actor of the `external_link_created` row the link write records. */
async function linkActivityActors(taskId: string) {
  const rows = await db
    .select({ userId: schema.activityTable.userId })
    .from(schema.activityTable)
    .where(
      and(
        eq(schema.activityTable.taskId, taskId),
        eq(schema.activityTable.type, "external_link_created"),
      ),
    );
  return rows.map((row) => row.userId);
}

async function taskIdByTitle(projectId: string, title: string) {
  const [row] = await db
    .select({ id: schema.taskTable.id })
    .from(schema.taskTable)
    .where(
      and(
        eq(schema.taskTable.projectId, projectId),
        eq(schema.taskTable.title, title),
      ),
    );
  return row?.id;
}

describe("API integration: Operon on-behalf-of on the Smart Desk write routes", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("the shipped service-key ceiling carries task:create", () => {
    expect(OPERON_SERVICE_KEY_PERMISSIONS.task).toEqual(["create", "update"]);
  });

  it("refuses a marked service key WITHOUT the widened permission with 403 on all three routes, never rebinding", async () => {
    const { owner, teammate, project, task, integration } =
      await seedDeskProject();
    const key = await mintKey(owner.user.id, { task: ["update"] }, true);
    const { app } = createApp();
    const headers = { "x-api-key": key, [HEADER]: teammate.id };

    expect((await createTask(app, project.id, headers)).status).toBe(403);
    expect((await importTasks(app, project.id, headers)).status).toBe(403);
    // Before D25 this key was rebound on the link write; now it is refused, and
    // it does not fall back to the owner's authority either.
    expect(
      (await createLink(app, task.id, integration.id, headers)).status,
    ).toBe(403);
    expect(await taskIdByTitle(project.id, "From the desk")).toBeUndefined();
    const links = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(links).toHaveLength(0);
    expect(await linkActivityActors(task.id)).toEqual([]);
  });

  it("refuses a named user who is not a member — an instance admin, or an unknown id — with 403", async () => {
    const { owner, project, task, integration } = await seedDeskProject();
    const admin = await createWorkspaceMember();
    await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, admin.user.id));
    const key = await mintKey(
      owner.user.id,
      OPERON_SERVICE_KEY_PERMISSIONS,
      true,
    );
    const { app } = createApp();

    for (const named of [admin.user.id, "user-that-does-not-exist"]) {
      const headers = { "x-api-key": key, [HEADER]: named };
      expect((await createTask(app, project.id, headers)).status).toBe(403);
      expect((await importTasks(app, project.id, headers)).status).toBe(403);
      expect(
        (await createLink(app, task.id, integration.id, headers)).status,
      ).toBe(403);
    }
    expect(await taskIdByTitle(project.id, "From the desk")).toBeUndefined();
    expect(await linkActivityActors(task.id)).toEqual([]);
  });

  it("refuses the marked service key on the GitHub and Gitea issue-import routes", async () => {
    const { owner, teammate, project } = await seedDeskProject();
    const key = await mintKey(
      owner.user.id,
      OPERON_SERVICE_KEY_PERMISSIONS,
      true,
    );
    const { app } = createApp();
    const headers = { "x-api-key": key, [HEADER]: teammate.id };

    for (const path of [
      "/api/github-integration/import-issues",
      "/api/gitea-integration/import-issues",
    ]) {
      const response = await postJson(
        app,
        path,
        { projectId: project.id },
        headers,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        message: "The Operon service key may not call this route",
      });
    }
  });

  it("refuses a marked service key with NO header with 400 on all three routes, and writes nothing", async () => {
    const { owner, project, task, integration } = await seedDeskProject();
    const key = await mintKey(
      owner.user.id,
      OPERON_SERVICE_KEY_PERMISSIONS,
      true,
    );
    const { app } = createApp();
    const headers = { "x-api-key": key };

    for (const response of [
      await createTask(app, project.id, headers),
      await importTasks(app, project.id, headers),
      await createLink(app, task.id, integration.id, headers),
    ]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "X-Operon-On-Behalf-Of is required",
      });
    }
    expect(await taskIdByTitle(project.id, "From the desk")).toBeUndefined();
    expect(
      await taskIdByTitle(project.id, "Imported from the desk"),
    ).toBeUndefined();
    const links = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(links).toHaveLength(0);
  });

  it("records the NAMED user, not the key's owner, as the actor on create and import", async () => {
    const { owner, teammate, project, task, integration } =
      await seedDeskProject();
    const key = await mintKey(
      owner.user.id,
      OPERON_SERVICE_KEY_PERMISSIONS,
      true,
    );
    const { app } = createApp();
    const headers = { "x-api-key": key, [HEADER]: teammate.id };

    const created = await createTask(app, project.id, headers);
    expect(created.status).toBe(200);
    const createdId = (await created.json()).id;
    expect(await createdActivityActor(createdId)).toBe(teammate.id);

    expect((await importTasks(app, project.id, headers)).status).toBe(200);
    const importedId = await taskIdByTitle(
      project.id,
      "Imported from the desk",
    );
    expect(importedId).toBeDefined();
    expect(await createdActivityActor(importedId as string)).toBe(teammate.id);

    expect(
      (await createLink(app, task.id, integration.id, headers)).status,
    ).toBe(200);
    expect(await linkActivityActors(task.id)).toEqual([teammate.id]);
  });

  it("records one named actor on a fresh link, never another on retry or a racing write", async () => {
    const { owner, teammate, task, integration } = await seedDeskProject();
    const key = await mintKey(
      owner.user.id,
      OPERON_SERVICE_KEY_PERMISSIONS,
      true,
    );
    const { app } = createApp();
    const headers = { "x-api-key": key, [HEADER]: teammate.id };
    const externalId = "stable-desk-thread";

    const first = await createLink(
      app,
      task.id,
      integration.id,
      headers,
      "desk-thread",
      externalId,
    );
    expect(first.status).toBe(200);
    const firstLink = await first.json();
    expect(await linkActivityActors(task.id)).toEqual([teammate.id]);

    const retry = await createLink(
      app,
      task.id,
      integration.id,
      headers,
      "desk-thread",
      externalId,
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).id).toBe(firstLink.id);
    expect(await linkActivityActors(task.id)).toEqual([teammate.id]);

    const ownerRetry = await createLink(
      app,
      task.id,
      integration.id,
      { "x-api-key": key, [HEADER]: owner.user.id },
      "desk-thread",
      externalId,
    );
    expect(ownerRetry.status).toBe(200);
    expect(await linkActivityActors(task.id)).toEqual([teammate.id]);

    const { app: otherApp } = createApp();
    const racingId = "racing-desk-thread";
    const [a, b] = await Promise.all([
      createLink(
        app,
        task.id,
        integration.id,
        headers,
        "desk-thread",
        racingId,
      ),
      createLink(
        otherApp,
        task.id,
        integration.id,
        headers,
        "desk-thread",
        racingId,
      ),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await linkActivityActors(task.id)).toEqual([
      teammate.id,
      teammate.id,
    ]);
    const links = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(links).toHaveLength(2);
  });

  it("rolls back a new link when its actor activity cannot be stored", async () => {
    const { owner, teammate, task, integration } = await seedDeskProject();
    const key = await mintKey(
      owner.user.id,
      OPERON_SERVICE_KEY_PERMISSIONS,
      true,
    );
    const { app } = createApp();
    const headers = { "x-api-key": key, [HEADER]: teammate.id };
    const externalId = "activity-rollback-test";

    await db.execute(
      sql.raw(`
      CREATE FUNCTION reject_external_link_activity() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'activity insert unavailable';
      END;
      $$
    `),
    );
    try {
      await db.execute(
        sql.raw(`
        CREATE TRIGGER reject_external_link_activity_insert
        BEFORE INSERT ON activity
        FOR EACH ROW WHEN (NEW.type = 'external_link_created')
        EXECUTE FUNCTION reject_external_link_activity()
      `),
      );
      const failed = await createLink(
        app,
        task.id,
        integration.id,
        headers,
        "desk-thread",
        externalId,
      );
      expect(failed.status).toBe(500);
      expect(
        await db
          .select()
          .from(schema.externalLinkTable)
          .where(eq(schema.externalLinkTable.taskId, task.id)),
      ).toHaveLength(0);
    } finally {
      await db.execute(
        sql.raw(
          "DROP TRIGGER IF EXISTS reject_external_link_activity_insert ON activity",
        ),
      );
      await db.execute(
        sql.raw("DROP FUNCTION reject_external_link_activity()"),
      );
    }

    const retry = await createLink(
      app,
      task.id,
      integration.id,
      headers,
      "desk-thread",
      externalId,
    );
    expect(retry.status).toBe(200);
    expect(await linkActivityActors(task.id)).toEqual([teammate.id]);
  });

  it("IGNORES a forged header on an unmarked key: the key's own user is the actor", async () => {
    const { owner, project, task, integration } = await seedDeskProject();
    const outsider = await createWorkspaceMember();
    const key = await mintKey(
      owner.user.id,
      OPERON_SERVICE_KEY_PERMISSIONS,
      false,
    );
    const { app } = createApp();
    // A trusted header naming a non-member would 403; ignored, the write proceeds.
    const headers = { "x-api-key": key, [HEADER]: outsider.user.id };

    const created = await createTask(app, project.id, headers);
    expect(created.status).toBe(200);
    expect(await createdActivityActor((await created.json()).id)).toBe(
      owner.user.id,
    );

    expect((await importTasks(app, project.id, headers)).status).toBe(200);
    const importedId = await taskIdByTitle(
      project.id,
      "Imported from the desk",
    );
    expect(await createdActivityActor(importedId as string)).toBe(
      owner.user.id,
    );

    expect(
      (await createLink(app, task.id, integration.id, headers)).status,
    ).toBe(200);
    expect(await linkActivityActors(task.id)).toEqual([owner.user.id]);

    for (const path of [
      "/api/github-integration/import-issues",
      "/api/gitea-integration/import-issues",
    ]) {
      const response = await postJson(
        app,
        path,
        { projectId: project.id },
        headers,
      );
      expect(response.status).toBe(404);
    }
  });

  it("leaves a human session unaffected on all three routes, with or without the header", async () => {
    const { owner, teammate, project, task, integration } =
      await seedDeskProject();
    mockAuthenticatedSession(owner.user);
    const { app } = createApp();

    const created = await createTask(app, project.id);
    expect(created.status).toBe(200);
    expect(await createdActivityActor((await created.json()).id)).toBe(
      owner.user.id,
    );

    // A header on a session is ignored, never trusted.
    const forged = await createTask(app, project.id, { [HEADER]: teammate.id });
    expect(forged.status).toBe(200);
    expect(await createdActivityActor((await forged.json()).id)).toBe(
      owner.user.id,
    );

    expect((await importTasks(app, project.id)).status).toBe(200);
    const forgedImport = await importTasks(
      app,
      project.id,
      {
        [HEADER]: teammate.id,
      },
      "Forged-header import",
    );
    expect(forgedImport.status).toBe(200);
    expect(
      await createdActivityActor(
        (await taskIdByTitle(project.id, "Forged-header import")) as string,
      ),
    ).toBe(owner.user.id);
    // Two FRESH links (distinct external ids), the second with a forged header, then
    // a retry of the second: one activity row per fresh insert, none on the retry,
    // and every actor is the session user — never the user the header names.
    expect(
      (
        await createLink(
          app,
          task.id,
          integration.id,
          undefined,
          "message",
          "session-link-plain",
        )
      ).status,
    ).toBe(200);
    for (let write = 0; write < 2; write++) {
      expect(
        (
          await createLink(
            app,
            task.id,
            integration.id,
            { [HEADER]: teammate.id },
            "message",
            "session-link-forged",
          )
        ).status,
      ).toBe(200);
    }
    const links = await db
      .select()
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(links).toHaveLength(2);
    const actors = await linkActivityActors(task.id);
    expect(actors).toHaveLength(links.length);
    expect(actors).toEqual([owner.user.id, owner.user.id]);
    expect(actors).not.toContain(teammate.id);

    for (const path of [
      "/api/github-integration/import-issues",
      "/api/gitea-integration/import-issues",
    ]) {
      const response = await postJson(
        app,
        path,
        { projectId: project.id },
        { [HEADER]: teammate.id },
      );
      expect(response.status).toBe(404);
    }
  });

  it("accepts the `desk-thread` resource type and still refuses an unknown one", async () => {
    const { owner, teammate, task, integration } = await seedDeskProject();
    const key = await mintKey(
      owner.user.id,
      OPERON_SERVICE_KEY_PERMISSIONS,
      true,
    );
    const { app } = createApp();
    const headers = { "x-api-key": key, [HEADER]: teammate.id };

    const accepted = await createLink(
      app,
      task.id,
      integration.id,
      headers,
      "desk-thread",
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).resourceType).toBe("desk-thread");

    const refused = await createLink(
      app,
      task.id,
      integration.id,
      headers,
      "issue",
    );
    expect(refused.status).toBe(400);
  });
});
