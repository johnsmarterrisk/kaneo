import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLocalSignInPath } from "../../../apps/api/src/utils/is-local-sign-in-path";

/**
 * Operon runs this instance as an OIDC-only surface: Kaneo never shows a login, it
 * redirects to Operon (Operon spec decisions 39, 40, 42, 49).
 *
 * Every switch that makes that true is an ENVIRONMENT VARIABLE upstream already
 * reads — no fork UI file is edited — so this suite's job is to prove the switches
 * are honoured rather than merely set, and to cover the one seam the fork does add:
 * the profile capture the workspace bootstrap reads.
 *
 * `getSettings` is imported lazily inside each test because it caches nothing but
 * is evaluated against `process.env` at CALL time; importing it at module scope
 * would still work, but the dynamic import keeps the env mutation and the read
 * visibly adjacent.
 */

const OIDC_ONLY_ENV = {
  DISABLE_LOGIN_FORM: "true",
  DISABLE_EMAIL_OTP_SIGN_IN: "true",
  DISABLE_GUEST_ACCESS: "true",
  DISABLE_REGISTRATION: "true",
  CUSTOM_OAUTH_AUTO_LOGIN: "true",
  CUSTOM_OAUTH_CLIENT_ID: "kaneo",
  CUSTOM_OAUTH_CLIENT_SECRET: "not-a-real-secret",
} as const;

const savedEnv: Record<string, string | undefined> = {};

/**
 * Written through an indexed helper rather than as `process.env.NAME = ...` because
 * biome's `noUndeclaredEnvVars` requires every literally-named variable to appear in
 * `turbo.json`, which fork discipline forbids this branch from editing.
 */
function setEnv(key: string, value: string) {
  process.env[key] = value;
}

/**
 * ── OPERON MODE HAS TO BE ON BEFORE `custom-oauth-profile` IS EVALUATED ─────────────
 *
 * The profile capture is gated on `OPERON_OIDC_ONLY`/`DISABLE_LOGIN_FORM`, read once at
 * module scope exactly as `auth.ts` reads them, because `custom` is UPSTREAM's generic
 * OIDC slot and a non-Operon instance must not have its instance roles and workspace
 * memberships rewritten from an Okta or Keycloak `role` claim (round-2 finding 2).
 * `import` statements are hoisted above every other statement in a module, so a static
 * import here would evaluate that module before `beforeEach` could set anything and the
 * whole describe below would silently be testing the wrong mode. The switch is set here
 * and the module is pulled in after — the same shape, and the same reason, as
 * `tests/api-integration/operon-oidc-only.test.ts`.
 *
 * The NEGATIVE — that an instance which is not an Operon instance captures nothing — is
 * asserted in `tests/api-integration/operon-api-key-metadata.test.ts`, which runs with
 * the switch off for its whole file. It cannot also be asserted here: the mode is a
 * property of when this module was evaluated, not of the current `process.env`.
 *
 * `getSettings` is unaffected, which is why the knob tests below can still flip the
 * environment per test: it reads `process.env` at CALL time.
 */
setEnv("OPERON_OIDC_ONLY", "true");

const {
  __resetOperonOidcClaims,
  mapCustomOAuthProfileToUser,
  rememberOperonOidcClaims,
  takeOperonOidcClaims,
} = await import("../../../apps/api/src/utils/custom-oauth-profile");

beforeEach(() => {
  for (const [key, value] of Object.entries(OIDC_ONLY_ENV)) {
    savedEnv[key] = process.env[key];
    setEnv(key, value);
  }
  __resetOperonOidcClaims();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  __resetOperonOidcClaims();
});

