import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "pg";
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
 * TWO WAYS, and the difference between them matters (round-1 finding 2).
 *
 * {@link oidcCallbackLogin} drives the REAL endpoint: `auth.api.signInWithOAuth2` stores
 * the state, `auth.api.oAuth2Callback` runs `mapCustomOAuthProfileToUser`,
 * `handleOAuthUserInfo`, `createOAuthUser` and the session hooks, and the identity
 * provider on the wire is the stubbed `fetch` in `beforeEach`. Every claim about what the
 * callback does when a write conflicts is made through it, because an imitation of that
 * path recovered from an email collision in a way the installed Better Auth does not —
 * which is precisely what finding 2 was.
 *
 * {@link oidcCreateUser} and {@link oidcCreateAccount} remain, but only to SEED a state.
 * They write the `user` and THEN the `account` as two separately committed statements,
 * which is what `createOAuthUser` does — the Drizzle adapter is built in `auth.ts` with no
 * `transaction` option and the installed adapter defaults it to `false` — so they can
 * stage a sign-in caught mid-write, which is the seam decision 122 waits on.
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

/**
 * The `custom` provider Better Auth's generic-OAuth plugin is configured from, pointed at
 * endpoints the stubbed `fetch` below answers. Set here, before `auth.ts` is imported, for
 * the same module-scope reason `OPERON_OIDC_ONLY` is: the plugin reads them once.
 *
 * With these, {@link oidcCallbackLogin} drives the REAL callback — `oAuth2Callback` →
 * `mapCustomOAuthProfileToUser` → `handleOAuthUserInfo` → `createOAuthUser` — instead of
 * a hand-rolled imitation of it. Round-1 finding 2 was that the imitation recovered from
 * an email collision in ways the real path did not, so the imitation is gone.
 */
const OIDC_TOKEN_URL = "https://operon.test/oauth/token";
const OIDC_USER_INFO_URL = "https://operon.test/oauth/userinfo";
setEnv("CUSTOM_OAUTH_CLIENT_ID", "operon-initiative");
setEnv("CUSTOM_OAUTH_CLIENT_SECRET", "operon-initiative-secret");
setEnv("CUSTOM_OAUTH_AUTHORIZATION_URL", "https://operon.test/oauth/authorize");
setEnv("CUSTOM_OAUTH_TOKEN_URL", OIDC_TOKEN_URL);
setEnv("CUSTOM_OAUTH_USER_INFO_URL", OIDC_USER_INFO_URL);

const dbModule = await import("../../apps/api/src/database");
const db = dbModule.default;
const { schema } = dbModule;
const { auth, reconcileWorkspaceMemberRole } = await import(
  "../../apps/api/src/auth"
);
const { createApp } = await import("../../apps/api/src/index");
const { __resetOperonOidcClaims, rememberOperonOidcClaims } = await import(
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

/** The constraint migration 0047 adds, same reason. */
const MEMBERSHIP_UNIQUE = "workspace_member_workspace_user_unique";

function readMigration(file: string) {
  return readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      `../../apps/api/drizzle/${file}`,
    ),
    "utf8",
  );
}

const migrationSql = readMigration("0046_operon_account_provider_unique.sql");
const membershipMigrationSql = readMigration(
  "0047_workspace_member_unique.sql",
);

function subject(seed: string) {
  return seed.repeat(64).slice(0, 64);
}

const SUB_A = subject("a");
const SUB_B = subject("b");

let holder: Awaited<ReturnType<typeof createWorkspaceMember>>;
let serviceKey: string;

/** The userinfo document the stubbed provider will serve on the next callback. */
let oidcProfile: {
  sub: string;
  email: string;
  name: string;
  role: "admin" | "member";
} | null = null;

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

/**
 * A whole OIDC first login, THROUGH THE REAL CALLBACK.
 *
 * `auth.api.signInWithOAuth2` mints and stores the state exactly as a browser sign-in
 * does; `auth.api.oAuth2Callback` then runs the endpoint Better Auth actually serves at
 * `/api/auth/oauth2/callback/custom`, so `mapCustomOAuthProfileToUser` captures the
 * claims, `handleOAuthUserInfo` does its `findOAuthUser` lookup, `createOAuthUser` writes
 * (or recovers), and `databaseHooks.session.create.after` reconciles — none of it
 * modelled here.
 *
 * The previous version of this helper wrote the two rows itself and caught the email
 * collision by re-reading the user, which is a recovery the installed Better Auth does
 * NOT have: its `createOAuthUser` catch returns `unable to create user` and the callback
 * redirects to the error page. That imitation was round-1 finding 2, and this is its
 * replacement — the recovery now lives in `auth.ts`'s adapter wrapper, where the real
 * callback reaches it.
 *
 * Returns the callback's redirect target, so a test can tell a completed sign-in from
 * `…/error?error=unable_to_create_user`.
 */
