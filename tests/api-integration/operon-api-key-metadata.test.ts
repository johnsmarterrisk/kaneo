import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import {
  __resetOperonOidcClaims,
  rememberOperonOidcClaims,
} from "../../apps/api/src/utils/custom-oauth-profile";
import { resetTestDatabase } from "./helpers/database";

/**
 * Operon fork checks — the two claims that need an instance which is NOT in Operon mode.
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
 *
 * It also proves the provisioning hook is wired where the fork says it is: on
 * `databaseHooks.session.create`, not on `user.create`.
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

describe("provisioning is wired to session creation", () => {
  it("bootstraps the workspace on the sign-in that creates the session", async () => {
    // Nothing but `provisionOperonUser` creates a workspace with the slug `operon`, and
    // it only runs when a live OIDC profile capture exists for the address — so this
    // asserts the hook fires, on a real request, through the real Better Auth path.
    const deliveries: { workspaceId: string | null; apiKey?: string }[] = [];
    // Indexed, for the `noUndeclaredEnvVars` reason given in `operon-oidc-only.test.ts`.
    const setEnv = (key: string, value: string) => {
      process.env[key] = value;
    };
    setEnv("OPERON_INTERNAL_API_URL", "http://platform-service.test:3001");
    setEnv("OPERON_KANEO_S2S_SECRET", "an-s2s-secret-for-the-suite");
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      deliveries.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => "" } as Response;
    });

    const email = `oidc-${randomUUID()}@example.com`;
    rememberOperonOidcClaims({
      sub: "c".repeat(64),
      email,
      name: "An Operon Admin",
      role: "admin",
    });

    const { app } = createApp();
    await signUp(app, email);

    const [workspace] = await db
      .select()
      .from(schema.workspaceTable)
      .where(eq(schema.workspaceTable.slug, "operon"));
    expect(workspace).toBeTruthy();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.apiKey).toBeTypeOf("string");
  });
});
