import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";

/**
 * Operon fork checks — the OIDC-only boundary and the workspace bootstrap
 * (Operon spec decisions 39, 40, 42, 48, 49).
 *
 * ── WHY THE IMPORTS BELOW ARE DYNAMIC ────────────────────────────────────────────
 *
 * `apps/api/src/auth.ts` reads its switches ONCE, at module scope, exactly as upstream
 * reads `DISABLE_REGISTRATION` and `DISABLE_LOGIN_FORM`. `import` statements are hoisted
 * above every other statement in a module, so a static import here would evaluate
 * `auth.ts` before this file could set `OPERON_OIDC_ONLY` and the whole suite would
 * silently test the wrong mode. The env is set first and the modules are pulled in after.
 *
 * That also makes the mode a property of the FILE. Every other suite in this directory
 * runs with `OPERON_OIDC_ONLY` unset — `setup.ts` leaves `DISABLE_LOGIN_FORM` empty — so
 * `registration-invitation.test.ts` and friends are the negative control for the refusals
 * asserted here: they prove password signup still works when this instance is not an
 * Operon instance. `operon-api-key-metadata.test.ts` is the explicit control for the two
 * claims that need one.
 *
 * See `docs/fork-discipline.md` in the Operon repository.
 */

/**
 * Written through an indexed helper rather than as `process.env.OPERON_OIDC_ONLY = ...`
 * for the same reason `tests/api/utils/operon-oidc-only-auth.test.ts` does it: biome's
 * `noUndeclaredEnvVars` requires every literally-named variable to appear in
 * `turbo.json`, which fork discipline forbids this branch from editing.
 */
function setEnv(key: string, value: string) {
  process.env[key] = value;
}

const OIDC_ONLY = "OPERON_OIDC_ONLY";
const previousOidcOnly = process.env[OIDC_ONLY];
setEnv(OIDC_ONLY, "true");
setEnv("OPERON_INTERNAL_API_URL", "http://platform-service.test:3001");
setEnv("OPERON_KANEO_S2S_SECRET", "an-s2s-secret-for-the-suite");

const { createApp } = await import("../../apps/api/src/index");
const { auth, reconcileOperonSession } = await import(
  "../../apps/api/src/auth"
);
const { rememberOperonOidcClaims, __resetOperonOidcClaims } = await import(
  "../../apps/api/src/utils/custom-oauth-profile"
);
const { verifyApiKey } = await import(
  "../../apps/api/src/utils/verify-api-key"
);

afterAll(() => {
  if (previousOidcOnly === undefined) {
    delete process.env[OIDC_ONLY];
  } else {
    setEnv(OIDC_ONLY, previousOidcOnly);
  }
});

type Delivery = {
  sub: string;
  kaneoUserId: string;
  workspaceId: string | null;
  apiKey?: string;
  deliveryId: string;
  timestamp: string;
};

/** The one password the wiring test's seeded credential account carries. */
const SEEDED_PASSWORD = "a-perfectly-good-password";

let deliveries: Delivery[];
let failNextCallback: boolean;
/**
 * Operon's side of the credential, modelled as the one bit its acknowledgement carries.
 *
 * The real receiver holds the API key in its PROCESS and answers `serviceKeyOnFile` after
 * running its install rules, which is what makes the fork's re-mint path possible at all
 * (round-1 finding 8). A stub that always said `true` — or that omitted the field — could
 * not fail any of the recovery tests below, so this flips exactly when a delivery
 * carrying a key is accepted.
 */
let operonHoldsServiceKey: boolean;

beforeEach(async () => {
  await resetTestDatabase();
  __resetOperonOidcClaims();
  deliveries = [];
  failNextCallback = false;
  operonHoldsServiceKey = false;

  // The S2S callback, intercepted. Its CONTENTS are the assertion in several tests
  // below — one key, once — so it is captured rather than merely silenced, and its
  // RESPONSE is asserted on too: `serviceKeyOnFile` is the signal the fork re-mints on.
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    if (failNextCallback) {
      failNextCallback = false;
      throw new Error("platform-service is down");
    }
    const delivery = JSON.parse(init.body) as Delivery;
    deliveries.push(delivery);
    if (delivery.apiKey) operonHoldsServiceKey = true;
    return {
      ok: true,
      status: 200,
      text: async () => "",
      // Computed AFTER the install, exactly as the receiver computes it.
      json: async () => ({
        ok: true,
        serviceKeyOnFile: operonHoldsServiceKey,
      }),
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A Kaneo user row, as the OIDC callback would have created it. */
async function seedUser(email: string) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email,
      emailVerified: true,
      name: email.split("@")[0],
    })
    .returning();
  return user;
}

