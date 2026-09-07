import { createHmac, randomUUID } from "node:crypto";
import { apiKey } from "@better-auth/api-key";
import {
  sendMagicLinkEmail,
  sendOtpEmail,
  sendWorkspaceInvitationEmail,
} from "@kaneo/email";
import {
  ac,
  DEFAULT_ROLE_NAMES,
  defaultRolePayloads,
  owner,
} from "@kaneo/permissions";
import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import {
  admin as adminPlugin,
  anonymous,
  bearer,
  deviceAuthorization,
  emailOTP,
  genericOAuth,
  lastLoginMethod,
  magicLink,
  openAPI,
  organization,
} from "better-auth/plugins";
import type { AccessControl } from "better-auth/plugins/access";
import type { UserWithAnonymous } from "better-auth/plugins/anonymous";
import { config } from "dotenv-mono";
import { and, count, eq, sql } from "drizzle-orm";
import {
  findBillableWorkspaces,
  formatBillableWorkspacesMessage,
} from "./billing/controllers/find-billable-workspaces";
import { syncWorkspaceSeats } from "./billing/controllers/sync-seats";
import db, { schema } from "./database";
import { publishEvent } from "./events";
import deleteAccountData from "./user/controllers/delete-account-data";
import { checkRegistrationAllowed } from "./utils/check-registration-allowed";
import { checkWorkspaceName } from "./utils/check-workspace-name";
import {
  hasOperonOidcClaims,
  mapCustomOAuthProfileToUser,
  takeOperonOidcClaims,
} from "./utils/custom-oauth-profile";
import { generateDemoName } from "./utils/generate-demo-name";
import { getDefaultCookieAttributes } from "./utils/get-default-cookie-attributes";
import { getInvitationEmailSubject } from "./utils/get-invitation-email-subject";
import { getWorkspaceInvitationEmailCopy } from "./utils/get-workspace-invitation-email-copy";
import { getGithubSsoOAuthCredentials } from "./utils/github-sso-env";
import { isCloud } from "./utils/is-cloud";
import { isDisposableEmail } from "./utils/is-disposable-email";
import { isLocalSignInPath } from "./utils/is-local-sign-in-path";
import { verifyTurnstile } from "./utils/verify-turnstile";

config();

const githubSso = getGithubSsoOAuthCredentials();

const isRegistrationDisabled = process.env.DISABLE_REGISTRATION === "true";
const isPasswordRegistrationDisabled =
  process.env.DISABLE_PASSWORD_REGISTRATION === "true";
const isLoginFormDisabled = process.env.DISABLE_LOGIN_FORM === "true";
/**
 * Operon mode (Operon spec decisions 39, 40, 42, 49).
 *
 * "This instance's only way in is Operon's OIDC flow." `OPERON_OIDC_ONLY` is the
 * explicit switch; `DISABLE_LOGIN_FORM` is honoured too because the compose file
 * that ships Initiative has set it since A5 and an upgrade must not silently
 * un-harden. Read once at module scope, like every other switch in this block.
 *
 * Three fork behaviours hang off it, and all three are refusals rather than
 * additions:
 *
 *   1. `POST /sign-up/email` is refused UNCONDITIONALLY — no first-user bootstrap
 *      exemption, no invitation exemption. Upstream's two gates both let the very
 *      first signup through so a fresh instance can be set up; in Operon mode that
 *      exemption is the hole, because it hands an unauthenticated caller a Kaneo
 *      session AND (before this change) instance-admin.
 *   2. Better Auth's own `/api-key/*` management endpoints are refused for HTTP
 *      callers. The workspace bootstrap mints its key SERVER-side, which does not
 *      go through this gate, so the only thing lost is a user's ability to mint a
 *      key through the browser — which is exactly the credential the re-key route
 *      and `hasWorkspacePermission`'s key ceiling would otherwise have to defend
 *      against.
 *   3. Instance-admin is derived from Operon's verified `role` claim, never from
 *      "you were the first row in the table".
 */
const isOperonOidcOnly =
  process.env.OPERON_OIDC_ONLY === "true" || isLoginFormDisabled;
const isEmailOtpSignInDisabled =
  process.env.DISABLE_EMAIL_OTP_SIGN_IN === "true";
const isWorkspaceCreationDisabled =
  process.env.DISABLE_WORKSPACE_CREATION === "true";

function normalizeInvitationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!/^[a-z0-9_-]{1,128}$/i.test(normalized)) return undefined;
  return normalized;
}

function isOAuthCallbackPath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  return path.startsWith("/callback/") || path.startsWith("/oauth2/callback/");
}

const apiUrl = process.env.KANEO_API_URL || "http://localhost:1337";
const clientUrl = process.env.KANEO_CLIENT_URL || "http://localhost:5173";

const trustedOrigins = [clientUrl];
try {
  const apiOrigin = new URL(apiUrl);
  const apiOriginString = `${apiOrigin.protocol}//${apiOrigin.host}`;
  if (!trustedOrigins.includes(apiOriginString)) {
    trustedOrigins.push(apiOriginString);
  }
} catch {}

const baseURLWithoutPath = (() => {
  try {
    const url = new URL(apiUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return apiUrl.split("/").slice(0, 3).join("/"); // Get protocol://host
  }
})();

if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length < 32) {
  console.error(
    "AUTH_SECRET is less than 32 characters, please generate a new one.",
  );
  process.exit(1);
}

async function getUserLocale(email: string) {
  const [user] = await db
    .select({ locale: schema.userTable.locale })
    .from(schema.userTable)
    .where(eq(schema.userTable.email, email))
    .limit(1);

  return user?.locale ?? null;
}

function getLocaleKey(locale?: string | null) {
  const normalized = locale?.toLowerCase();
  if (normalized?.startsWith("de")) return "de";
  if (normalized?.startsWith("vi")) return "vi";
  if (normalized?.startsWith("ja")) return "ja";
  return "en";
}

