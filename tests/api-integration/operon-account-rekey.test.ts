import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

/**
 * Operon fork checks — `PATCH /api/internal/operon/account-id` (spec R33, decision 43).
 *
 * The route moves an OIDC subject from one value to another on a `custom`-provider
 * account row, which is to say it decides who a Kaneo user IS. Its first revision let any
 * caller holding any API key do that, and a Codex review walked the consequence: mint a
 * personal key, move your own account to an unused subject, then assign your Operon
 * subject to an administrator's Kaneo account — Better Auth resolves that subject to the
 * administrator on the next sign-in.
 *
 * Every test here is one of the four things that now have to be true, or the idempotency
 * that had to survive them.
 *
 * See `docs/fork-discipline.md` in the Operon repository.
 */

const OLD_SUBJECT = "1".repeat(64);
const NEW_SUBJECT = "2".repeat(64);
const THIRD_SUBJECT = "3".repeat(64);

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

/** The credential the workspace bootstrap mints: the marker AND the scope. */
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

async function seedAccount(userId: string, accountId = OLD_SUBJECT) {
  const [account] = await db
    .insert(schema.accountTable)
    .values({
      accountId,
      providerId: "custom",
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return account;
}

function patch(
  app: ReturnType<typeof createApp>["app"],
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.request("/api/internal/operon/account-id", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function subjectOf(userId: string) {
  const [row] = await db
    .select({ accountId: schema.accountTable.accountId })
    .from(schema.accountTable)
    .where(
      and(
        eq(schema.accountTable.userId, userId),
        eq(schema.accountTable.providerId, "custom"),
      ),
    );
  return row?.accountId ?? null;
}

let holder: Awaited<ReturnType<typeof createWorkspaceMember>>;
let target: { id: string };
let serviceKey: string;

beforeEach(async () => {
  await resetTestDatabase();

  // The key's holder is the workspace owner the bootstrap minted under.
  holder = await createWorkspaceMember({ role: "owner" });
  serviceKey = await serviceKeyFor(holder.user.id);

  // ...and the person being re-keyed is somebody else in the same workspace.
  const [targetUser] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `target-${randomUUID()}@example.com`,
      emailVerified: true,
      name: "Target",
    })
    .returning();
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: holder.workspace.id,
    userId: targetUser.id,
    role: "member",
    joinedAt: new Date(),
  });
  target = targetUser;
  await seedAccount(targetUser.id);
});

describe("the credential has to be the Operon service key", () => {
  it("refuses a browser session with 403", async () => {
    mockAuthenticatedSession(holder.user);
    const { app } = createApp();

    const response = await patch(app, {
      kaneoUserId: target.id,
      previousAccountId: OLD_SUBJECT,
      accountId: NEW_SUBJECT,
    });

    expect(response.status).toBe(403);
    expect(await subjectOf(target.id)).toBe(OLD_SUBJECT);
  });

  it("refuses an ORDINARY user's API key with 403", async () => {
    // The reproduction. A member's own key authenticates every other /api route and is
    // still not the credential that may hand out identities.
    const member = await createWorkspaceMember();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: holder.workspace.id,
      userId: member.user.id,
      role: "member",
      joinedAt: new Date(),
    });
    const ordinaryKey = await mintKey(member.user.id, {
      permissions: { task: ["create", "read", "update"], workspace: ["read"] },
    });
    const { app } = createApp();

    const response = await patch(
      app,
      {
        kaneoUserId: target.id,
        previousAccountId: OLD_SUBJECT,
        accountId: NEW_SUBJECT,
      },
      { "x-api-key": ordinaryKey },
    );

    expect(response.status).toBe(403);
    expect(await subjectOf(target.id)).toBe(OLD_SUBJECT);
  });

  it("refuses a READ-ONLY key with 403", async () => {
    const readOnlyKey = await mintKey(holder.user.id, {
      permissions: { workspace: ["read"], task: ["read"] },
    });
    const { app } = createApp();

    const response = await patch(
      app,
      {
        kaneoUserId: target.id,
        previousAccountId: OLD_SUBJECT,
        accountId: NEW_SUBJECT,
      },
      { "x-api-key": readOnlyKey },
    );

    expect(response.status).toBe(403);
    expect(await subjectOf(target.id)).toBe(OLD_SUBJECT);
  });

  it("refuses a key that CLAIMS the scope but carries no service marker", async () => {
    // `permissions` is accepted from a client request by Better Auth's create endpoint,
    // so the scope on its own is a claim anybody can make. The marker is metadata, which
    // `hooks.before` refuses to any HTTP caller.
    const forgedKey = await mintKey(holder.user.id, {
      permissions: {
        workspace: ["manage_settings"],
        task: ["update"],
        operon: ["rekey"],
      },
    });
    const { app } = createApp();

    const response = await patch(
      app,
      {
        kaneoUserId: target.id,
        previousAccountId: OLD_SUBJECT,
        accountId: NEW_SUBJECT,
      },
      { "x-api-key": forgedKey },
    );

    expect(response.status).toBe(403);
    expect(await subjectOf(target.id)).toBe(OLD_SUBJECT);
  });

  it("refuses a marked key whose scope was trimmed", async () => {
    const trimmedKey = await mintKey(holder.user.id, {
      permissions: { workspace: ["manage_settings"] },
      metadata: { operonService: true },
    });
    const { app } = createApp();

    const response = await patch(
      app,
      {
        kaneoUserId: target.id,
        previousAccountId: OLD_SUBJECT,
        accountId: NEW_SUBJECT,
      },
      { "x-api-key": trimmedKey },
    );

    expect(response.status).toBe(403);
    expect(await subjectOf(target.id)).toBe(OLD_SUBJECT);
  });
});

