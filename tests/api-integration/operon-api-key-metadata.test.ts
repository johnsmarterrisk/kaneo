import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, reconcileOperonSession } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import {
  __resetOperonOidcClaims,
  hasOperonOidcClaims,
  mapCustomOAuthProfileToUser,
  rememberOperonOidcClaims,
  takeOperonOidcClaims,
} from "../../apps/api/src/utils/custom-oauth-profile";
import { resetTestDatabase } from "./helpers/database";

/**
 * Operon fork checks — the claims that need an instance which is NOT in Operon mode.
 *
 * `setup.ts` leaves `DISABLE_LOGIN_FORM` empty and never sets `OPERON_OIDC_ONLY`, and
 * `auth.ts` reads both once at module scope, so every suite in this directory except
 * `operon-oidc-only.test.ts` runs as an ordinary Kaneo instance. That makes this file the
 * control for two things:
 *
 *   1. **The refusals in `operon-oidc-only.test.ts` are conditional.** Password signup and
 *      API-key creation still work here, so those 403s are the fork's switch and not a
 *      route that was simply broken.
 *   2. **`enableMetadata: true` did not open a hole.** Upstream ran the api-key plugin
 *      with `enableMetadata: false`, under which every metadata-bearing call was refused.
 *      The fork turns the field on so the workspace bootstrap can MARK its own key — the
 *      marker `PATCH /api/internal/operon/account-id` recognises — and adds a
 *      `hooks.before` refusal so no HTTP caller can write it. An ordinary Kaneo caller
 *      therefore sees the same refusal it always saw, in EITHER mode.
 *   3. **Operon provisioning does not run here at all** (round-2 finding 2). `custom` is
 *      upstream's generic-OIDC provider slot, and until this round every profile that came
 *      through it was captured and reconciled as an Operon profile on EVERY instance —
 *      demoting instance administrators, auto-joining people to the earliest workspace and
 *      skipping the invitation gate. The last describe in this file is where the gate is
 *      proved; the wiring it used to prove instead now lives in `operon-oidc-only.test.ts`,
 *      where a real sign-in can be made without password signup being refused.
 *
 * See `docs/fork-discipline.md` in the Operon repository.
 */

type SignedUp = { userId: string; cookie: string; email: string };

async function signUp(
  app: ReturnType<typeof createApp>["app"],
  email = `control-${randomUUID()}@example.com`,
): Promise<SignedUp> {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "a-perfectly-good-password",
      name: "Control",
    }),
  });

  expect(response.status).toBe(200);

  const cookie = (response.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+=)/)
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");

  const [user] = await db
    .select({ id: schema.userTable.id })
    .from(schema.userTable)
    .where(eq(schema.userTable.email, email));

  return { userId: user?.id ?? "", cookie, email };
}

beforeEach(async () => {
  await resetTestDatabase();
  __resetOperonOidcClaims();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("outside Operon mode, upstream behaviour is untouched", () => {
  it("still allows password signup", async () => {
    const { app } = createApp();
    const { userId } = await signUp(app);
    expect(userId).toBeTruthy();
  });

  it("still allows a signed-in user to mint an API key", async () => {
    const { app } = createApp();
    const { cookie } = await signUp(app);

    const response = await app.request("/api/auth/api-key/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "my-personal-key" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).key).toBeTypeOf("string");
  });
});

describe("API key metadata is server-side only", () => {
  it("refuses metadata supplied over HTTP", async () => {
    // The marker cannot be forgeable, or the re-key route's credential check would be a
    // suggestion. `permissions` alone would not have done: the create endpoint accepts
    // those straight from a client request, so any member could claim `operon:["rekey"]`.
    const { app } = createApp();
    const { cookie } = await signUp(app);

    const response = await app.request("/api/auth/api-key/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        name: "a-forged-service-key",
        permissions: { operon: ["rekey"] },
        metadata: { operonService: true },
      }),
    });

    expect(response.status).toBe(400);
    expect(await db.select().from(schema.apikeyTable)).toHaveLength(0);
  });

  it("lets a SERVER-side mint set it, which is how the bootstrap marks its key", async () => {
    const { app } = createApp();
    const { userId } = await signUp(app);

    const created = await auth.api.createApiKey({
      body: {
        userId,
        name: "operon-platform-service",
        permissions: { operon: ["rekey"] },
        metadata: { operonService: true },
      },
    });

    expect(created?.key).toBeTypeOf("string");
    const [row] = await db.select().from(schema.apikeyTable);
    expect(JSON.parse(row?.metadata ?? "null")).toEqual({
      operonService: true,
    });
  });
});