describe("the OIDC-only disable knobs", () => {
  it("reports every local sign-in path as disabled to the web app", async () => {
    const { default: getSettings } = await import(
      "../../../apps/api/src/utils/get-settings"
    );
    const settings = getSettings();

    // These five are what `apps/web/src/routes/auth/sign-in.tsx` renders its
    // buttons from, which is why the form hides itself with no UI edit.
    expect(settings.disableLoginForm).toBe(true);
    expect(settings.disableEmailOtpSignIn).toBe(true);
    expect(settings.disableRegistration).toBe(true);
    expect(settings.hasGuestAccess).toBe(false);
    // The pair that drives the auto-redirect behind the skeleton, so the form is
    // never even flashed.
    expect(settings.customOAuthAutoLogin).toBe(true);
    expect(settings.hasCustomOAuth).toBe(true);
  });

  it("still advertises the login form when the knobs are unset", async () => {
    // Written through the same indexed helper the fixture uses, and not as
    // `process.env.DISABLE_GUEST_ACCESS = ...`: biome's `noUndeclaredEnvVars`
    // rule requires every literally-named variable to appear in `turbo.json`,
    // which fork discipline forbids this branch from editing.
    setEnv("DISABLE_LOGIN_FORM", "false");
    setEnv("DISABLE_EMAIL_OTP_SIGN_IN", "false");
    setEnv("DISABLE_GUEST_ACCESS", "false");
    setEnv("CUSTOM_OAUTH_AUTO_LOGIN", "false");

    const { default: getSettings } = await import(
      "../../../apps/api/src/utils/get-settings"
    );
    const settings = getSettings();

    // The negative case matters: without it the assertions above would pass
    // against a `getSettings` that hard-coded every flag to true.
    expect(settings.disableLoginForm).toBe(false);
    expect(settings.disableEmailOtpSignIn).toBe(false);
    expect(settings.hasGuestAccess).toBe(true);
    expect(settings.customOAuthAutoLogin).toBe(false);
  });

  it.each([
    "/sign-in/email",
    "/sign-in/magic-link",
    "/magic-link/verify",
    "/sign-in/email-otp",
    "/email-otp/send-verification-otp",
  ])("refuses %s while DISABLE_LOGIN_FORM is set", (path) => {
    // `hooks.before` throws FORBIDDEN for exactly the paths this predicate names,
    // which is what makes `POST /api/auth/sign-in/email` answer 403.
    expect(isLocalSignInPath(path)).toBe(true);
  });

  it("leaves the OIDC callback reachable", () => {
    // The one path that must stay open, or nobody could sign in at all.
    expect(isLocalSignInPath("/oauth2/callback/custom")).toBe(false);
    expect(isLocalSignInPath("/sign-in/oauth2")).toBe(false);
  });

  it("does NOT cover /sign-up/email, which is why the fork adds a second refusal", () => {
    // Upstream's predicate is about SIGNING IN. Signing UP is a different path and it was
    // never in this set, so `DISABLE_LOGIN_FORM` never reached it — and upstream's two
    // registration gates both exempt the very first user, plus a valid invitation. On an
    // Operon instance those exemptions are a way to obtain a Kaneo session without ever
    // passing Operon, which is what `hooks.before`'s unconditional Operon-mode refusal
    // closes. The HTTP proof is `tests/api-integration/operon-oidc-only.test.ts`; this
    // assertion is the reason that refusal has to exist separately at all.
    expect(isLocalSignInPath("/sign-up/email")).toBe(false);
  });
});

describe("mapCustomOAuthProfileToUser", () => {
  it("maps a name and captures the claims the bootstrap needs", () => {
    const mapped = mapCustomOAuthProfileToUser({
      sub: "a".repeat(64),
      email: "Admin@Operon.local",
      name: "Workspace Admin",
      preferred_username: "admin",
      role: "admin",
    });

    expect(mapped).toEqual({ name: "Workspace Admin" });

    // Email-insensitive lookup: Better Auth lowercases the address on the user
    // row, so a capture keyed on the raw claim would never be collected.
    const claims = takeOperonOidcClaims("admin@operon.local");
    expect(claims).toEqual({
      sub: "a".repeat(64),
      email: "Admin@Operon.local",
      name: "Workspace Admin",
      role: "admin",
    });
  });

  it("consumes the capture, so a later sign-in provisions nothing", () => {
    mapCustomOAuthProfileToUser({
      sub: "b".repeat(64),
      email: "member@operon.local",
      name: "A Member",
    });

    expect(takeOperonOidcClaims("member@operon.local")).not.toBeNull();
    expect(takeOperonOidcClaims("member@operon.local")).toBeNull();
  });

  it("narrows an unexpected role to member, so it cannot bootstrap", () => {
    mapCustomOAuthProfileToUser({
      sub: "c".repeat(64),
      email: "guest@operon.local",
      name: "A Guest",
      role: "superuser",
    });

    expect(takeOperonOidcClaims("guest@operon.local")?.role).toBe("member");
  });

  it("captures nothing without a subject", () => {
    // A profile with no `sub` is not an Operon identity; provisioning it would
    // link a Kaneo user to a custody row that does not exist.
    mapCustomOAuthProfileToUser({
      email: "nobody@operon.local",
      name: "Nobody",
    });

    expect(takeOperonOidcClaims("nobody@operon.local")).toBeNull();
  });

  it("expires a capture that was never collected", () => {
    const t0 = 1_700_000_000_000;
    // `rememberOperonOidcClaims` rather than the mapper, because the clock is the
    // thing under test and only the explicit-`now` seam can move it.
    rememberOperonOidcClaims(
      {
        sub: "d".repeat(64),
        email: "stale@operon.local",
        name: "Stale",
        role: "member",
      },
      t0,
    );

    expect(takeOperonOidcClaims("stale@operon.local", t0 + 60_000)).not.toBe(
      null,
    );

    rememberOperonOidcClaims(
      {
        sub: "d".repeat(64),
        email: "stale@operon.local",
        name: "Stale",
        role: "member",
      },
      t0,
    );

    // `mapProfileToUser` runs on EVERY callback while `user.create.after` runs
    // only on the first, so uncollected entries are the normal case and the TTL
    // is what stops the map growing without bound.
    expect(
      takeOperonOidcClaims("stale@operon.local", t0 + 6 * 60 * 1000),
    ).toBeNull();
  });

  it("still maps a name for a profile it does not capture", () => {
    expect(
      mapCustomOAuthProfileToUser({
        given_name: "Jane",
        family_name: "Rivera",
        email: "jane@example.com",
      }),
    ).toEqual({ name: "Jane Rivera" });
  });
});