describe("the target has to be authorized too", () => {
  it("re-keys an account in the service key's workspace", async () => {
    const { app } = createApp();

    const response = await patch(
      app,
      {
        kaneoUserId: target.id,
        previousAccountId: OLD_SUBJECT,
        accountId: NEW_SUBJECT,
      },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      updated: 1,
      kaneoUserId: target.id,
      accountId: NEW_SUBJECT,
    });
    expect(await subjectOf(target.id)).toBe(NEW_SUBJECT);
  });

  it("refuses an account in a DIFFERENT workspace with 403", async () => {
    const outsider = await createWorkspaceMember();
    await seedAccount(outsider.user.id, THIRD_SUBJECT);
    const { app } = createApp();

    const response = await patch(
      app,
      {
        kaneoUserId: outsider.user.id,
        previousAccountId: THIRD_SUBJECT,
        accountId: NEW_SUBJECT,
      },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(403);
    expect(await subjectOf(outsider.user.id)).toBe(THIRD_SUBJECT);
  });

  it("answers 404 when there is no custom-provider account to move", async () => {
    const [stranger] = await db
      .insert(schema.userTable)
      .values({
        id: `user-${randomUUID()}`,
        email: `stranger-${randomUUID()}@example.com`,
        emailVerified: true,
        name: "Stranger",
      })
      .returning();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: holder.workspace.id,
      userId: stranger.id,
      role: "member",
      joinedAt: new Date(),
    });
    const { app } = createApp();

    const response = await patch(
      app,
      {
        kaneoUserId: stranger.id,
        previousAccountId: OLD_SUBJECT,
        accountId: NEW_SUBJECT,
      },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(404);
  });
});

describe("the old subject is checked, and a collision is refused", () => {
  it("answers 409 when the row does not hold the stated previous subject", async () => {
    // Operon and Kaneo disagreeing about which identity this row is, is not a thing to
    // resolve by guessing: a wrong guess lands a rotation on the wrong person.
    const { app } = createApp();

    const response = await patch(
      app,
      {
        kaneoUserId: target.id,
        previousAccountId: THIRD_SUBJECT,
        accountId: NEW_SUBJECT,
      },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(409);
    expect(await subjectOf(target.id)).toBe(OLD_SUBJECT);
  });

  it("answers 409 when another account already holds the new subject", async () => {
    // The exact state the route exists to prevent, and the table carries no unique
    // constraint on `(provider_id, account_id)` that would catch it.
    const other = await createWorkspaceMember();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: holder.workspace.id,
      userId: other.user.id,
      role: "member",
      joinedAt: new Date(),
    });
    await seedAccount(other.user.id, NEW_SUBJECT);
    const { app } = createApp();

    const response = await patch(
      app,
      {
        kaneoUserId: target.id,
        previousAccountId: OLD_SUBJECT,
        accountId: NEW_SUBJECT,
      },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(409);
    expect(await subjectOf(target.id)).toBe(OLD_SUBJECT);
    expect(await subjectOf(other.user.id)).toBe(NEW_SUBJECT);
  });

  it("stays idempotent: a retry of a call that landed is 200 with updated: 0", async () => {
    // Reissue's "rotate first, then re-key" ordering is only recoverable if the retry
    // converges. After a successful move the OLD subject is by definition gone, so the
    // already-current check has to come BEFORE the previous-subject comparison.
    const { app } = createApp();
    const body = {
      kaneoUserId: target.id,
      previousAccountId: OLD_SUBJECT,
      accountId: NEW_SUBJECT,
    };

    expect((await patch(app, body, { "x-api-key": serviceKey })).status).toBe(
      200,
    );
    const retry = await patch(app, body, { "x-api-key": serviceKey });

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      updated: 0,
      kaneoUserId: target.id,
      accountId: NEW_SUBJECT,
    });
    expect(await subjectOf(target.id)).toBe(NEW_SUBJECT);
  });

  it("rejects a previousAccountId that is not a pubkey", async () => {
    const { app } = createApp();

    const response = await patch(
      app,
      {
        kaneoUserId: target.id,
        previousAccountId: "not-a-pubkey",
        accountId: NEW_SUBJECT,
      },
      { "x-api-key": serviceKey },
    );

    expect(response.status).toBe(400);
  });
});