describe("outside Operon mode, a custom-OIDC login is just an OIDC login", () => {
  /**
   * Round-2 finding 2. `providerId: "custom"` is UPSTREAM's generic-OIDC slot — any
   * self-hosted Kaneo can point it at Okta, Authentik or Keycloak — and the fork was
   * treating every profile that came through it as an Operon profile, on every instance.
   *
   * Three upstream behaviours were being overwritten as a result: `syncOperonInstanceRole`
   * rewrote `user.role` from a `role` claim the provider never meant that way (demoting a
   * real instance administrator on their next sign-in), the workspace bootstrap
   * auto-joined the person to the earliest workspace, and `hasOperonOidcClaims` waved
   * them past `DISABLE_REGISTRATION`'s invitation gate. R35 says a non-Operon instance
   * gets upstream's behaviour, so the capture and all three consumers are now gated on
   * Operon mode — and this file, which runs with the switch off, is where that is proved.
   */
  it("captures no claims at all, so the registration exemption cannot fire", async () => {
    // `hasOperonOidcClaims` IS the invitation-gate exemption in
    // `databaseHooks.user.create.before`. With nothing captured there is nothing to
    // exempt, on this instance, ever — which is the boundary rather than a coincidence.
    mapCustomOAuthProfileToUser({
      sub: "d".repeat(64),
      email: "someone@an-ordinary-oidc-provider.test",
      name: "Someone",
      role: "admin",
    });

    expect(hasOperonOidcClaims("someone@an-ordinary-oidc-provider.test")).toBe(
      false,
    );
    expect(
      takeOperonOidcClaims("someone@an-ordinary-oidc-provider.test"),
    ).toBeNull();
  });

  it("still maps the profile to a display name, exactly as upstream does", async () => {
    // The gate is on the capture, not on the function: upstream's own return value is
    // untouched in both modes, or every custom-OIDC user on every instance would lose
    // their name.
    expect(
      mapCustomOAuthProfileToUser({
        sub: "d".repeat(64),
        email: "someone@an-ordinary-oidc-provider.test",
        given_name: "Some",
        family_name: "One",
      }),
    ).toEqual({ name: "Some One" });
  });

  it("does not demote an instance administrator or auto-join any workspace", async () => {
    // The reconciliation is gated a SECOND time, at the consumer, so even a claim that
    // reached the map by some other route changes nothing here. Seeded through the test
    // seam precisely so the assertion is about `provisionOperonUser` and not about the
    // capture the previous test already covered.
    const { app } = createApp();
    const { userId, email } = await signUp(app);

    await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, userId));

    const deliveries: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      deliveries.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => "" } as Response;
    });

    rememberOperonOidcClaims({
      sub: "e".repeat(64),
      email,
      name: "An Administrator",
      // The demotion this used to cause: an ordinary provider's `role` claim, read as
      // Operon's, rewriting `user.role` to `user` on the next sign-in.
      role: "member",
    });
    await reconcileOperonSession(userId);

    const [row] = await db
      .select({ role: schema.userTable.role })
      .from(schema.userTable)
      .where(eq(schema.userTable.id, userId));
    expect(row?.role).toBe("admin");

    // No workspace was bootstrapped, nobody was joined to one, and no credential was
    // minted or shipped to a platform-service this instance does not have.
    expect(
      await db
        .select()
        .from(schema.workspaceTable)
        .where(eq(schema.workspaceTable.slug, "operon")),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.workspaceUserTable)
        .where(eq(schema.workspaceUserTable.userId, userId)),
    ).toHaveLength(0);
    expect(await db.select().from(schema.apikeyTable)).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });
});