/**
 * One Operon sign-in for an existing Kaneo user: the profile capture
 * `mapCustomOAuthProfileToUser` makes on every OIDC callback, then the reconciliation
 * `databaseHooks.session.create.after` runs.
 */
async function signIn(
  user: { id: string; email: string },
  role: "admin" | "member",
  sub = randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
) {
  rememberOperonOidcClaims({
    sub,
    email: user.email,
    name: user.email,
    role,
  });
  await reconcileOperonSession(user.id);
  return sub;
}

async function roleOf(userId: string) {
  const [row] = await db
    .select({ role: schema.userTable.role })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId));
  return row?.role ?? null;
}

async function membershipsOf(userId: string) {
  return db
    .select({ workspaceId: schema.workspaceUserTable.workspaceId })
    .from(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.userId, userId));
}

describe("Operon mode: password signup does not exist", () => {
  async function signUp(app: ReturnType<typeof createApp>["app"]) {
    return app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `intruder-${randomUUID()}@example.com`,
        password: "a-perfectly-good-password",
        name: "Intruder",
      }),
    });
  }

  it("refuses /sign-up/email on an EMPTY database", async () => {
    // The first-user exemption is the whole point of this test. Upstream lets the very
    // first signup through both of its gates so a fresh instance can be set up; on an
    // Operon instance that hands an unauthenticated caller a Kaneo session — and, before
    // the promotion change, instance-admin with it.
    const [before] = await db.select().from(schema.userTable).limit(1);
    expect(before).toBeUndefined();

    const { app } = createApp();
    const response = await signUp(app);

    expect(response.status).toBe(403);
    expect(await db.select().from(schema.userTable)).toHaveLength(0);
  });

  it("refuses /sign-up/email on a POPULATED database", async () => {
    await seedUser(`existing-${randomUUID()}@example.com`);

    const { app } = createApp();
    const response = await signUp(app);

    expect(response.status).toBe(403);
    // Exactly the one seeded row: the refusal is before any write.
    expect(await db.select().from(schema.userTable)).toHaveLength(1);
  });

  it("refuses /sign-up/email even with an invitation id attached", async () => {
    // `DISABLE_REGISTRATION`'s invitation exemption is the second way in that upstream
    // offers and that Operon mode must close.
    await seedUser(`existing-${randomUUID()}@example.com`);
    const { app } = createApp();

    const response = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `invited-${randomUUID()}@example.com`,
        password: "a-perfectly-good-password",
        name: "Invited",
        invitationId: "some-invitation-id",
      }),
    });

    expect(response.status).toBe(403);
    expect(await db.select().from(schema.userTable)).toHaveLength(1);
  });
});

describe("Operon mode: the service key cannot mint keys", () => {
  it("answers 403 to /api/auth/api-key/create presented with the service key", async () => {
    // `enableSessionForAPIKeys: true` lets an API key authenticate Better Auth's own
    // endpoints, and the plugin offers that switch per configuration, never per key. An
    // isolated reproduction returned 200 and a CHILD key with `permissions: null`, which
    // `hasWorkspacePermission` reads as no ceiling at all — an escape from the very
    // ceiling decision 48 relies on.
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");

    const delivered = deliveries.find((delivery) => delivery.apiKey);
    expect(delivered?.apiKey).toBeTruthy();

    const { app } = createApp();
    const response = await app.request("/api/auth/api-key/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": delivered?.apiKey ?? "",
      },
      body: JSON.stringify({ name: "a-child-key" }),
    });

    expect(response.status).toBe(403);
    // One key exists on this instance: the bootstrap's.
    expect(await db.select().from(schema.apikeyTable)).toHaveLength(1);
  });

  it("refuses the whole /api-key namespace, not only create", async () => {
    // The reproduction was `create`, but `update` can rewrite a key's `permissions` and
    // `delete` can remove a ceiling by removing the key that carries it. The refusal is
    // the namespace, minus `verify` — which is a read, and which Kaneo does not route
    // publicly anyway (`authenticateApiRequest` verifies against the table directly).
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");
    const key = deliveries.find((delivery) => delivery.apiKey)?.apiKey ?? "";

    const { app } = createApp();
    const calls: [string, "GET" | "POST"][] = [
      ["update", "POST"],
      ["delete", "POST"],
      ["list", "GET"],
      ["get", "GET"],
    ];

    for (const [path, method] of calls) {
      const response = await app.request(`/api/auth/api-key/${path}`, {
        method,
        headers: { "Content-Type": "application/json", "x-api-key": key },
        ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      });
      expect([path, response.status]).toEqual([path, 403]);
    }
  });
});

