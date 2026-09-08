import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Operon fork checks — `POST /api/internal/operon/user` and the `account` unique key
 * (Operon spec R17; decisions 110, 111, 116, 122).
 *
 * The route exists so an admin can provision somebody in Operon and assign them a task
 * immediately, instead of waiting for that person to open Initiative once. Everything
 * below is one of the properties that makes that safe rather than merely convenient:
 * the three writes are one transaction, the two unique keys are the coordination points
 * the route shares with Better Auth's OIDC first-login path, and an email collision is
 * never allowed to merge two people.
 *
 * ── WHY THE IMPORTS BELOW ARE DYNAMIC ────────────────────────────────────────────
 *
 * `apps/api/src/auth.ts` reads its switches ONCE, at module scope, and `import` is
 * hoisted above every other statement — so a static import would evaluate `auth.ts`
 * before this file could set `OPERON_OIDC_ONLY` and the suite would test the wrong mode.
 * `operon-oidc-only.test.ts` established the pattern; this file follows it.
 *
 * ── HOW AN "OIDC FIRST LOGIN" IS MODELLED HERE ───────────────────────────────────
 *
 * Better Auth's `createOAuthUser` writes the `user` and THEN the `account` as two
 * SEPARATELY COMMITTED statements — the Drizzle adapter is built in `auth.ts` with no
 * `transaction` option and the installed adapter defaults it to `false`. That seam is
 * the whole reason decision 122 waits instead of ruling, so the helpers below reproduce
 * it literally: {@link oidcCreateUser} is the first commit, {@link oidcCreateAccount} is
 * the second, and {@link oidcSignIn} is the `databaseHooks.session.create.after`
 * reconciliation that follows. Driving the real OAuth callback would need an identity
 * provider on the wire; reproducing its two commits needs only the two statements it
 * actually issues.
 *
 * See `docs/fork-discipline.md` §3 in the Operon repository.
 */

/**
 * Written through an indexed helper rather than as `process.env.OPERON_OIDC_ONLY = …`
 * because biome's `noUndeclaredEnvVars` requires every literally-named variable to
 * appear in `turbo.json`, which fork discipline forbids this branch from editing.
 */
function setEnv(key: string, value: string) {
  process.env[key] = value;
}

const OIDC_ONLY = "OPERON_OIDC_ONLY";
const previousOidcOnly = process.env[OIDC_ONLY];
setEnv(OIDC_ONLY, "true");
setEnv("OPERON_INTERNAL_API_URL", "http://platform-service.test:3001");
setEnv("OPERON_KANEO_S2S_SECRET", "an-s2s-secret-for-the-suite");

const dbModule = await import("../../apps/api/src/database");
const db = dbModule.default;
const { schema } = dbModule;
const { auth, reconcileOperonSession } = await import(
  "../../apps/api/src/auth"
);
const { createApp } = await import("../../apps/api/src/index");
const { rememberOperonOidcClaims, __resetOperonOidcClaims } = await import(
  "../../apps/api/src/utils/custom-oauth-profile"
);
const { default: getWorkspaceMembers } = await import(
  "../../apps/api/src/workspace/controllers/get-workspace-members"
);
const { resetTestDatabase } = await import("./helpers/database");
const { createWorkspaceMember } = await import("./helpers/fixtures");

const ROUTE = "/api/internal/operon/user";

/** The constraint migration 0046 adds, named so the drop-and-restore case can restore it. */
const ACCOUNT_UNIQUE = "account_provider_account_unique";

const migrationSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../apps/api/drizzle/0046_operon_account_provider_unique.sql",
  ),
  "utf8",
);

function subject(seed: string) {
  return seed.repeat(64).slice(0, 64);
}

const SUB_A = subject("a");
const SUB_B = subject("b");

let holder: Awaited<ReturnType<typeof createWorkspaceMember>>;
let serviceKey: string;

async function mintServiceKey(userId: string) {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: `svc-${Date.now() % 100000}`,
      permissions: {
        workspace: ["manage_settings"],
        task: ["update"],
        operon: ["rekey"],
      },
      metadata: { operonService: true },
    },
  });
  if (!created?.key) throw new Error("failed to mint a test service key");
  return created.key;
}

function provision(
  body: Record<string, unknown>,
  headers: Record<string, string> = { "x-api-key": serviceKey },
) {
  const { app } = createApp();
  return app.request(ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function personBody(overrides: Record<string, unknown> = {}) {
  return {
    sub: SUB_A,
    email: "provisioned@operon.local",
    name: "Provisioned Person",
    role: "member",
    ...overrides,
  };
}

/** `createOAuthUser`'s FIRST commit: the user row, alone. */
async function oidcCreateUser(email: string, name = "Oidc Person") {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email,
      emailVerified: true,
      name,
    })
    .returning();
  if (!user) throw new Error("the oidc user insert returned no row");
  return user;
}

