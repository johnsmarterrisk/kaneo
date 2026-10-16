import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

/**
 * Operon fork checks — `PATCH /api/internal/operon/name` (Operon open-items 371).
 *
 * An agent never signs in to Initiative, so its name there is only ever what Operon tells
 * it. The route renames the Initiative user linked to an Operon `sub`, for the Operon
 * service key only; it refuses any other caller, 404s an unknown sub and leaves a user
 * outside the key's workspace alone.
 */

const SUBJECT = "4".repeat(64);

async function serviceKeyFor(userId: string) {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: `k-${Date.now() % 100000}`,
      permissions: {
        workspace: ["manage_settings"],
        task: ["update"],
        operon: ["rekey"],
      },
      metadata: { operonService: true },
    },
  });
  if (!created?.key) throw new Error("failed to mint a test api key");
  return created.key;
}

function patch(
  app: ReturnType<typeof createApp>["app"],
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.request("/api/internal/operon/name", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function nameOf(userId: string) {
  const [row] = await db
    .select({ name: schema.userTable.name })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId));
  return row?.name ?? null;
}

async function seedLinkedUser(workspaceId: string | null, accountId = SUBJECT) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `agent-${randomUUID()}@example.com`,
      emailVerified: true,
      name: "Old Bot",
    })
    .returning();
  if (workspaceId) {
    await db.insert(schema.workspaceUserTable).values({
      workspaceId,
      userId: user.id,
      role: "member",
      joinedAt: new Date(),
    });
  }
  await db.insert(schema.accountTable).values({
    accountId,
    providerId: "custom",
    userId: user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return user;
}

let holder: Awaited<ReturnType<typeof createWorkspaceMember>>;
let serviceKey: string;

beforeEach(async () => {
  await resetTestDatabase();
  holder = await createWorkspaceMember({ role: "owner" });
  serviceKey = await serviceKeyFor(holder.user.id);
});

describe("PATCH /api/internal/operon/name", () => {
  it("renames the user linked to the sub, trimmed, and says which user", async () => {
    const agent = await seedLinkedUser(holder.workspace.id);
    const { app } = createApp();
    const response = await patch(
      app,
      { sub: SUBJECT, name: "  Review Bot  " },
      { "x-api-key": serviceKey },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      updated: 1,
      kaneoUserId: agent.id,
    });
    expect(await nameOf(agent.id)).toBe("Review Bot");
  });

  it("refuses a browser session and an ordinary key with 403, and renames nothing", async () => {
    const agent = await seedLinkedUser(holder.workspace.id);
    mockAuthenticatedSession(holder.user);
    const { app } = createApp();
    expect((await patch(app, { sub: SUBJECT, name: "Hijack" })).status).toBe(
      403,
    );
    const ordinary = await auth.api.createApiKey({
      body: {
        userId: holder.user.id,
        name: "plain",
        permissions: { task: ["read"] },
      },
    });
    expect(
      (
        await patch(
          app,
          { sub: SUBJECT, name: "Hijack" },
          { "x-api-key": ordinary?.key ?? "" },
        )
      ).status,
    ).toBe(403);
    expect(await nameOf(agent.id)).toBe("Old Bot");
  });

  it("answers 404 for a sub no Initiative user is linked to", async () => {
    const { app } = createApp();
    const response = await patch(
      app,
      { sub: "5".repeat(64), name: "Nobody" },
      { "x-api-key": serviceKey },
    );
    expect(response.status).toBe(404);
  });

  it("refuses a user outside the service key's workspace with 403", async () => {
    const stranger = await seedLinkedUser(null);
    const { app } = createApp();
    const response = await patch(
      app,
      { sub: SUBJECT, name: "Moved" },
      { "x-api-key": serviceKey },
    );
    expect(response.status).toBe(403);
    expect(await nameOf(stranger.id)).toBe("Old Bot");
  });

  it("refuses a malformed sub or an empty name with 400", async () => {
    await seedLinkedUser(holder.workspace.id);
    const { app } = createApp();
    expect(
      (await patch(app, { sub: "XYZ", name: "A" }, { "x-api-key": serviceKey }))
        .status,
    ).toBe(400);
    expect(
      (
        await patch(
          app,
          { sub: SUBJECT, name: "   " },
          { "x-api-key": serviceKey },
        )
      ).status,
    ).toBe(400);
  });
});