function getAuthEmailCopy(locale?: string | null) {
  const localeKey = getLocaleKey(locale);

  if (localeKey === "de") {
    return {
      magicLinkSubject: "Anmeldelink fuer Kaneo",
      otpSubject: "Bestaetigungscode fuer Kaneo",
    };
  }

  if (localeKey === "vi") {
    return {
      magicLinkSubject: "Liên kết đăng nhập Kaneo",
      otpSubject: "Mã xác minh Kaneo",
    };
  }

  if (localeKey === "ja") {
    return {
      magicLinkSubject: "Kaneo ログインリンク",
      otpSubject: "Kaneo 認証コード",
    };
  }

  return {
    magicLinkSubject: "Login for Kaneo",
    otpSubject: "Authentication code for Kaneo",
  };
}

function getDeviceAuthClientIds(): Set<string> {
  const raw = process.env.DEVICE_AUTH_CLIENT_IDS?.trim();
  if (raw) {
    return new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return new Set(["kaneo-cli", "kaneo-mcp"]);
}

const DEFAULT_TRUSTED_PROXIES = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

function trustedProxies(): string[] {
  const raw = process.env.TRUSTED_PROXIES?.trim();
  if (!raw) {
    return DEFAULT_TRUSTED_PROXIES;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getDeviceAuthVerificationUri(): string {
  const base = clientUrl.replace(/\/$/, "");
  return `${base}/device`;
}

// ─── Operon: one workspace, bootstrapped by the first admin's login ───────────
//
// Operon owns identity for this instance (Operon spec decisions 39, 40, 49). This
// block is the whole of the fork's side of that, and it exists because the pin has
// NO auto-join and NO auto-create path: membership is invitation-only and
// `hooks.after` below merely activates a membership that already exists. Without
// it the very first person to sign in through Operon lands in Initiative with
// nowhere to be.
//
// It runs from `databaseHooks.user.create.after`, so it runs exactly once per
// person — on the login that creates their Kaneo user, and never again.

/** The single workspace's name and slug. Initiative has exactly one (decision 49). */
const OPERON_WORKSPACE_NAME = "Operon";
const OPERON_WORKSPACE_SLUG = "operon";

/** Same 10s budget upstream gives its own outbound webhook. */
const OPERON_S2S_TIMEOUT_MS = 10_000;

/** The id of the single workspace, or null when none exists yet. */
async function findOperonWorkspaceId(): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.workspaceTable.id })
    .from(schema.workspaceTable)
    .orderBy(schema.workspaceTable.createdAt)
    .limit(1);
  return row?.id ?? null;
}

/**
 * The workspace THIS fork created, addressed by the slug that is the bootstrap
 * claim. Used only to recover after a losing `createOrganization`, where "the
 * earliest workspace" would be the wrong question to ask.
 */
async function findOperonWorkspaceIdBySlug(): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.workspaceTable.id })
    .from(schema.workspaceTable)
    .where(eq(schema.workspaceTable.slug, OPERON_WORKSPACE_SLUG))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Create the single workspace, or recover the one a concurrent first login just
 * created — and SAY WHICH HAPPENED.
 *
 * `created` is the whole point of the return shape, and it is the fix for the
 * concurrent bootstrap. `workspace.slug` carries a UNIQUE index, so exactly one of
 * two concurrent first-admin logins can insert `slug = "operon"`; the other gets a
 * constraint violation. That violation IS the serialization — a unique-insert claim,
 * cheaper and safer here than an advisory lock, which would have to be held across
 * `auth.api.createOrganization`'s own pool connection and could exhaust the pool
 * under exactly the concurrency it exists to survive.
 *
 * The previous revision recovered the id and returned it indistinguishably from a
 * fresh create, so BOTH callers went on to mint a key and deliver it, and the loser
 * — who at that point was not even a member — could overwrite Operon's working
 * credential with one minted under a user who could not use it. Only the caller that
 * actually won the claim mints and delivers; the loser joins and delivers no key.
 *
 * `createOrganization` rather than a direct insert, because the upstream endpoint
 * also seeds the editable default roles, creates the default team and makes the
 * caller the workspace OWNER. A hand-rolled insert would silently skip all three.
 * It is called with NO `headers`: the endpoint treats "no session but a `userId`"
 * as a system action (`better-auth/dist/plugins/organization/routes/crud-org.mjs`),
 * and passing headers would make it demand a session it can never have here.
 */
async function createOperonWorkspace(
  userId: string,
): Promise<{ id: string | null; created: boolean }> {
  try {
    const organization = await auth.api.createOrganization({
      body: {
        name: OPERON_WORKSPACE_NAME,
        slug: OPERON_WORKSPACE_SLUG,
        userId,
      },
    });
    if (organization?.id) {
      return { id: organization.id, created: true };
    }
    return { id: await findOperonWorkspaceIdBySlug(), created: false };
  } catch (error) {
    const recovered =
      (await findOperonWorkspaceIdBySlug()) ?? (await findOperonWorkspaceId());
    if (recovered) {
      console.warn(
        "[operon] workspace already created by a concurrent login; joining it",
      );
      return { id: recovered, created: false };
    }
    throw error;
  }
}

/** Add a later user to the single workspace. Idempotent. */
async function joinOperonWorkspace(workspaceId: string, userId: string) {
  const [existing] = await db
    .select({ id: schema.workspaceUserTable.id })
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    )
    .limit(1);
  if (existing) return;

  await auth.api.addMember({
    body: {
      userId,
      organizationId: workspaceId,
      // `roles: { owner }` above keeps only `owner` STATIC, so better-auth infers
      // the role union as `"owner"` alone. `member` is real — it is one of
      // `DEFAULT_ROLE_NAMES`, seeded into `workspace_role` by
      // `afterCreateOrganization` and resolved through dynamic access control —
      // it simply is not in the static type. Same cast, and same reason, as the
      // `ac as unknown as AccessControl` widening above.
      role: "member" as unknown as "owner",
    },
  });
}