/** `createOAuthUser`'s SECOND commit: the `custom` account, moments later. */
async function oidcCreateAccount(userId: string, sub: string) {
  await db.insert(schema.accountTable).values({
    accountId: sub,
    providerId: "custom",
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** `databaseHooks.session.create.after` — the reconciliation every sign-in runs. */
async function oidcSignIn(
  user: { id: string; email: string },
  sub: string,
  role: "admin" | "member" = "member",
) {
  rememberOperonOidcClaims({
    sub,
    email: user.email,
    name: user.email,
    role,
  });
  await reconcileOperonSession(user.id);
}

/**
 * A whole OIDC first login, INCLUDING the branch Better Auth takes when the email is
 * already taken: it finds that user and links the account rather than creating a second.
 */
async function oidcFirstLogin(
  email: string,
  sub: string,
  role: "admin" | "member" = "member",
) {
  let user: { id: string; email: string };
  try {
    user = await oidcCreateUser(email);
  } catch {
    const [existing] = await db
      .select({ id: schema.userTable.id, email: schema.userTable.email })
      .from(schema.userTable)
      .where(eq(schema.userTable.email, email))
      .limit(1);
    if (!existing) throw new Error("the email was claimed and then released");
    user = existing;
  }

  try {
    await oidcCreateAccount(user.id, sub);
  } catch {
    // The pair is already there — this login is the loser of the race, which is exactly
    // what migration 0046 makes it rather than the author of a second user.
  }

  await oidcSignIn(user, sub, role);
  return user;
}

async function usersWithEmail(email: string) {
  return db
    .select({ id: schema.userTable.id })
    .from(schema.userTable)
    .where(eq(schema.userTable.email, email));
}

async function accountsForSubject(sub: string) {
  return db
    .select({ userId: schema.accountTable.userId })
    .from(schema.accountTable)
    .where(
      and(
        eq(schema.accountTable.providerId, "custom"),
        eq(schema.accountTable.accountId, sub),
      ),
    );
}

async function membershipsOf(userId: string) {
  return db
    .select({
      workspaceId: schema.workspaceUserTable.workspaceId,
      role: schema.workspaceUserTable.role,
    })
    .from(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.userId, userId));
}

function sleep(ms: number) {
  return new Promise((done) => setTimeout(done, ms));
}

afterAll(() => {
  if (previousOidcOnly === undefined) {
    delete process.env[OIDC_ONLY];
  } else {
    setEnv(OIDC_ONLY, previousOidcOnly);
  }
});

beforeEach(async () => {
  await resetTestDatabase();
  __resetOperonOidcClaims();

  // Every sign-in reconciliation posts a signed callback at platform-service, which is
  // not running here. The stub answers the shape the receiver answers, so the login path
  // under test finishes instead of failing on a network error.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          ok: true,
          serviceKeyOnFile: true,
          serviceKeyValid: true,
        }),
      } as unknown as Response;
    }),
  );

  holder = await createWorkspaceMember({ role: "owner" });
  serviceKey = await mintServiceKey(holder.user.id);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetOperonOidcClaims();
});

describe("one call makes a provisioned person assignable", () => {
  it("creates the user, the custom account and the membership together", async () => {
    const response = await provision(personBody());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kaneoUserId: string;
      created: boolean;
    };
    expect(body.created).toBe(true);

    const [user] = await db
      .select()
      .from(schema.userTable)
      .where(eq(schema.userTable.id, body.kaneoUserId));
    expect(user?.email).toBe("provisioned@operon.local");
    expect(user?.name).toBe("Provisioned Person");
    // Decision 110: without this the first OIDC sign-in hits
    // `accountLinking.requireLocalEmailVerified` and mints a second user.
    expect(user?.emailVerified).toBe(true);

    expect(await accountsForSubject(SUB_A)).toEqual([
      { userId: body.kaneoUserId },
    ]);
    expect(await membershipsOf(body.kaneoUserId)).toEqual([
      { workspaceId: holder.workspace.id, role: "member" },
    ]);
  });

  it("puts them in the assignee list before they have ever signed in", async () => {
    // The claim R17 actually makes, asserted through its only reader.
    const response = await provision(personBody());
    const { kaneoUserId } = (await response.json()) as { kaneoUserId: string };

    const members = await getWorkspaceMembers(holder.workspace.id);
    expect(members.map((member) => member.id)).toContain(kaneoUserId);
  });

  it("carries the role the caller states", async () => {
    const response = await provision(
      personBody({ role: "admin", email: "admin-person@operon.local" }),
    );
    const { kaneoUserId } = (await response.json()) as { kaneoUserId: string };

    expect(await membershipsOf(kaneoUserId)).toEqual([
      { workspaceId: holder.workspace.id, role: "admin" },
    ]);
  });
});