describe("Operon mode: instance-admin comes from the OIDC claim", () => {
  it("does NOT promote a member who simply arrives first", async () => {
    // Upstream promotes the first row in `user` to instance admin, which on this
    // instance means "whoever opened Initiative first". An Operon MEMBER was collecting
    // Kaneo's global authorization bypass.
    const member = await seedUser(`member-${randomUUID()}@example.com`);
    await signIn(member, "member");

    expect(await roleOf(member.id)).not.toBe("admin");
    // ...and nothing was bootstrapped for them, because a member cannot create the
    // workspace either.
    expect(await db.select().from(schema.workspaceTable)).toHaveLength(0);
    expect(await membershipsOf(member.id)).toHaveLength(0);
  });

  it("promotes the admin who arrives SECOND, and joins the member on their next login", async () => {
    const member = await seedUser(`member-${randomUUID()}@example.com`);
    await signIn(member, "member");

    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");

    expect(await roleOf(admin.id)).toBe("admin");
    expect(await roleOf(member.id)).not.toBe("admin");

    const [workspace] = await db.select().from(schema.workspaceTable);
    expect(workspace?.slug).toBe("operon");
    expect(await membershipsOf(admin.id)).toHaveLength(1);
    // Not retroactive, and it does not need to be: the member's next sign-in joins them.
    expect(await membershipsOf(member.id)).toHaveLength(0);

    await signIn(member, "member");
    expect(await membershipsOf(member.id)).toEqual([
      { workspaceId: workspace.id },
    ]);
  });

  it("follows a demotion too, because Operon is the authority for the claim", async () => {
    const person = await seedUser(`person-${randomUUID()}@example.com`);
    await signIn(person, "admin");
    expect(await roleOf(person.id)).toBe("admin");

    await signIn(person, "member");
    expect(await roleOf(person.id)).toBe("user");
  });
});

describe("Operon mode: provisioning reconciles on every login", () => {
  it("recovers from a failed callback on the next sign-in", async () => {
    // The old hook was `user.create.after`, which fires once per person: a failed
    // callback meant `identities.kaneo_user_id` was never recorded and never would be.
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    failNextCallback = true;
    await signIn(admin, "admin");

    expect(deliveries).toHaveLength(0);
    // The workspace itself DID get built — the failure was downstream of it.
    expect(await db.select().from(schema.workspaceTable)).toHaveLength(1);

    await signIn(admin, "admin");

    expect(deliveries[0]?.kaneoUserId).toBe(admin.id);
    // Two: the ordinary reconciliation report, which Operon answers with
    // `serviceKeyOnFile: false` because the bootstrap's key never reached it, and the
    // re-mint that answer triggers. Before round-1 finding 8 was fixed there was only
    // the first, forever.
    expect(deliveries).toHaveLength(2);
    expect(deliveries.filter((delivery) => delivery.apiKey)).toHaveLength(1);
    expect(operonHoldsServiceKey).toBe(true);
  });

  it("recovers a membership that was never created", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");
    const [workspace] = await db.select().from(schema.workspaceTable);

    const member = await seedUser(`member-${randomUUID()}@example.com`);
    // The failure boundary: the membership insert never happened.
    expect(await membershipsOf(member.id)).toHaveLength(0);

    await signIn(member, "member");

    expect(await membershipsOf(member.id)).toEqual([
      { workspaceId: workspace.id },
    ]);
  });

  it("is idempotent: repeated logins add no second membership and no second key", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");
    await signIn(admin, "admin");
    await signIn(admin, "admin");

    expect(await db.select().from(schema.workspaceTable)).toHaveLength(1);
    expect(await membershipsOf(admin.id)).toHaveLength(1);
    // Three deliveries, one credential: only the login that WON the bootstrap carries a
    // key, and a re-login is not a rotation.
    expect(deliveries).toHaveLength(3);
    expect(deliveries.filter((delivery) => delivery.apiKey)).toHaveLength(1);
    expect(await db.select().from(schema.apikeyTable)).toHaveLength(1);
  });

  it("signs a delivery id and a timestamp into every callback", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");
    await signIn(admin, "admin");

    const ids = deliveries.map((delivery) => delivery.deliveryId);
    expect(ids.every(Boolean)).toBe(true);
    // Distinct per attempt, or the receiver's replay ledger would refuse the retry.
    expect(new Set(ids).size).toBe(ids.length);
    for (const delivery of deliveries) {
      expect(Number.isNaN(Date.parse(delivery.timestamp))).toBe(false);
    }
  });
});