/**
 * The marker that says "this key is platform-service's, minted by the bootstrap".
 *
 * It is API-key METADATA, and metadata is the right place precisely because a
 * caller cannot write it: `enableMetadata` is on so the bootstrap can set it, and
 * `hooks.before` below refuses `metadata` on any `/api-key/create` or
 * `/api-key/update` that arrives as an HTTP request. The bootstrap's own call goes
 * through `auth.api.createApiKey` with no request and no headers, so it is the only
 * writer. `permissions` alone would NOT have been enough — the create endpoint
 * accepts `permissions` from a client request, so any member could have minted
 * themselves a key claiming `operon: ["rekey"]`.
 */
export const OPERON_SERVICE_KEY_METADATA = { operonService: true } as const;

/**
 * The permission ceiling the re-key and Telegraph routes are read through.
 *
 * `hasWorkspacePermission` treats an API key's `permissions` as a CEILING over the
 * holder's workspace role (`utils/require-workspace-permission.ts`), so this key can
 * reach exactly three things and is refused everywhere else even though its holder
 * is the workspace owner:
 *
 *   * `workspace: ["manage_settings"]` — integration and webhook provisioning.
 *   * `task: ["update"]` — the Telegraph external-link write route, which now
 *     demands the same permission upstream's own task-update routes demand.
 *   * `operon: ["rekey"]` — a scope no upstream role grants and no upstream route
 *     reads, checked by `PATCH /api/internal/operon/account-id` alongside the
 *     metadata marker above.
 */
export const OPERON_SERVICE_KEY_PERMISSIONS: Record<string, string[]> = {
  workspace: ["manage_settings"],
  task: ["update"],
  operon: ["rekey"],
};

/**
 * Mint the least-privilege key platform-service calls Kaneo with (decision 48).
 *
 * No `request` is passed, which is what lets a server-side caller name a `userId`
 * at all — and, since this fork's `hooks.before` refuses client-supplied metadata,
 * is also what makes {@link OPERON_SERVICE_KEY_METADATA} unforgeable.
 */
async function mintOperonApiKey(userId: string): Promise<string | null> {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: "operon-platform-service",
      permissions: { ...OPERON_SERVICE_KEY_PERMISSIONS },
      metadata: { ...OPERON_SERVICE_KEY_METADATA },
    },
  });
  return created?.key ?? null;
}

/**
 * POST the new Kaneo user back to Operon, HMAC-signed (decision 48).
 *
 * The signature is over the EXACT bytes sent, in the same shape as Kaneo's own
 * outgoing `X-Kaneo-Signature` (`plugins/generic-webhook/client.ts:23-27`), because
 * Operon verifies it against `req.rawBody` — a re-serialised body verifies against
 * a different string and is refused, which is the property that makes the header
 * mean anything.
 *
 * ── FRESHNESS AND A DELIVERY ID ARE IN THE SIGNED BODY ───────────────────────────
 *
 * A signature over a body that says nothing about WHEN is a signature over a message
 * that stays valid forever. Anyone who ever observed one bootstrap delivery could
 * replay it and reinstall a revoked API key over a live one. `deliveryId` and
 * `timestamp` are therefore FIELDS OF THE PAYLOAD — not headers — so the existing
 * raw-body HMAC covers them with no second signing scheme: the receiver rejects a
 * skew beyond five minutes and any delivery id it has already recorded, and refuses
 * to let an older delivery replace a newer key.
 *
 * `OPERON_INTERNAL_API_URL` is an IN-NETWORK address (`http://platform-service:3001`),
 * never the public one: this call carries no user session and must not leave the
 * compose network.
 *
 * Failure is logged, never thrown. The user row is already committed by the time
 * this runs; since this hook now runs on EVERY subsequent Operon login, a transient
 * failure is retried by the next sign-in rather than being permanent.
 */
