import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "../../apps/api/src/auth";
import db, { getDatabase, schema } from "../../apps/api/src/database";
import { subscribeToEvent } from "../../apps/api/src/events";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

/**
 * Operon fork checks — `POST /api/internal/operon/remove-member` (Operon spec
 * `revoke-initiative-membership-spec.md` R1–R7).
 *
 * Operon's revoke calls this route so a revoked person leaves the assignee picker and
 * loses every Initiative session. It must remove exactly the Operon workspace's
 * membership and that workspace's team rows, sign the person out everywhere, keep the
 * `user`/`account` rows and history, and never remove the workspace owner or the
 * service key's holder — even when a promotion races the delete.
 *
 * See `docs/fork-discipline.md` in the Operon repository.
 */

const SUBJECT = "4".repeat(64);

async function mintKey(
  userId: string,
  {
    permissions,
    metadata,
  }: {
    permissions: Record<string, string[]>;
    metadata?: Record<string, unknown>;
  },
) {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: `k-${Date.now() % 100000}`,
      permissions,
      ...(metadata ? { metadata } : {}),
    },
  });
  const key = created?.key;
  if (!key) throw new Error("failed to mint a test api key");
  return key;
}

function serviceKeyFor(userId: string) {
  return mintKey(userId, {
    permissions: {
      workspace: ["manage_settings"],
      task: ["update"],
      operon: ["rekey"],
    },
    metadata: { operonService: true },
  });
}

function removeMember(
  app: ReturnType<typeof createApp>["app"],
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.request("/api/internal/operon/remove-member", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function newUser(role?: string) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `target-${randomUUID()}@example.com`,
      emailVerified: true,
      name: "Target",
      ...(role ? { role } : {}),
    })
    .returning();
  return user;
}

async function join(workspaceId: string, userId: string, role = "member") {
  const [row] = await db
    .insert(schema.workspaceUserTable)
    .values({ workspaceId, userId, role, joinedAt: new Date() })
    .returning();
  return row;
}

async function addTeam(workspaceId: string, userId: string) {
  const teamId = `team-${randomUUID()}`;
  await db.insert(schema.teamTable).values({
    id: teamId,
    name: "Team",
    workspaceId,
    createdAt: new Date(),
  });
  await db.insert(schema.teamMemberTable).values({
    id: `tm-${randomUUID()}`,
    teamId,
    userId,
    createdAt: new Date(),
  });
  return teamId;
}