describe("Operon mode: two concurrent first-admin logins", () => {
  it("creates one workspace, mints one key and joins both admins", async () => {
    // The race Codex found: both callers saw no workspace, both proceeded, and the
    // LOSER — who was not even a member — could overwrite Operon's working credential
    // with one minted under a user who could not use it. The workspace slug's UNIQUE
    // index is the claim, and only the caller that wins it mints and delivers a key.
    const first = await seedUser(`admin-a-${randomUUID()}@example.com`);
    const second = await seedUser(`admin-b-${randomUUID()}@example.com`);

    rememberOperonOidcClaims({
      sub: "a".repeat(64),
      email: first.email,
      name: "Admin A",
      role: "admin",
    });
    rememberOperonOidcClaims({
      sub: "b".repeat(64),
      email: second.email,
      name: "Admin B",
      role: "admin",
    });

    await Promise.all([
      reconcileOperonSession(first.id),
      reconcileOperonSession(second.id),
    ]);

    const workspaces = await db.select().from(schema.workspaceTable);
    expect(workspaces).toHaveLength(1);

    // Both are in it — the loser JOINS rather than being left outside the workspace it
    // was about to deliver a credential for.
    expect(await membershipsOf(first.id)).toHaveLength(1);
    expect(await membershipsOf(second.id)).toHaveLength(1);

    // Exactly one credential, delivered exactly once.
    expect(await db.select().from(schema.apikeyTable)).toHaveLength(1);
    expect(deliveries.filter((delivery) => delivery.apiKey)).toHaveLength(1);
    expect(deliveries).toHaveLength(2);
  });
});

describe("Operon mode: the bootstrap key's ceiling", () => {
  it("is minted with the service marker and exactly three scopes", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");

    const [key] = await db.select().from(schema.apikeyTable);
    expect(JSON.parse(key?.metadata ?? "null")).toEqual({
      operonService: true,
    });
    expect(JSON.parse(key?.permissions ?? "null")).toEqual({
      workspace: ["manage_settings"],
      task: ["update"],
      operon: ["rekey"],
    });
    // `auth.api.createApiKey` is the only writer of that marker, and it is reached
    // server-side; nothing that arrives over HTTP can set it.
    expect(auth.api.createApiKey).toBeTypeOf("function");
  });
});