async function oidcCallbackLogin(
  email: string,
  sub: string,
  role: "admin" | "member" = "member",
  name = "Oidc Person",
) {
  oidcProfile = { sub, email, name, role };

  const started = await auth.api.signInWithOAuth2({
    body: { providerId: "custom", callbackURL: "/", disableRedirect: true },
    asResponse: true,
  });

  // The callback verifies the state against a SIGNED COOKIE as well as the verification
  // row, so the browser's half of the round trip has to be carried across too. This is
  // the cookie jar, and it is the whole of it.
  const cookies = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  if (!state) throw new Error("the authorization URL carried no state");

  const response = await auth.api.oAuth2Callback({
    params: { providerId: "custom" },
    query: { code: "an-authorization-code", state },
    headers: new Headers({ cookie: cookies }),
    asResponse: true,
  });

  return {
    status: response.status,
    location: response.headers.get("location") ?? "",
  };
}

/** Did the real callback finish a sign-in, or bounce to Better Auth's error page? */
function signedIn(outcome: { location: string }) {
  return !outcome.location.includes("error");
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

  oidcProfile = null;

  // Two networks are stubbed here, and they answer differently.
  //
  //   * Operon's OIDC endpoints, so `oidcCallbackLogin` can drive the real callback:
  //     these must be genuine `Response` objects, because `betterFetch` reads the
  //     content type off the headers before it will parse a body.
  //   * platform-service, which every sign-in reconciliation posts a signed callback at
  //     and which is not running here. The stub answers the shape the receiver answers,
  //     so the login path under test finishes instead of failing on a network error.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : String((input as { url?: string })?.url ?? "");

      if (url.startsWith(OIDC_TOKEN_URL)) {
        return new Response(
          JSON.stringify({
            access_token: "an-access-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith(OIDC_USER_INFO_URL)) {
        if (!oidcProfile) throw new Error("no oidc profile was staged");
        return new Response(
          JSON.stringify({
            sub: oidcProfile.sub,
            email: oidcProfile.email,
            email_verified: true,
            name: oidcProfile.name,
            role: oidcProfile.role,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

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
    const [response, login] = await Promise.all([
      provision(personBody()),
      oidcCallbackLogin("provisioned@operon.local", SUB_A),
    ]);

    expect(response.status).toBe(200);
    expect(signedIn(login)).toBe(true);
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

    const login = await oidcCallbackLogin("provisioned@operon.local", SUB_A);
    expect(signedIn(login)).toBe(true);

    const users = await usersWithEmail("provisioned@operon.local");
    expect(users).toEqual([{ id: kaneoUserId }]);
    expect(await accountsForSubject(SUB_A)).toEqual([{ userId: kaneoUserId }]);
    expect(await membershipsOf(kaneoUserId)).toHaveLength(1);
  });
});

/**
 * Round-1 finding 2 — the ONE ordering that used to break the real callback.
 *
 * `handleOAuthUserInfo` looks the person up and, finding nobody, calls `createOAuthUser`.
 * Provisioning committing BETWEEN those two statements is not a hypothetical: it is what
 * `POST /internal/operon/user` exists to do, and the installed Better Auth answers it with
 * `unable to create user` and no re-read at all. These tests force that exact interleaving
 * by making the lookup itself the trigger — a spy that calls through, runs the provision to
 * completion, and then returns the (empty) result the real lookup produced. Nothing about
 * the write path is stubbed: the recovery under test is the adapter wrapper in `auth.ts`.
 */
describe("the real OIDC callback survives provisioning winning the user-creation race", () => {
  async function provisionInsideTheLookup(
    body: Record<string, unknown>,
    alsoInsideTheWindow?: () => void,
  ) {
    const context = await auth.$context;
    const findOAuthUser = context.internalAdapter.findOAuthUser.bind(
      context.internalAdapter,
    );
    let fired = false;

    const spy = vi
      .spyOn(context.internalAdapter, "findOAuthUser")
      .mockImplementation(async (...args) => {
        const found = await findOAuthUser(
          ...(args as Parameters<typeof findOAuthUser>),
        );
        if (!fired) {
          fired = true;
          const response = await provision(body);
          if (response.status !== 200) {
            throw new Error(
              `the staged provision failed with ${response.status}`,
            );
          }
          alsoInsideTheWindow?.();
        }
        return found;
      });

    return () => {
      spy.mockRestore();
      return fired;
    };
  }

  it("recovers the provisioned user and signs them in", async () => {
    const done = await provisionInsideTheLookup(personBody());

    const login = await oidcCallbackLogin("provisioned@operon.local", SUB_A);

    expect(done()).toBe(true);
    // Before the fix this was `…/error?error=unable_to_create_user`.
    expect(signedIn(login)).toBe(true);
    expect(login.location).not.toContain("unable_to_create_user");

    const users = await usersWithEmail("provisioned@operon.local");
    expect(users).toHaveLength(1);
    expect(await accountsForSubject(SUB_A)).toEqual([
      { userId: users[0]?.id as string },
    ]);
    expect(await membershipsOf(users[0]?.id as string)).toEqual([
      { workspaceId: holder.workspace.id, role: "member" },
    ]);

    // The session is the proof the callback finished rather than merely not erroring.
    const sessions = await db
      .select({ id: schema.sessionTable.id })
      .from(schema.sessionTable)
      .where(eq(schema.sessionTable.userId, users[0]?.id as string));
    expect(sessions.length).toBeGreaterThan(0);
  });

  it("refuses when the address is held by a DIFFERENT subject, and never merges on the email", async () => {
    // Same interleaving, but the row that wins carries somebody else's identity. The
    // recovery verifies the subject, so this is a failed sign-in, not a hijacked account.
    const done = await provisionInsideTheLookup(
      personBody({ sub: SUB_B, email: "provisioned@operon.local" }),
    );

    const login = await oidcCallbackLogin("provisioned@operon.local", SUB_A);

    expect(done()).toBe(true);
    expect(signedIn(login)).toBe(false);
    expect(login.location).toContain("unable_to_create_user");

    const users = await usersWithEmail("provisioned@operon.local");
    expect(users).toHaveLength(1);
    // The winner keeps their own subject and SUB_A was never attached to anybody.
    expect(await accountsForSubject(SUB_B)).toEqual([
      { userId: users[0]?.id as string },
    ]);
    expect(await accountsForSubject(SUB_A)).toHaveLength(0);
  });

  it("never hands callback A the account another callback's claims point at", async () => {
    /**
     * Round-2 finding 1, staged exactly as the reviewer reproduced it.
     *
     * Callback A (subject SUB_A) reads "no user". Inside that window provisioning
     * commits subject SUB_B at the SAME address, and a concurrent callback for B
     * captures B's claims — which, while the capture was keyed by email, REPLACED A's.
     * A's insert then failed on `user.email`, and the recovery read the surviving
     * capture, found that B's user really did carry B's subject, and handed B's user
     * back to A. Better Auth then attached A's own distinct account to B and issued A a
     * session for B's Kaneo account.
     *
     * B's concurrent capture is staged through `rememberOperonOidcClaims` rather than a
     * second live callback because the whole defect is an ORDERING between two captures,
     * and a second real callback cannot be made to land in that window deterministically.
     * It is the same call `mapCustomOAuthProfileToUser` makes, with the same arguments.
     *
     * The fix removes both halves: the capture is keyed by subject, so B's no longer
     * displaces A's, and the recovery no longer consults a capture at all — it verifies
     * against the `(provider_id, account_id)` row of the account this very callback is
     * about to write.
     */
    const done = await provisionInsideTheLookup(
      personBody({ sub: SUB_B, email: "provisioned@operon.local" }),
      () =>
        rememberOperonOidcClaims({
          sub: SUB_B,
          email: "provisioned@operon.local",
          name: "Person B",
          role: "member",
        }),
    );

    const login = await oidcCallbackLogin("provisioned@operon.local", SUB_A);

    expect(done()).toBe(true);
    expect(signedIn(login)).toBe(false);
    expect(login.location).toContain("unable_to_create_user");

    const users = await usersWithEmail("provisioned@operon.local");
    expect(users).toHaveLength(1);
    const holderOfTheAddress = users[0]?.id as string;

    // B keeps their own subject, A's was never attached to anybody, and — the claim
    // that actually matters — no session exists for the account A nearly received.
    expect(await accountsForSubject(SUB_B)).toEqual([
      { userId: holderOfTheAddress },
    ]);
    expect(await accountsForSubject(SUB_A)).toHaveLength(0);

    const sessions = await db
      .select({ id: schema.sessionTable.id })
      .from(schema.sessionTable)
      .where(eq(schema.sessionTable.userId, holderOfTheAddress));
    expect(sessions).toHaveLength(0);
  });
});

/**
 * Round-2 finding 2 — the OTHER door, and it opens before any write conflicts.
 *
 * The recovery above only runs when an insert collides. `handleOAuthUserInfo` never gets
 * that far when provisioning has ALREADY committed: `findOAuthUser` finds no account for
 * the callback's subject, falls back to a lookup by email, finds the provisioned user —
 * and, with `custom` trusted and that user's email verified by construction, upstream
 * linked the incoming subject to them and issued their session. No conflict, no recovery,
 * no trace. `accountLinking.disableImplicitLinking` in Operon mode is the refusal.
 *
 * The path that legitimately uses the same window — a provisioned person signing in on
 * THEIR OWN subject — is asserted above ("a provisioned person's first real sign-in
 * creates no second user"): it matches on `(provider_id, account_id)` and never reaches
 * the email fallback at all.
 */
describe("an address somebody else holds is not a way into their account", () => {
  it("refuses a real callback whose subject no account carries", async () => {
    const response = await provision(personBody({ sub: SUB_B }));
    expect(response.status).toBe(200);
    const { kaneoUserId } = (await response.json()) as { kaneoUserId: string };

    const login = await oidcCallbackLogin("provisioned@operon.local", SUB_A);

    expect(signedIn(login)).toBe(false);
    expect(login.location).toContain("account_not_linked");

    // B is untouched: same single user, still carrying only their own subject.
    expect(await usersWithEmail("provisioned@operon.local")).toEqual([
      { id: kaneoUserId },
    ]);
    expect(await accountsForSubject(SUB_B)).toEqual([{ userId: kaneoUserId }]);
    expect(await accountsForSubject(SUB_A)).toHaveLength(0);

    const sessions = await db
      .select({ id: schema.sessionTable.id })
      .from(schema.sessionTable)
      .where(eq(schema.sessionTable.userId, kaneoUserId));
    expect(sessions).toHaveLength(0);
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

describe("migration 0047's constraint on workspace_member", () => {
  it("rejects a second membership row for the same person and workspace", async () => {
    const response = await provision(personBody());
    const { kaneoUserId } = (await response.json()) as { kaneoUserId: string };

    await expect(
      db.insert(schema.workspaceUserTable).values({
        workspaceId: holder.workspace.id,
        userId: kaneoUserId,
        role: "admin",
        joinedAt: new Date(),
      }),
    ).rejects.toThrow();

    expect(await membershipsOf(kaneoUserId)).toHaveLength(1);
  });

  it("refuses to apply, loudly, on a database that already holds a duplicate", async () => {
    // Same shape as 0046's proof: applying the file to a database seeded with the state
    // it forbids is the only way to show the header's claim that a duplicate makes it
    // FAIL rather than be skipped.
    const response = await provision(personBody());
    const { kaneoUserId } = (await response.json()) as { kaneoUserId: string };

    await db.execute(
      sql.raw(
        `ALTER TABLE "workspace_member" DROP CONSTRAINT "${MEMBERSHIP_UNIQUE}"`,
      ),
    );

    try {
      await db.insert(schema.workspaceUserTable).values({
        workspaceId: holder.workspace.id,
        userId: kaneoUserId,
        role: "admin",
        joinedAt: new Date(),
      });
      expect(await membershipsOf(kaneoUserId)).toHaveLength(2);

      let thrown: unknown = null;
      try {
        await db.execute(sql.raw(membershipMigrationSql));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).not.toBeNull();
      const cause = (thrown as { cause?: { code?: string; message?: string } })
        .cause;
      expect(cause?.code).toBe("23505");
      expect(cause?.message).toMatch(/could not create unique index/i);
    } finally {
      await db.execute(
        sql.raw(`
          DELETE FROM workspace_member m USING workspace_member keep
           WHERE m.workspace_id = keep.workspace_id
             AND m.user_id = keep.user_id
             AND (keep.joined_at, keep.id) < (m.joined_at, m.id);
        `),
      );
      await db.execute(
        sql.raw(
          `ALTER TABLE "workspace_member" ADD CONSTRAINT "${MEMBERSHIP_UNIQUE}" UNIQUE("workspace_id","user_id")`,
        ),
      );
    }
  });

  it("leaves ONE membership when both writers create it, and a later demotion moves it", async () => {
    // Round-1 finding 1, end to end. `POST /internal/operon/user` and the login path both
    // create the membership; before 0047 both could insert, and the demotion below then
    // updated ONE of the two rows and reported success while an `admin` row survived.
    const [created, login] = await Promise.all([
      provision(personBody({ role: "admin" })),
      oidcCallbackLogin("provisioned@operon.local", SUB_A, "admin"),
    ]);

    expect(created.status).toBe(200);
    expect(signedIn(login)).toBe(true);

    const users = await usersWithEmail("provisioned@operon.local");
    expect(users).toHaveLength(1);
    const kaneoUserId = users[0]?.id as string;
    expect(await membershipsOf(kaneoUserId)).toEqual([
      { workspaceId: holder.workspace.id, role: "admin" },
    ]);

    // And FORCED, not merely raced: the second writer's insert, issued with no read in
    // front of it, is the exact statement a lost check-then-insert used to land. 0047
    // refuses it, which is what keeps the demotion below addressing one row.
    await expect(
      db.insert(schema.workspaceUserTable).values({
        workspaceId: holder.workspace.id,
        userId: kaneoUserId,
        role: "admin",
        joinedAt: new Date(),
      }),
    ).rejects.toThrow();

    // The demotion, through both writers again. Exactly one row exists, so there is
    // nothing left behind still saying `admin`.
    const demoted = await provision(personBody({ role: "member" }));
    expect(demoted.status).toBe(200);
    const secondLogin = await oidcCallbackLogin(
      "provisioned@operon.local",
      SUB_A,
      "member",
    );
    expect(signedIn(secondLogin)).toBe(true);

    expect(await membershipsOf(kaneoUserId)).toEqual([
      { workspaceId: holder.workspace.id, role: "member" },
    ]);
  });
});

describe("owner preservation is atomic (round-1 finding 3)", () => {
  it("does not overwrite an ownership transfer that lands between the read and the write", async () => {
    // The interleaving, made real rather than described. A second connection opens a
    // transaction, makes the row the `owner` and HOLDS the row lock:
    //
    //   * the reconcile's SELECT runs against the committed snapshot and reads `member`;
    //   * its UPDATE blocks on that row lock;
    //   * the transfer commits;
    //   * Postgres re-evaluates the UPDATE's WHERE against the new row version.
    //
    // With the fix the predicate carries `role = <the role we read>` and `role <> 'owner'`,
    // so it matches nothing, the loop re-reads and finds the `owner` it must not demote.
    // With the previous `WHERE id = …` it matched, and `member` was written over `owner`.
    const response = await provision(personBody({ role: "admin" }));
    const { kaneoUserId } = (await response.json()) as { kaneoUserId: string };

    const [membership] = await db
      .select({ id: schema.workspaceUserTable.id })
      .from(schema.workspaceUserTable)
      .where(eq(schema.workspaceUserTable.userId, kaneoUserId))
      .limit(1);
    const membershipId = membership?.id as string;

    // Make the row disagree with the claim, so the reconcile below intends to write.
    await db
      .update(schema.workspaceUserTable)
      .set({ role: "admin" })
      .where(eq(schema.workspaceUserTable.id, membershipId));

    const transfer = new Client({ connectionString: process.env.DATABASE_URL });
    await transfer.connect();

    try {
      await transfer.query("BEGIN");
      await transfer.query(
        `UPDATE workspace_member SET role = 'owner' WHERE id = $1`,
        [membershipId],
      );

      const pending = reconcileWorkspaceMemberRole(
        holder.workspace.id,
        kaneoUserId,
        "member",
      );

      // Long enough for the reconcile to read `admin` and block on the row lock.
      await sleep(750);
      await transfer.query("COMMIT");

      await pending;
    } finally {
      await transfer.end();
    }

    expect(await membershipsOf(kaneoUserId)).toEqual([
      { workspaceId: holder.workspace.id, role: "owner" },
    ]);
  });

  it("still demotes an ordinary member when nothing interleaves", async () => {
    // The control: the compare-and-set is a guard, not a refusal to write.
    const response = await provision(personBody({ role: "admin" }));
    const { kaneoUserId } = (await response.json()) as { kaneoUserId: string };

    await reconcileWorkspaceMemberRole(
      holder.workspace.id,
      kaneoUserId,
      "member",
    );

    expect(await membershipsOf(kaneoUserId)).toEqual([
      { workspaceId: holder.workspace.id, role: "member" },
    ]);
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