async function addSession(userId: string) {
  const token = `tok-${randomUUID()}`;
  await db.insert(schema.sessionTable).values({
    id: `session-${randomUUID()}`,
    token,
    userId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return token;
}

/** Link a user the way Operon's `POST /user` does: a `custom`-provider account row. */
async function linkOperon(userId: string) {
  await db.insert(schema.accountTable).values({
    accountId: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    providerId: "custom",
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function membership(workspaceId: string, userId: string) {
  return db
    .select()
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    );
}

async function sessionsOf(userId: string) {
  return db
    .select()
    .from(schema.sessionTable)
    .where(eq(schema.sessionTable.userId, userId));
}

async function teamRowsOf(userId: string) {
  return db
    .select()
    .from(schema.teamMemberTable)
    .where(eq(schema.teamMemberTable.userId, userId));
}

const unassignedEvents: Record<string, unknown>[] = [];
let unassignedSubscribed = false;

function recordUnassignedEvents() {
  if (unassignedSubscribed) return;
  unassignedSubscribed = true;
  subscribeToEvent<Record<string, unknown>>("task.unassigned", async (data) => {
    unassignedEvents.push(data);
  });
}

let holder: Awaited<ReturnType<typeof createWorkspaceMember>>;
let serviceKey: string;
let target: typeof schema.userTable.$inferSelect;

beforeEach(async () => {
  await resetTestDatabase();
  recordUnassignedEvents();
  unassignedEvents.length = 0;
  holder = await createWorkspaceMember({ role: "owner" });
  serviceKey = await serviceKeyFor(holder.user.id);
  target = await newUser();
  await join(holder.workspace.id, target.id);
  await db.insert(schema.accountTable).values({
    accountId: SUBJECT,
    providerId: "custom",
    userId: target.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe("the credential has to be the Operon service key", () => {
  it("refuses a browser session with 403", async () => {
    mockAuthenticatedSession(holder.user);
    const { app } = createApp();

    const response = await removeMember(app, { kaneoUserId: target.id });

    expect(response.status).toBe(403);
    expect(await membership(holder.workspace.id, target.id)).toHaveLength(1);
  });

  it("refuses an ordinary user's API key with 403", async () => {
    const member = await newUser();
    await join(holder.workspace.id, member.id);
    const ordinaryKey = await mintKey(member.id, {
      permissions: { task: ["create", "read", "update"], workspace: ["read"] },
    });
    const { app } = createApp();

    const response = await removeMember(
      app,
      { kaneoUserId: target.id },
      { "x-api-key": ordinaryKey },
    );

    expect(response.status).toBe(403);
    expect(await membership(holder.workspace.id, target.id)).toHaveLength(1);
  });

  it("answers 400 when kaneoUserId is missing", async () => {
    const { app } = createApp();
    const response = await removeMember(app, {}, { "x-api-key": serviceKey });
    expect(response.status).toBe(400);
  });
});

describe("removal", () => {
  it("removes the membership, this workspace's team rows and every session; keeps the user, account and history", async () => {
    const operonTeam = await addTeam(holder.workspace.id, target.id);
    const other = await createWorkspaceMember();
    const otherTeam = await addTeam(other.workspace.id, target.id);
    await addSession(target.id);
    await addSession(target.id);
    const { project, columns } = await createProjectFixture({
      workspaceId: holder.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: target.id,
        title: "Assigned before revoke",
        status: "to-do",
        columnId: columns.todo.id,
        number: 1,
        position: 1,
      })
      .returning();
    const { app } = createApp();

    const response = await removeMember(
      app,
      { kaneoUserId: target.id },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kaneoUserId: target.id,
      removed: 1,
      sessionsRevoked: 2,
      tasksUnassigned: 1,
    });
    expect(await membership(holder.workspace.id, target.id)).toHaveLength(0);
    expect(await sessionsOf(target.id)).toHaveLength(0);
    const teams = await teamRowsOf(target.id);
    expect(teams.map((row) => row.teamId)).toEqual([otherTeam]);
    expect(teams.map((row) => row.teamId)).not.toContain(operonTeam);

    const [user] = await db
      .select()
      .from(schema.userTable)
      .where(eq(schema.userTable.id, target.id));
    expect(user).toBeDefined();
    const accounts = await db
      .select()
      .from(schema.accountTable)
      .where(eq(schema.accountTable.userId, target.id));
    expect(accounts).toHaveLength(1);
    const [after] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(after.title).toBe("Assigned before revoke");
    expect(after.userId).toBeNull();
  });

  it("unassigns the person's tasks in every project of this workspace only, with an activity row each", async () => {
    const first = await createProjectFixture({
      workspaceId: holder.workspace.id,
    });
    const second = await createProjectFixture({
      workspaceId: holder.workspace.id,
    });
    const other = await createWorkspaceMember();
    await join(other.workspace.id, target.id);
    const elsewhere = await createProjectFixture({
      workspaceId: other.workspace.id,
    });
    const someoneElse = await newUser();
    await join(holder.workspace.id, someoneElse.id);
    const task = async (
      fixture: Awaited<ReturnType<typeof createProjectFixture>>,
      userId: string,
      title: string,
      number = 1,
    ) =>
      (
        await db
          .insert(schema.taskTable)
          .values({
            projectId: fixture.project.id,
            userId,
            title,
            status: "to-do",
            columnId: fixture.columns.todo.id,
            number,
            position: number,
          })
          .returning()
      )[0];
    const inFirst = await task(first, target.id, "First project");
    const inSecond = await task(second, target.id, "Second project");
    const inOther = await task(elsewhere, target.id, "Other workspace");
    const notTheirs = await task(first, someoneElse.id, "Someone else's", 2);
    const { app } = createApp();

    const response = await removeMember(
      app,
      { kaneoUserId: target.id },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tasksUnassigned: 2 });
    const assigneeOf = async (id: string) =>
      (
        await db
          .select()
          .from(schema.taskTable)
          .where(eq(schema.taskTable.id, id))
      )[0];
    expect((await assigneeOf(inFirst.id)).userId).toBeNull();
    expect((await assigneeOf(inSecond.id)).userId).toBeNull();
    expect((await assigneeOf(inFirst.id)).title).toBe("First project");
    expect((await assigneeOf(inOther.id)).userId).toBe(target.id);
    expect((await assigneeOf(notTheirs.id)).userId).toBe(someoneElse.id);

    const activity = await db
      .select()
      .from(schema.activityTable)
      .where(eq(schema.activityTable.type, "unassigned"));
    expect(activity.map((row) => row.taskId).sort()).toEqual(
      [inFirst.id, inSecond.id].sort(),
    );
    expect(activity.every((row) => row.userId === holder.user.id)).toBe(true);

    // Published after the commit, once per task, in the normal unassign path's shape.
    expect(
      [...unassignedEvents].sort((a, b) =>
        String(a.taskId).localeCompare(String(b.taskId)),
      ),
    ).toEqual(
      [inFirst, inSecond]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((t) =>
          expect.objectContaining({
            taskId: t.id,
            projectId: t.projectId,
            userId: holder.user.id,
            title: t.title,
            type: "unassigned",
            activityRecorded: true,
          }),
        ),
    );
    // The activity subscriber runs async off the bus: let it settle, then prove it wrote
    // no second row for an event the route already recorded.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      await db
        .select()
        .from(schema.activityTable)
        .where(eq(schema.activityTable.type, "unassigned")),
    ).toHaveLength(2);

    const again = await removeMember(
      app,
      { kaneoUserId: target.id },
      { "x-api-key": serviceKey },
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ tasksUnassigned: 0 });
    expect(unassignedEvents).toHaveLength(2);
    expect(
      await db
        .select()
        .from(schema.activityTable)
        .where(eq(schema.activityTable.type, "unassigned")),
    ).toHaveLength(2);
  });

  it("is idempotent: a second call answers removed 0", async () => {
    const { app } = createApp();
    const first = await removeMember(
      app,
      { kaneoUserId: target.id },
      { "x-api-key": serviceKey },
    );
    expect(first.status).toBe(200);

    const second = await removeMember(
      app,
      { kaneoUserId: target.id },
      { "x-api-key": serviceKey },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      removed: 0,
      tasksUnassigned: 0,
    });
  });

  it("answers removed 0 for an unknown id", async () => {
    const { app } = createApp();
    const response = await removeMember(
      app,
      { kaneoUserId: `user-${randomUUID()}` },
      { "x-api-key": serviceKey },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      removed: 0,
      sessionsRevoked: 0,
      tasksUnassigned: 0,
    });
  });

  it("touches nothing for an Initiative user Operon never managed", async () => {
    // A real member of the Operon workspace AND of another one, with live sessions and
    // team rows, but no `custom`-provider account: not Operon's to remove.
    const stranger = await newUser();
    await join(holder.workspace.id, stranger.id);
    const other = await createWorkspaceMember();
    await join(other.workspace.id, stranger.id);
    const operonTeam = await addTeam(holder.workspace.id, stranger.id);
    await addSession(stranger.id);
    await addSession(stranger.id);
    const { app } = createApp();

    const response = await removeMember(
      app,
      { kaneoUserId: stranger.id },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kaneoUserId: stranger.id,
      removed: 0,
      sessionsRevoked: 0,
      tasksUnassigned: 0,
    });
    expect(await membership(holder.workspace.id, stranger.id)).toHaveLength(1);
    expect(await membership(other.workspace.id, stranger.id)).toHaveLength(1);
    expect(await sessionsOf(stranger.id)).toHaveLength(2);
    expect((await teamRowsOf(stranger.id)).map((row) => row.teamId)).toEqual([
      operonTeam,
    ]);
  });

  it("still deletes sessions when the membership is already absent", async () => {
    await db
      .delete(schema.workspaceUserTable)
      .where(eq(schema.workspaceUserTable.userId, target.id));
    await addSession(target.id);
    const { app } = createApp();

    const response = await removeMember(
      app,
      { kaneoUserId: target.id },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      removed: 0,
      sessionsRevoked: 1,
    });
    expect(await sessionsOf(target.id)).toHaveLength(0);
  });

  it("signs out a revoked instance admin everywhere, so the admin bypass cannot reach the Operon workspace", async () => {
    const admin = await newUser("admin");
    await linkOperon(admin.id);
    await join(holder.workspace.id, admin.id);
    const second = await createWorkspaceMember();
    await join(second.workspace.id, admin.id);
    const token = await addSession(admin.id);
    const { app } = createApp();

    const probe = (workspaceId: string) =>
      app.request(
        `/api/project?workspaceId=${encodeURIComponent(workspaceId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    expect((await probe(holder.workspace.id)).status).toBe(200);

    const response = await removeMember(
      app,
      { kaneoUserId: admin.id },
      { "x-api-key": serviceKey },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      removed: 1,
      sessionsRevoked: 1,
    });

    expect((await probe(holder.workspace.id)).status).toBe(401);
    expect((await probe(second.workspace.id)).status).toBe(401);
    expect(await membership(second.workspace.id, admin.id)).toHaveLength(1);
  });
});

describe("protected identities", () => {
  it("refuses the workspace owner with 409", async () => {
    const owner = await newUser();
    await linkOperon(owner.id);
    await join(holder.workspace.id, owner.id, "admin, owner");
    await addSession(owner.id);
    const { app } = createApp();

    const response = await removeMember(
      app,
      { kaneoUserId: owner.id },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(409);
    expect(await membership(holder.workspace.id, owner.id)).toHaveLength(1);
    expect(await sessionsOf(owner.id)).toHaveLength(1);
  });

  it("refuses the service key's holder with 409", async () => {
    const { app } = createApp();
    const response = await removeMember(
      app,
      { kaneoUserId: holder.user.id },
      { "x-api-key": serviceKey },
    );
    expect(response.status).toBe(409);
    expect(await membership(holder.workspace.id, holder.user.id)).toHaveLength(
      1,
    );
  });

  it("a promotion to owner between the read and the delete cannot remove the row", async () => {
    const [row] = await membership(holder.workspace.id, target.id);
    // The row is really the owner now; the route's first read sees the stale `member`.
    await db
      .update(schema.workspaceUserTable)
      .set({ role: "owner" })
      .where(eq(schema.workspaceUserTable.id, row.id));

    // `db` is a lazy Proxy; the spy goes on the drizzle instance behind it.
    const instance = getDatabase();
    const realTransaction = instance.transaction.bind(instance);
    vi.spyOn(instance, "transaction").mockImplementation(((
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      realTransaction(async (tx) => {
        let stale = true;
        const proxy = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === "select" && stale) {
              stale = false;
              return () => ({
                from: () => ({
                  where: () => ({
                    limit: async () => [{ id: row.id, role: "member" }],
                  }),
                }),
              });
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return fn(proxy);
      })) as never);
    const { app } = createApp();

    const response = await removeMember(
      app,
      { kaneoUserId: target.id },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(409);
    expect(await membership(holder.workspace.id, target.id)).toHaveLength(1);
  });
});