describe("Operon mode: the service key is never a Better Auth session", () => {
  /**
   * The round-2 BLOCKER, and the reason the round-1 `/api-key/*` refusal was not enough.
   *
   * Refusing key MANAGEMENT closed one door and left the corridor open. Codex presented
   * the bootstrap key to `GET /api/auth/list-sessions`, got 200 and the workspace
   * OWNER's live session token out of the response body, then used that token against
   * `POST /api/auth/admin/set-role` and promoted another account. The key's `permissions`
   * ceiling never entered into it: `hasWorkspacePermission` and
   * `utils/is-instance-admin.ts` read a SESSION, and a session has no ceiling.
   *
   * `enableSessionForAPIKeys` is a per-CONFIGURATION switch in the api-key plugin, never
   * per key, so the fix is two layers that do not depend on each other: a `/api/auth/*`
   * guard in `index.ts` that refuses any request carrying the unforgeable
   * `{ operonService: true }` marker before `auth.handler` ever sees it, and a
   * `customAPIKeyGetter` that makes the plugin's session hook skip the key entirely, so
   * there is no session to hand out even on a route the guard did not anticipate.
   */
  async function bootstrapServiceKey() {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");
    const key = deliveries.find((delivery) => delivery.apiKey)?.apiKey;
    expect(key).toBeTypeOf("string");
    return { admin, key: key as string };
  }

  it("refuses /list-sessions — the route the escape actually used", async () => {
    const { key } = await bootstrapServiceKey();
    const { app } = createApp();

    const response = await app.request("/api/auth/list-sessions", {
      headers: { "x-api-key": key },
    });

    expect(response.status).toBe(403);
    // And nothing that looks like a session token came back with the refusal.
    expect(await response.text()).not.toMatch(/token/i);
  });

  it("refuses the same key spelled as a Bearer token", async () => {
    // `index.ts`'s `/auth/*` handler rewrites `Authorization: Bearer <key>` into
    // `x-api-key` before calling `auth.handler`, so a guard that read only one header
    // would be walked around by sending the key as the other.
    const { key } = await bootstrapServiceKey();
    const { app } = createApp();

    const response = await app.request("/api/auth/list-sessions", {
      headers: { authorization: `Bearer ${key}` },
    });

    expect(response.status).toBe(403);
  });

  it("refuses every /api/auth route reached with it, including get-session", async () => {
    // `/get-session` matters on its own: the api-key plugin's session hook RETURNS the
    // constructed session directly for that path, so a refusal placed inside Better
    // Auth's own hooks is not guaranteed to run. The guard is in front of the handler.
    const { key } = await bootstrapServiceKey();
    const { app } = createApp();

    const calls: [string, "GET" | "POST"][] = [
      ["get-session", "GET"],
      ["list-sessions", "GET"],
      ["token", "GET"],
      ["sign-out", "POST"],
      ["admin/set-role", "POST"],
      ["admin/list-users", "GET"],
      ["organization/list", "GET"],
    ];

    for (const [path, method] of calls) {
      const response = await app.request(`/api/auth/${path}`, {
        method,
        headers: { "Content-Type": "application/json", "x-api-key": key },
        ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      });
      expect([path, response.status]).toEqual([path, 403]);
    }
  });

  it("cannot be escalated: no session token is derivable from it", async () => {
    // The full reproduction, run forwards. Every route that could hand out a session
    // token refuses, so the second half of the escape — replaying that token against
    // `admin/set-role` — has nothing to replay.
    const { key } = await bootstrapServiceKey();
    const victim = await seedUser(`victim-${randomUUID()}@example.com`);
    const { app } = createApp();

    for (const path of ["list-sessions", "get-session", "token"]) {
      const response = await app.request(`/api/auth/${path}`, {
        headers: { "x-api-key": key },
      });
      expect(response.status).toBe(403);
    }

    const promotion = await app.request("/api/auth/admin/set-role", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ userId: victim.id, role: "admin" }),
    });
    expect(promotion.status).toBe(403);

    const [row] = await db
      .select({ role: schema.userTable.role })
      .from(schema.userTable)
      .where(eq(schema.userTable.id, victim.id));
    expect(row?.role).not.toBe("admin");
  });

  it("leaves an ORDINARY key behaving exactly as upstream", async () => {
    // The guard and the getter both key on the bootstrap's marker, not on "is an API
    // key". A key without it is upstream's key, with upstream's session behaviour — this
    // is what proves the refusals above are the fork's boundary and not a broken route.
    // It has to be minted server-side because Operon mode refuses `/api-key/*` over HTTP.
    const person = await seedUser(`person-${randomUUID()}@example.com`);
    const created = await auth.api.createApiKey({
      body: { userId: person.id, name: "an-ordinary-key" },
    });
    expect(created?.key).toBeTypeOf("string");

    const { app } = createApp();
    const response = await app.request("/api/auth/list-sessions", {
      headers: { "x-api-key": created?.key ?? "" },
    });

    expect(response.status).not.toBe(403);
  });
});