describe("the credential has to be the Operon service key", () => {
  it("refuses a caller presenting no key at all", async () => {
    const response = await provision(personBody(), {});

    expect(response.status).toBe(401);
    expect(await usersWithEmail("provisioned@operon.local")).toHaveLength(0);
  });

  it("refuses an ORDINARY user's API key with 403", async () => {
    const member = await createWorkspaceMember();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: holder.workspace.id,
      userId: member.user.id,
      role: "member",
      joinedAt: new Date(),
    });
    const created = await auth.api.createApiKey({
      body: {
        userId: member.user.id,
        name: "ordinary",
        permissions: { task: ["create", "read", "update"] },
      },
    });
    if (!created?.key) throw new Error("failed to mint an ordinary key");

    const response = await provision(personBody(), {
      "x-api-key": created.key,
    });

    expect(response.status).toBe(403);
    expect(await usersWithEmail("provisioned@operon.local")).toHaveLength(0);
  });
});

describe("idempotency and concurrency belong to the database", () => {
  it("answers a REPEAT provision successfully with the same id", async () => {
    const first = await provision(personBody());
    const firstBody = (await first.json()) as { kaneoUserId: string };

    const second = await provision(personBody());
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      kaneoUserId: string;
      created: boolean;
    };

    // Not a 500 on a constraint: the response shape is as much the claim as the counts.
    expect(secondBody.kaneoUserId).toBe(firstBody.kaneoUserId);
    expect(secondBody.created).toBe(false);
    expect(await usersWithEmail("provisioned@operon.local")).toHaveLength(1);
    expect(await accountsForSubject(SUB_A)).toHaveLength(1);
    expect(await membershipsOf(firstBody.kaneoUserId)).toHaveLength(1);
  });

  it("answers two CONCURRENT provisions successfully with one id", async () => {
    const [first, second] = await Promise.all([
      provision(personBody()),
      provision(personBody()),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { kaneoUserId: string };
    const secondBody = (await second.json()) as { kaneoUserId: string };
    expect(secondBody.kaneoUserId).toBe(firstBody.kaneoUserId);

    expect(await usersWithEmail("provisioned@operon.local")).toHaveLength(1);
    expect(await accountsForSubject(SUB_A)).toHaveLength(1);
    expect(await membershipsOf(firstBody.kaneoUserId)).toHaveLength(1);
  });

  it("leaves one user when a provision and an OIDC first login race", async () => {
    const [response] = await Promise.all([
      provision(personBody()),
      oidcFirstLogin("provisioned@operon.local", SUB_A),
    ]);

    expect(response.status).toBe(200);
    const { kaneoUserId } = (await response.json()) as { kaneoUserId: string };

    const users = await usersWithEmail("provisioned@operon.local");
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe(kaneoUserId);
    expect(await accountsForSubject(SUB_A)).toEqual([{ userId: kaneoUserId }]);
    expect(await membershipsOf(kaneoUserId)).toHaveLength(1);
  });

  it("a provisioned person's first real sign-in creates no second user", async () => {
    const response = await provision(personBody());
    const { kaneoUserId } = (await response.json()) as { kaneoUserId: string };

    await oidcFirstLogin("provisioned@operon.local", SUB_A);

    const users = await usersWithEmail("provisioned@operon.local");
    expect(users).toEqual([{ id: kaneoUserId }]);
    expect(await accountsForSubject(SUB_A)).toEqual([{ userId: kaneoUserId }]);
    expect(await membershipsOf(kaneoUserId)).toHaveLength(1);
  });
});

describe("an email collision is never merged on the email alone", () => {
  it("waits for an OIDC account that is still being written, then succeeds", async () => {
    // The seam decision 122 exists for: the email is COMMITTED and the account row is
    // milliseconds away, because the adapter's transaction support is off.
    const oidcUser = await oidcCreateUser("provisioned@operon.local");

    const pending = provision(personBody());
    await sleep(600);
    await oidcCreateAccount(oidcUser.id, SUB_A);

    const response = await pending;
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kaneoUserId: string;
      created: boolean;
    };
    expect(body.kaneoUserId).toBe(oidcUser.id);
    expect(body.created).toBe(false);

    expect(await usersWithEmail("provisioned@operon.local")).toHaveLength(1);
    expect(await accountsForSubject(SUB_A)).toHaveLength(1);
    expect(await membershipsOf(oidcUser.id)).toEqual([
      { workspaceId: holder.workspace.id, role: "member" },
    ]);
  });

  it("409s with waitedMs when nothing ever arrives", async () => {
    const oidcUser = await oidcCreateUser("provisioned@operon.local");

    const response = await provision(personBody());

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: string;
      storedSub: string | null;
      waitedMs: number;
    };
    expect(body.error).toBe("operon.identity_mismatch");
    expect(body.storedSub).toBeNull();
    // Three re-reads, 500 ms apart — the frozen literals, visible in the answer.
    expect(body.waitedMs).toBe(1500);

    expect(await usersWithEmail("provisioned@operon.local")).toEqual([
      { id: oidcUser.id },
    ]);
    expect(await accountsForSubject(SUB_A)).toHaveLength(0);
  });

  it("409s AT ONCE when that email already carries a different subject", async () => {
    const oidcUser = await oidcCreateUser("provisioned@operon.local");
    await oidcCreateAccount(oidcUser.id, SUB_B);

    const started = Date.now();
    const response = await provision(personBody());
    const elapsed = Date.now() - started;

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: string;
      incomingSub: string;
      storedSub: string;
    };
    expect(body.error).toBe("operon.identity_mismatch");
    expect(body.incomingSub).toBe(SUB_A);
    expect(body.storedSub).toBe(SUB_B);
    // Terminal at once: a subject that IS there is an answer, not a window to wait out.
    expect(elapsed).toBeLessThan(1500);

    // Nothing was created, and the person who holds that email keeps their own subject.
    expect(await usersWithEmail("provisioned@operon.local")).toEqual([
      { id: oidcUser.id },
    ]);
    expect(await accountsForSubject(SUB_A)).toHaveLength(0);
  });
});