async function postOperonKaneoUser(payload: {
  sub: string;
  kaneoUserId: string;
  email: string;
  name: string;
  workspaceId: string | null;
  apiKey?: string;
}) {
  const base = (process.env.OPERON_INTERNAL_API_URL || "").replace(/\/+$/, "");
  const secret = process.env.OPERON_KANEO_S2S_SECRET || "";
  if (!base || !secret) {
    console.warn(
      "[operon] OPERON_INTERNAL_API_URL or OPERON_KANEO_S2S_SECRET is unset; kaneo_user_id was not reported",
    );
    return;
  }

  const body = JSON.stringify({
    ...payload,
    deliveryId: randomUUID(),
    timestamp: new Date().toISOString(),
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPERON_S2S_TIMEOUT_MS);

  try {
    const response = await fetch(`${base}/internal/kaneo/user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Operon-Signature": createHmac("sha256", secret)
          .update(body)
          .digest("hex"),
      },
      body,
      signal: controller.signal,
      // A redirect would replay a signed body at an address nobody vouched for.
      redirect: "manual",
    });
    if (!response.ok) {
      console.error(
        `[operon] internal/kaneo/user rejected the callback (${response.status})`,
      );
      return;
    }
    // The key itself is never logged (Operon AGENTS.md rule 23).
    console.log(
      `[operon] reported kaneo user for workspace ${payload.workspaceId ?? "none"}`,
    );
  } catch (error) {
    console.error("[operon] internal/kaneo/user callback failed", error);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Instance-admin follows Operon's verified `role` claim, and nothing else
 * (decision 49).
 *
 * Upstream promotes whoever happens to be the first row in `user` to instance
 * admin, which on this instance means "whoever visited Initiative first" — an
 * Operon MEMBER, arriving before any admin, was collecting Kaneo's global
 * authorization bypass (`utils/is-instance-admin.ts`, read by
 * `hasWorkspacePermission` before any workspace role is consulted). In Operon mode
 * the count-based promotion is switched off entirely (see
 * `databaseHooks.user.create.after`) and this is the only writer of `user.role`.
 *
 * It runs on every Operon login, so a role change in Operon lands on the next
 * sign-in in BOTH directions: promotion and demotion. Operon is the authority for
 * this claim; a Kaneo row that disagreed with it would be a second, stale one.
 */
async function syncOperonInstanceRole(
  userId: string,
  role: "admin" | "member",
) {
  const desired = role === "admin" ? "admin" : "user";
  const [current] = await db
    .select({ role: schema.userTable.role })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);

  if (current?.role === desired) return;

  await db
    .update(schema.userTable)
    .set({ role: desired })
    .where(eq(schema.userTable.id, userId));

  console.log(
    `[operon] instance role for kaneo user ${userId} set from the oidc claim: ${desired}`,
  );
}

/**
 * The whole of the Operon side of an Initiative sign-in.
 *
 * ── IT RUNS ON EVERY LOGIN, NOT ONLY THE FIRST ───────────────────────────────────
 *
 * It used to hang off `databaseHooks.user.create.after`, which fires exactly once
 * per person. A failed membership insert, a failed key mint or a failed callback was
 * therefore PERMANENT — the hook never fired again — and a member who arrived before
 * any admin stayed unjoined forever. It now runs from
 * `databaseHooks.session.create.after`, so every Operon sign-in reconciles: sync the
 * instance role, join if not joined, re-report the Kaneo user id. Every step is
 * idempotent, which is what makes running it on every login cheap rather than
 * dangerous.
 *
 * A no-op for every user who did not arrive through Operon's OIDC flow, because
 * `takeOperonOidcClaims` only has an entry for one that did — and
 * `mapCustomOAuthProfileToUser` refills that entry on EVERY OIDC callback, which is
 * what makes the retry possible at all.
 */
async function provisionOperonUser(user: {
  id: string;
  email: string;
  name?: string | null;
}) {
  const claims = takeOperonOidcClaims(user.email);
  if (!claims) return;

  await syncOperonInstanceRole(user.id, claims.role);

  let workspaceId = await findOperonWorkspaceId();
  let apiKey: string | undefined;

  if (workspaceId) {
    await joinOperonWorkspace(workspaceId, user.id);
  } else if (claims.role === "admin") {
    // Decision 49: the FIRST ADMIN's login bootstraps the workspace, and the key
    // platform-service will call back with is minted in the same breath — but ONLY
    // by the caller that actually won the slug claim. A concurrent second admin
    // login recovers the same workspace, joins it, and delivers no key.
    const bootstrap = await createOperonWorkspace(user.id);
    workspaceId = bootstrap.id;
    if (workspaceId && bootstrap.created) {
      apiKey = (await mintOperonApiKey(user.id)) ?? undefined;
    } else if (workspaceId) {
      await joinOperonWorkspace(workspaceId, user.id);
    }
  } else {
    // A member reached Initiative before any admin did. Refusing the sign-in would
    // be worse than landing them in an empty shell: Operon already authenticated
    // them, and — unlike the previous revision — the first admin's login no longer
    // has to retroactively join them, because this member's NEXT login will.
    console.warn(
      "[operon] no workspace exists and this user is not an Operon admin; nothing was bootstrapped",
    );
  }

  await postOperonKaneoUser({
    sub: claims.sub,
    kaneoUserId: user.id,
    email: user.email,
    name: user.name || claims.name,
    workspaceId,
    ...(apiKey ? { apiKey } : {}),
  });
}

/**
 * Read the row `databaseHooks.session.create.after` only knows the id of, then
 * provision. Exported for the integration suite, which drives a login's
 * reconciliation directly rather than standing up an OIDC provider.
 */
export async function reconcileOperonSession(userId: string) {
  const [user] = await db
    .select({
      id: schema.userTable.id,
      email: schema.userTable.email,
      name: schema.userTable.name,
    })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);

  if (!user?.email) return;
  await provisionOperonUser(user);
}

export const auth = betterAuth({
  baseURL: baseURLWithoutPath,
  trustedOrigins,
  secret: process.env.AUTH_SECRET || "",
  basePath: "/api/auth",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      ...schema,
      user: schema.userTable,
      account: schema.accountTable,
      session: schema.sessionTable,
      verification: schema.verificationTable,
      workspace: schema.workspaceTable,
      workspace_member: schema.workspaceUserTable,
      invitation: schema.invitationTable,
      workspace_role: schema.workspaceRoleTable,
      team: schema.teamTable,
      teamMember: schema.teamMemberTable,
      apikey: schema.apikeyTable,
      deviceCode: schema.deviceCodeTable,
    },
  }),
  user: {
    additionalFields: {
      locale: {
        type: "string",
        input: true,
        required: false,
      },
    },
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        await deleteAccountData(user.id);
      },
    },
  },
  account: {
    accountLinking: {
      // Link an OAuth/OIDC sign-in to an existing account that shares the same
      // email instead of failing with error=account_not_linked. The listed
      // providers verify the email on their side, so they are trusted to link.
      enabled: true,
      trustedProviders: ["github", "google", "discord", "custom"],
      // Only link to an existing local account after its email has been
      // verified. Without this check, an attacker could pre-register a victim's
      // email with a password account and retain access after the victim signs
      // in through a trusted OAuth/OIDC provider.
      requireLocalEmailVerified: true,
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    password: {
      hash: async (password) => {
        return await bcrypt.hash(password, 10);
      },
      verify: async ({ hash, password }) => {
        return await bcrypt.compare(password, hash);
      },
    },
  },
  socialProviders: {
    github: {
      clientId: githubSso.clientId,
      clientSecret: githubSso.clientSecret,
      scope: ["user:email"],
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    },
    discord: {
      clientId: process.env.DISCORD_CLIENT_ID || "",
      clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
    },
  },
  plugins: [
    ...(process.env.DISABLE_GUEST_ACCESS !== "true"
      ? [
          anonymous({
            generateName: async () => generateDemoName(),
            emailDomainName: "kaneo.app",
          }),
        ]
      : []),
    lastLoginMethod(),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        try {
          const locale = await getUserLocale(email);
          const copy = getAuthEmailCopy(locale);
          await sendMagicLinkEmail(email, copy.magicLinkSubject, {
            magicLink: url,
            locale,
          });
        } catch (error) {
          console.error(error);
        }
      },
    }),
    ...(isEmailOtpSignInDisabled
      ? []
      : [
          emailOTP({
            async sendVerificationOTP({ email, otp, type }) {
              if (type === "sign-in") {
                const locale = await getUserLocale(email);
                const copy = getAuthEmailCopy(locale);
                await sendOtpEmail(email, copy.otpSubject, {
                  otp,
                  locale,
                });
              }
            },
          }),
        ]),
    organization({
      // `ac` is created with a narrow `statement` shape (project/task/label/
      // workspace + the default org statements), which makes its inferred
      // `newRole` generic incompatible with better-auth's looser
      // `AccessControl` type. Widen via an explicit cast so the plugin
      // accepts our custom statement.
      ac: ac as unknown as AccessControl,
      // Only `owner` stays static so its permissions can never be edited away
      // from the workspace creator. `viewer`, `member`, and `admin` are
      // seeded into `workspace_role` per workspace and resolved via
      // dynamic access control, so admins can fully override (replace) their
      // permissions per workspace. See `seedDefaultWorkspaceRoles` + the
      // afterCreateOrganization hook.
      roles: { owner },
      dynamicAccessControl: {
        enabled: true,
        maximumRolesPerOrganization: 25,
      },
      teams: {
        enabled: true,
        maximumTeams: 10,
        allowRemovingAllTeams: false,
      },
      schema: {
        organization: {
          modelName: "workspace",
          additionalFields: {
            // in metadata
            description: {
              type: "string",
              input: true,
              required: false,
            },
          },
        },
        member: {
          modelName: "workspace_member",
          fields: {
            organizationId: "workspaceId",
            createdAt: "joinedAt",
          },
        },
        invitation: {
          modelName: "invitation",
          fields: {
            organizationId: "workspaceId",
          },
        },
        organizationRole: {
          modelName: "workspace_role",
          fields: {
            organizationId: "workspaceId",
          },
        },
        team: {
          modelName: "team",
          fields: {
            organizationId: "workspaceId",
          },
        },
      },
      // When `DISABLE_WORKSPACE_CREATION` is set, only instance admins
      // (`user.role === "admin"`) may create workspaces — mirrors the
      // implicit-exemption shape of `DISABLE_REGISTRATION` above. This
      // check runs before any workspace membership exists, so only the
      // instance-wide role is meaningful here; per-workspace roles
      // (owner/admin/member/viewer) don't apply until after a workspace
      // is joined.
      //
      // `user` here comes from the session, which may be served out of
      // the cookie cache (see `session.cookieCache` below). The
      // first-user bootstrap promotes the user to admin in
      // `databaseHooks.user.create.after`, but that happens after
      // `signUpEmail` has already returned/cached the pre-promotion
      // role, so a cached session can still say `role: "user"` for up
      // to `cookieCache.maxAge`. Re-read the role from the database
      // instead of trusting the (possibly stale) cached role.
      allowUserToCreateOrganization: isWorkspaceCreationDisabled
        ? async (user) => {
            const [freshUser] = await db
              .select({ role: schema.userTable.role })
              .from(schema.userTable)
              .where(eq(schema.userTable.id, user.id));
            return freshUser?.role === "admin";
          }
        : true,
      // Better Auth defaults this to `true`, which blocks any user whose email
      // is not verified from accepting/rejecting an invitation. Kaneo does not
      // verify emails on signup (and guest/anonymous users are unverified by
      // design), so leaving the default on breaks invitation acceptance for
      // everyone. The invitation link id is the actual secret here, so gate on
      // that rather than on email verification.
      requireEmailVerificationOnInvitation: false,
      organizationHooks: {
        beforeCreateOrganization: async ({ organization }) => {
          const check = checkWorkspaceName(organization.name ?? "");
          if (!check.ok) {
            throw new APIError("BAD_REQUEST", { message: check.reason });
          }
        },
        afterCreateOrganization: async ({ organization, user }) => {
          // Seed the editable default roles for this workspace. Each
          // role's permissions are derived from the compiled-in defaults
          // in `@kaneo/permissions`; admins can later replace them in the
          // Roles UI. We skip names that somehow already exist (this hook
          // is best-effort idempotent; the boot-time backfill is the
          // belt-and-braces path).
          try {
            const existing = await db
              .select({ role: schema.workspaceRoleTable.role })
              .from(schema.workspaceRoleTable)
              .where(
                eq(schema.workspaceRoleTable.workspaceId, organization.id),
              );
            const taken = new Set(existing.map((r) => r.role));
            const now = new Date();
            const rows = DEFAULT_ROLE_NAMES.filter(
              (name) => !taken.has(name),
            ).map((name) => ({
              workspaceId: organization.id,
              role: name,
              permission: JSON.stringify(defaultRolePayloads[name]),
              createdAt: now,
              updatedAt: now,
            }));
            if (rows.length > 0) {
              await db.insert(schema.workspaceRoleTable).values(rows);
            }
          } catch (error) {
            console.error(
              "Failed to seed default workspace roles for workspace",
              organization.id,
              error,
            );
          }

          publishEvent("workspace.created", {
            workspaceId: organization.id,
            workspaceName: organization.name,
            ownerEmail: user.name,
            ownerId: user.id,
          });
        },
        beforeDeleteOrganization: async ({ organization }) => {
          const billable = await findBillableWorkspaces([organization.id]);
          if (billable.length > 0) {
            throw new APIError("CONFLICT", {
              message: formatBillableWorkspacesMessage(
                billable.map((workspace) => workspace.name),
              ),
            });
          }
        },
        afterAddMember: async ({ member }) => {
          if (member?.organizationId) {
            void syncWorkspaceSeats(member.organizationId).catch((error) => {
              console.error("Seat sync after member add failed:", error);
            });
          }
        },
        afterRemoveMember: async ({ member }) => {
          if (member?.organizationId) {
            void syncWorkspaceSeats(member.organizationId).catch((error) => {
              console.error("Seat sync after member remove failed:", error);
            });
          }
        },
      },
      async sendInvitationEmail(data) {
        const inviteLink = `${process.env.KANEO_CLIENT_URL}/invitation/accept/${data.id}`;
        const locale = await getUserLocale(data.email);
        const copy = getWorkspaceInvitationEmailCopy(locale);

        const result = await sendWorkspaceInvitationEmail(
          data.email,
          getInvitationEmailSubject(
            locale,
            data.inviter.user.name,
            data.organization.name,
          ),
          {
            inviterEmail: data.inviter.user.email,
            inviterName: data.inviter.user.name,
            workspaceName: data.organization.name,
            invitationLink: inviteLink,
            to: data.email,
            copy,
          },
        );

        if (
          result?.success === false &&
          result.reason === "SMTP_NOT_CONFIGURED"
        ) {
          console.warn(
            "Invitation created but email not sent due to SMTP not being configured",
          );
          return;
        }
      },
    }),
    genericOAuth({
      config: [
        {
          providerId: "custom",
          clientId: process.env.CUSTOM_OAUTH_CLIENT_ID || "",
          clientSecret: process.env.CUSTOM_OAUTH_CLIENT_SECRET,
          authorizationUrl: process.env.CUSTOM_OAUTH_AUTHORIZATION_URL || "",
          tokenUrl: process.env.CUSTOM_OAUTH_TOKEN_URL || "",
          userInfoUrl: process.env.CUSTOM_OAUTH_USER_INFO_URL || "",
          scopes: process.env.CUSTOM_OAUTH_SCOPES?.split(",")
            .map((s) => s.trim())
            .filter(Boolean) || ["profile", "email"],
          responseType: process.env.CUSTOM_OAUTH_RESPONSE_TYPE || "code",
          discoveryUrl: process.env.CUSTOM_OAUTH_DISCOVERY_URL || "",
          pkce: process.env.CUSTOM_AUTH_PKCE !== "false",
          mapProfileToUser: mapCustomOAuthProfileToUser,
        },
      ],
    }),
    bearer(),
    apiKey({
      enableSessionForAPIKeys: true,
      // The bootstrap marks its own key `{ operonService: true }`, which is what
      // `PATCH /api/internal/operon/account-id` recognises it by. Turning the field
      // on does NOT make it writable by a caller: `hooks.before` below refuses
      // `metadata` on any `/api-key/create` or `/api-key/update` that arrives as an
      // HTTP request, so the observable behaviour for every ordinary Kaneo caller is
      // the same refusal upstream's `enableMetadata: false` gave them, and the only
      // writer is `auth.api.createApiKey` called server-side with no request.
      enableMetadata: true,
      apiKeyHeaders: "x-api-key",
      rateLimit: {
        enabled: true,
        maxRequests: 100,
        timeWindow: 60 * 1000,
      },
    }),
    deviceAuthorization({
      verificationUri: getDeviceAuthVerificationUri(),
      validateClient: async (clientId) =>
        getDeviceAuthClientIds().has(clientId),
    }),
    adminPlugin({
      defaultRole: "user",
      adminRoles: ["admin"],
    }),
    openAPI(),
  ],
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  rateLimit: {
    // Enable in cloud; self-hosted instances opt in by setting KANEO_CLOUD.
    // Default better-auth rate-limit only kicks in for production; we keep the
    // global limits conservative and tighten signup/invite via customRules.
    enabled: isCloud(),
    window: 10,
    max: 100,
    customRules: {
      "/sign-up/email": { window: 60, max: 3 },
      "/organization/invite-member": { window: 60, max: 5 },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, ctx) => {
          // The anonymous() plugin creates ephemeral users for guest
          // access; registration limits don't apply to them (guest
          // availability is governed by DISABLE_GUEST_ACCESS instead).
          // `isAnonymous` is `input: false` in the plugin schema, so a
          // regular signup request cannot spoof it.
          const userWithAnonymous = user as Partial<UserWithAnonymous>;
          if (userWithAnonymous.isAnonymous) {
            return;
          }

          // Allow the very first signup through even when registration
          // is disabled: that's the instance-admin bootstrap flow.
          // Otherwise a fresh instance with DISABLE_REGISTRATION=true
          // could never be set up because `checkRegistrationAllowed`
          // would reject the first user (qodo bot #3).
          const [userCountRow] = await db
            .select({ value: count() })
            .from(schema.userTable);
          const existingUserCount = userCountRow?.value ?? 0;
          if (existingUserCount === 0) {
            return;
          }

          // Operon spec decisions 40 and 42. `DISABLE_REGISTRATION` here means
          // "no account is created OUTSIDE the OIDC flow" — it is set precisely so
          // that Operon is the only way in. Operon has already authenticated and
          // authorised this person against its own custody database, and the Kaneo
          // user is a downstream artefact of that profile, created on their first
          // Initiative visit. Requiring a Kaneo invitation on top would make the one
          // sanctioned path the one path that cannot work.
          //
          // The test is the captured profile, NOT `ctx.path`. An earlier revision
          // matched the callback path and was refused live: by the time this hook
          // runs, Better Auth's context carries an internal path spelling this fork
          // does not control. A live capture from `mapCustomOAuthProfileToUser` is
          // both stabler and stricter — it proves Operon's own userinfo document
          // produced this address moments ago.
          if (hasOperonOidcClaims(user.email)) {
            return;
          }

          const invitationId = normalizeInvitationId(
            ctx?.body?.invitationId ||
              ctx?.query?.invitationId ||
              ctx?.headers?.get("x-invitation-id"),
          );
          const result = await checkRegistrationAllowed(
            user.email,
            invitationId,
            { allowInvitationByEmail: isOAuthCallbackPath(ctx?.path) },
          );
          if (!result.allowed) {
            throw new APIError("FORBIDDEN", {
              message: result.reason,
            });
          }
        },
        after: async (user) => {
          // The anonymous() plugin creates ephemeral users for guest
          // access; never promote one to instance admin even if no
          // real admin exists yet. `isAnonymous` is contributed by the
          // anonymous plugin's `additionalFields` and isn't part of the
          // base User type, so we narrow through `UserWithAnonymous`.
          const userWithAnonymous = user as Partial<UserWithAnonymous>;
          if (userWithAnonymous.isAnonymous) {
            return;
          }

          // NOT IN OPERON MODE. Operon owns identity for this instance
          // (decision 39), so instance-admin follows Operon's verified `role`
          // claim and nothing else — see `syncOperonInstanceRole` above. Left on,
          // this promotes whoever visited Initiative first, which is an Operon
          // MEMBER whenever a member logs in before any admin does, and hands them
          // Kaneo's global authorization bypass.
          if (isOperonOidcOnly) {
            return;
          }

          // Promote the first user to instance admin atomically.
          //
          // A previous version of this code checked the user count in
          // the `before` hook and returned `role: "admin"`, but the
          // count and the eventual INSERT happened in separate
          // transactions, so two concurrent first-signups could both
          // see count=0 and both become admins (qodo bot #5).
          //
          // We now run the check + promote inside a single transaction
          // guarded by a Postgres advisory lock. Whichever transaction
          // wins the lock first promotes its user; any concurrent
          // transaction then sees totalUserCount > 1 and skips.
          //
          // Note: we count total users (not admins) so that upgrading
          // an existing instance (where every existing user has
          // role=NULL from the new column) doesn't promote the next
          // signup to admin (qodo bot #4).
          await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(2026)`);

            const totalRows = await tx
              .select({ value: count() })
              .from(schema.userTable);
            const totalUserCount = totalRows[0]?.value ?? 0;

            // This hook runs after the user row is inserted, so the
            // just-created user is included in the count. If they are
            // the only row in the table, this is a fresh-instance
            // bootstrap and they get promoted to admin.
            if (totalUserCount === 1) {
              await tx
                .update(schema.userTable)
                .set({ role: "admin" })
                .where(eq(schema.userTable.id, user.id));
            }
          });
        },
      },
    },
    session: {
      create: {
        // Operon: bootstrap or join the single workspace, sync the instance role
        // from the OIDC claim, and report the Kaneo user back to Operon
        // (decisions 48, 49). A no-op for any session that did not arrive through
        // Operon's OIDC flow.
        //
        // ON `session.create`, NOT `user.create`. The previous revision ran this
        // from `databaseHooks.user.create.after`, which fires exactly once per
        // person: a failed membership insert, key mint or callback was permanent,
        // and a member who signed in before any admin existed stayed unjoined
        // forever. A session is created on every sign-in, so hanging the work here
        // makes it a reconciliation that retries itself. Every step inside is
        // idempotent.
        //
        // CAUGHT, not thrown. The session row is committed by the time this runs,
        // so a throw would fail a sign-in for an account that is already signed in.
        after: async (session) => {
          try {
            await reconcileOperonSession(session.userId);
          } catch (error) {
            console.error("[operon] user provisioning failed", error);
          }
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (isLoginFormDisabled && isLocalSignInPath(ctx.path)) {
        throw new APIError("FORBIDDEN", {
          message:
            "Local sign-in is disabled. Please use a configured social or OIDC sign-in method.",
        });
      }

      // ── Operon mode: password signup does not exist ────────────────────────
      //
      // UNCONDITIONAL, and that word is the whole fix. Upstream has two signup
      // gates and BOTH exempt the very first user so a fresh instance can be set
      // up (`isInstanceAdminSetup` below, and the `existingUserCount === 0` early
      // return in `databaseHooks.user.create.before`); `DISABLE_REGISTRATION`
      // additionally lets anyone holding a valid Kaneo invitation through. On this
      // instance that is not a bootstrap convenience, it is a way to obtain a Kaneo
      // session — and, before the promotion change above, instance-admin with it —
      // without ever passing Operon. `isLocalSignInPath` does not cover
      // `/sign-up/email`, so the local-sign-in block above never reached it.
      //
      // The OIDC callback creates its users through `/callback/*`, never through
      // this path, so nothing legitimate is refused here.
      if (isOperonOidcOnly && ctx.path === "/sign-up/email") {
        throw new APIError("FORBIDDEN", {
          message:
            "Password sign-up is disabled on this instance. Sign in through Operon.",
        });
      }

      // ── The service key's ceiling has to be a ceiling ──────────────────────
      //
      // `enableSessionForAPIKeys: true` lets an API key authenticate Better Auth's
      // own endpoints, and the api-key plugin offers that switch per CONFIGURATION,
      // never per key (`@better-auth/api-key/dist/index.mjs:2352,2378`), so the
      // Operon service key inherits it. Left alone, the key could call
      // `/api/auth/api-key/create` and mint a CHILD key with `permissions: null` —
      // which `hasWorkspacePermission` reads as "no key ceiling at all", i.e. the
      // full rights of the workspace owner the key hangs off. That is an escape
      // from the very ceiling decision 48 relies on.
      //
      // The refusal is at request level because the plugin gives no per-key knob.
      // It is scoped to HTTP callers (`ctx.request`): the workspace bootstrap mints
      // through `auth.api.createApiKey` with no request, which is the same
      // discriminator the plugin itself uses to allow a server-side `userId`
      // (`isClientRequest = ctx.request || ctx.headers`). `/api-key/verify` stays
      // open — it is a read, and `authenticateApiRequest` is built on it.
      //
      // In Operon mode nobody mints keys over HTTP at all, which is the point: a
      // personal key minted in the browser is exactly the credential Codex used to
      // re-key another account, and Operon — not Kaneo — is where this instance's
      // credentials come from.
      if (
        isOperonOidcOnly &&
        ctx.request &&
        ctx.path.startsWith("/api-key/") &&
        ctx.path !== "/api-key/verify"
      ) {
        throw new APIError("FORBIDDEN", {
          message:
            "API key management is disabled on this instance. Operon issues the only key.",
        });
      }

      // `enableMetadata` is on so the bootstrap can mark its own key, and this is
      // what keeps that mark unforgeable everywhere, Operon mode or not: a client
      // request may not write `metadata`, so the only writer is a server-side
      // `auth.api.createApiKey`/`updateApiKey`. Upstream ran with
      // `enableMetadata: false`, under which the plugin answered any
      // metadata-bearing call with BAD_REQUEST, so an ordinary Kaneo caller sees
      // the same refusal it always saw.
      if (
        ctx.request &&
        (ctx.path === "/api-key/create" || ctx.path === "/api-key/update") &&
        ctx.body?.metadata !== undefined
      ) {
        throw new APIError("BAD_REQUEST", {
          message: "API key metadata is server-side only.",
        });
      }

      // Block invite-member calls on cloud from anonymous users or to
      // disposable-email addresses. The 2026-05-28 incident saw ~14k phishing
      // invites sent from throwaway disposable-email signups; gating here
      // shuts that path off without affecting self-hosted instances.
      if (ctx.path === "/organization/invite-member" && isCloud()) {
        // `before` hooks don't auto-populate ctx.context.session; load it
        // explicitly. `disableRefresh` keeps this gate cheap: we only need
        // the user record, not a session refresh side-effect.
        const session = await getSessionFromCtx(ctx, {
          disableRefresh: true,
        }).catch(() => null);
        const sessionUser = session?.user as
          | { isAnonymous?: boolean | null }
          | undefined;
        if (sessionUser?.isAnonymous) {
          throw new APIError("FORBIDDEN", {
            message: "Guest accounts may not send workspace invitations.",
          });
        }
        const inviteeEmail = (ctx.body?.email as string | undefined) ?? "";
        if (inviteeEmail && isDisposableEmail(inviteeEmail)) {
          throw new APIError("BAD_REQUEST", {
            message:
              "Invitations to disposable-email addresses are not allowed.",
          });
        }
      }

      const isSignUpPath =
        ctx.path === "/sign-up/email" ||
        ctx.path.startsWith("/callback/") ||
        ctx.path.startsWith("/sign-in/social");

      if (!isSignUpPath) {
        return;
      }

      const userCountRows = await db
        .select({ value: count() })
        .from(schema.userTable);
      const existingUserCount = userCountRows[0]?.value ?? 0;
      const isInstanceAdminSetup = existingUserCount === 0;

      if (ctx.path === "/sign-up/email") {
        if (isPasswordRegistrationDisabled && !isInstanceAdminSetup) {
          throw new APIError("FORBIDDEN", {
            message:
              "Password registration is currently disabled. Please use a configured social or OIDC sign-in method.",
          });
        }

        // Cloud-only abuse gates on password signup. Self-hosted instances
        // leave KANEO_CLOUD/TURNSTILE_SECRET_KEY unset and skip both.
        if (isCloud() && !isInstanceAdminSetup) {
          const signupEmail = (ctx.body?.email as string | undefined) ?? "";
          if (signupEmail && isDisposableEmail(signupEmail)) {
            throw new APIError("BAD_REQUEST", {
              message:
                "Sign-up with disposable email addresses is not allowed.",
            });
          }

          const turnstileToken =
            (ctx.body?.turnstileToken as string | undefined) ??
            ctx.headers?.get("x-turnstile-token") ??
            null;
          const remoteIp =
            ctx.headers?.get("cf-connecting-ip") ??
            ctx.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            null;
          const verdict = await verifyTurnstile(turnstileToken, remoteIp);
          if (!verdict.ok) {
            throw new APIError("FORBIDDEN", { message: verdict.reason });
          }
        }
      }

      if (!isRegistrationDisabled || isInstanceAdminSetup) {
        return;
      }

      const email =
        ctx.body?.email ||
        ctx.query?.email ||
        ctx.headers?.get("x-invitation-email");
      const invitationId = normalizeInvitationId(
        ctx.body?.invitationId ||
          ctx.query?.invitationId ||
          ctx.headers?.get("x-invitation-id"),
      );

      if (ctx.path === "/sign-up/email") {
        const result = await checkRegistrationAllowed(email, invitationId);
        if (!result.allowed) {
          throw new APIError("FORBIDDEN", {
            message: result.reason,
          });
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path.startsWith("/sign-up") || ctx.path.startsWith("/sign-in")) {
        const newSession = ctx.context.newSession;
        if (newSession) {
          const workspaceMember = await db
            .select({ workspaceId: schema.workspaceUserTable.workspaceId })
            .from(schema.workspaceUserTable)
            .where(eq(schema.workspaceUserTable.userId, newSession.user.id))
            .limit(1);

          const activeWorkspaceId = workspaceMember[0]?.workspaceId || null;

          if (activeWorkspaceId) {
            await db
              .update(schema.sessionTable)
              .set({ activeOrganizationId: activeWorkspaceId })
              .where(eq(schema.sessionTable.id, newSession.session.id));
          }
        }
      }
    }),
  },
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      trustedProxies: trustedProxies(),
    },
    defaultCookieAttributes: getDefaultCookieAttributes({
      apiUrl,
      clientUrl,
      cookieDomain: process.env.COOKIE_DOMAIN,
    }),
  },
});