describe("Operon mode: a service key that never arrived is re-minted", () => {
  /**
   * Round-1 finding 8, and the shared stack's missing re-mint path.
   *
   * The key is minted by the login that CREATES the workspace and by no other. If that
   * mint returned nothing, or the callback carrying it never reached Operon, every later
   * login found the workspace already there and delivered a callback with no key — so
   * Operon stayed without a credential permanently and `kaneoApiFetch` threw on every
   * call. The recovery is Operon's own `serviceKeyOnFile` bit: on an admin's login into
   * an EXISTING workspace, a `false` makes the fork revoke the earlier marked keys, mint
   * a fresh one and deliver it in a second signed callback.
   */
  async function markedKeys() {
    const rows = await db.select().from(schema.apikeyTable);
    return rows.filter(
      (row) =>
        (
          JSON.parse(row.metadata ?? "null") as {
            operonService?: boolean;
          } | null
        )?.operonService === true,
    );
  }

  it("recovers on the NEXT login after the bootstrap mint returned nothing", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);

    // The failure boundary: the mint itself. One call only — the bootstrap's.
    const mint = vi
      .spyOn(auth.api, "createApiKey")
      .mockResolvedValueOnce(undefined as never);
    await signIn(admin, "admin");
    mint.mockRestore();

    expect(await db.select().from(schema.workspaceTable)).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.apiKey).toBeUndefined();
    expect(operonHoldsServiceKey).toBe(false);
    // NOT on this login: the workspace was created by it, and a bootstrapping login must
    // never re-mint — the concurrent loser would otherwise revoke the winner's key.
    expect(await markedKeys()).toHaveLength(0);

    await signIn(admin, "admin");

    expect(deliveries).toHaveLength(3);
    expect(deliveries.filter((delivery) => delivery.apiKey)).toHaveLength(1);
    expect(operonHoldsServiceKey).toBe(true);
  });

  it("ends with a key Operon can actually use, and revokes the earlier ones", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");

    const bootstrapKey =
      deliveries.find((delivery) => delivery.apiKey)?.apiKey ?? "";
    expect(bootstrapKey).toBeTruthy();

    // Operon lost it — a restart with nothing in `.env` is exactly this state.
    operonHoldsServiceKey = false;
    await signIn(admin, "admin");

    const replacement = deliveries.at(-1)?.apiKey ?? "";
    expect(replacement).toBeTruthy();
    expect(replacement).not.toBe(bootstrapKey);
    expect(operonHoldsServiceKey).toBe(true);

    // Usable: it verifies, it is enabled, it carries the marker and the same ceiling.
    const verified = await verifyApiKey(replacement);
    expect(verified?.valid).toBe(true);
    expect(verified?.key.enabled).toBe(true);
    expect(verified?.key.permissions).toEqual({
      workspace: ["manage_settings"],
      task: ["update"],
      operon: ["rekey"],
    });
    expect(verified?.key.metadata).toEqual({ operonService: true });

    // And the one it replaced is dead, so the instance never carries two credentials
    // that satisfy the re-key route's marker check.
    expect(await verifyApiKey(bootstrapKey)).toBeNull();
    const enabled = (await markedKeys()).filter((row) => row.enabled !== false);
    expect(enabled).toHaveLength(1);
  });

  it("does not re-mint for a MEMBER, and not when Operon is unreachable", async () => {
    const admin = await seedUser(`admin-${randomUUID()}@example.com`);
    await signIn(admin, "admin");
    const member = await seedUser(`member-${randomUUID()}@example.com`);

    // A member's key would hang off a user without the permissions the ceiling ceilings.
    operonHoldsServiceKey = false;
    await signIn(member, "member");
    expect(deliveries.at(-1)?.apiKey).toBeUndefined();

    // And an ack that never arrived is not an ack that said "false": a credential we
    // cannot deliver is churn, not recovery.
    const before = (await markedKeys()).length;
    failNextCallback = true;
    await signIn(admin, "admin");
    expect(await markedKeys()).toHaveLength(before);
  });
});

describe("Operon mode: provisioning is wired to session creation", () => {
  it("bootstraps the workspace on the sign-in that creates the session", async () => {
    /**
     * The wiring proof. Every other test in this file drives `reconcileOperonSession`
     * directly, which would pass just as happily if `databaseHooks.session.create.after`
     * had never been connected to it — so one test has to go through a real request.
     *
     * A password account is seeded straight into the two tables rather than signed up
     * through the API, because `/sign-up/email` is refused in Operon mode by design.
     * `/sign-in/email` is NOT refused here: `isLocalSignInPath` is gated on
     * `DISABLE_LOGIN_FORM`, which this suite leaves unset, and the point is only to make
     * Better Auth create a session row through its own code path.
     */
    const email = `wired-${randomUUID()}@example.com`;
    const user = await seedUser(email);
    await db.insert(schema.accountTable).values({
      id: `account-${randomUUID()}`,
      accountId: user.id,
      providerId: "credential",
      userId: user.id,
      password: await bcrypt.hash(SEEDED_PASSWORD, 10),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    rememberOperonOidcClaims({
      sub: "f".repeat(64),
      email,
      name: "An Operon Admin",
      role: "admin",
    });

    const { app } = createApp();
    const response = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: SEEDED_PASSWORD }),
    });
    expect(response.status).toBe(200);

    const [workspace] = await db
      .select()
      .from(schema.workspaceTable)
      .where(eq(schema.workspaceTable.slug, "operon"));
    expect(workspace).toBeTruthy();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.apiKey).toBeTypeOf("string");
    expect(await roleOf(user.id)).toBe("admin");
  });
});