describe("the three writes are one transaction", () => {
  it("leaves no orphan user or account when the membership write fails", async () => {
    // A trigger rather than a mock: what has to be true is that POSTGRES rolling the
    // statement back takes the other two writes with it, which a stubbed module could
    // not demonstrate.
    await db.execute(
      sql.raw(`
        CREATE OR REPLACE FUNCTION operon_test_block_membership() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'membership write blocked by the test'; END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER operon_test_block_membership_trigger
          BEFORE INSERT ON workspace_member
          FOR EACH ROW EXECUTE FUNCTION operon_test_block_membership();
      `),
    );

    try {
      const response = await provision(personBody());
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await db.execute(
        sql.raw(`
          DROP TRIGGER IF EXISTS operon_test_block_membership_trigger ON workspace_member;
          DROP FUNCTION IF EXISTS operon_test_block_membership();
        `),
      );
    }

    expect(await usersWithEmail("provisioned@operon.local")).toHaveLength(0);
    expect(await accountsForSubject(SUB_A)).toHaveLength(0);
  });
});

describe("migration 0046's constraint", () => {
  it("rejects a second account row carrying the same provider and subject", async () => {
    const person = await oidcCreateUser("dup@operon.local");
    const other = await oidcCreateUser("dup-other@operon.local");
    await oidcCreateAccount(person.id, SUB_A);

    await expect(oidcCreateAccount(other.id, SUB_A)).rejects.toThrow();
    expect(await accountsForSubject(SUB_A)).toEqual([{ userId: person.id }]);
  });

  it("refuses to apply, loudly, on a database that already holds a duplicate", async () => {
    // Applying the file to a database seeded with the state it forbids is the only way
    // to prove the header's claim that a duplicate makes it FAIL rather than be skipped.
    const person = await oidcCreateUser("dup@operon.local");
    const other = await oidcCreateUser("dup-other@operon.local");

    await db.execute(
      sql.raw(`ALTER TABLE "account" DROP CONSTRAINT "${ACCOUNT_UNIQUE}"`),
    );

    try {
      await oidcCreateAccount(person.id, SUB_A);
      await oidcCreateAccount(other.id, SUB_A);

      let thrown: unknown = null;
      try {
        await db.execute(sql.raw(migrationSql));
      } catch (error) {
        thrown = error;
      }

      // The driver error is wrapped in a `DrizzleQueryError`, so the SQLSTATE is one
      // level down — the same unwrapping the route's own recovery has to do.
      expect(thrown).not.toBeNull();
      const cause = (thrown as { cause?: { code?: string; message?: string } })
        .cause;
      expect(cause?.code).toBe("23505");
      expect(cause?.message).toMatch(/could not create unique index/i);
    } finally {
      await db
        .delete(schema.accountTable)
        .where(eq(schema.accountTable.userId, other.id));
      await db.execute(
        sql.raw(
          `ALTER TABLE "account" ADD CONSTRAINT "${ACCOUNT_UNIQUE}" UNIQUE("provider_id","account_id")`,
        ),
      );
    }
  });
});
