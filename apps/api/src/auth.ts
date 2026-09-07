import { createHmac } from "node:crypto";
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

/** The `genericOAuth` provider id Operon is registered under (`:519` below). */
const OPERON_OIDC_PROVIDER_ID = "custom";

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
 * Create the single workspace, or recover the one a concurrent first login just
 * created.
 *
 * NO advisory lock, unlike the first-user-admin promotion above, and that is a
 * decision rather than an oversight: `auth.api.createOrganization` uses its own
 * connection out of the pool, so a `pg_advisory_xact_lock` taken here would not
 * cover it. `workspace.slug` carries a UNIQUE index, which already makes the race
 * a losable one — the loser gets a constraint violation and reads back the winner's
 * row, which is the same outcome a lock would have produced.
 *
 * `createOrganization` rather than a direct insert, because the upstream endpoint
 * also seeds the editable default roles, creates the default team and makes the
 * caller the workspace OWNER. A hand-rolled insert would silently skip all three.
 * It is called with NO `headers`: the endpoint treats "no session but a `userId`"
 * as a system action (`better-auth/dist/plugins/organization/routes/crud-org.mjs`),
 * and passing headers would make it demand a session it can never have here.
 */
async function createOperonWorkspace(userId: string): Promise<string | null> {
  try {
    const organization = await auth.api.createOrganization({
      body: {
        name: OPERON_WORKSPACE_NAME,
        slug: OPERON_WORKSPACE_SLUG,
        userId,
      },
    });
    return organization?.id ?? null;
  } catch (error) {
    const recovered = await findOperonWorkspaceId();
    if (recovered) {
      console.warn(
        "[operon] workspace already created by a concurrent login; joining it",
      );
      return recovered;
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
 * Mint the least-privilege key platform-service calls Kaneo with (decision 48).
 *
 * `{ workspace: ["manage_settings"] }` and nothing more: `hasWorkspacePermission`
 * treats an API key's `permissions` as a CEILING over the holder's workspace role
 * (`utils/require-workspace-permission.ts`), so this key can reach the integration
 * and webhook provisioning routes and is refused everywhere else — even though its
 * holder is the workspace owner.
 *
 * No `metadata`: the plugin defaults `enableMetadata` to false and rejects the
 * field outright, and no `request` is passed, which is what lets a server-side
 * caller name a `userId` at all.
 */
async function mintOperonApiKey(userId: string): Promise<string | null> {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: "operon-platform-service",
      permissions: { workspace: ["manage_settings"] },
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
 * `OPERON_INTERNAL_API_URL` is an IN-NETWORK address (`http://platform-service:3001`),
 * never the public one: this call carries no user session and must not leave the
 * compose network.
 *
 * Failure is logged, never thrown. The user row is already committed by the time
 * this runs, so throwing would fail a sign-in for an account that now exists and
 * whose `user.create.after` hook will never fire again — a strictly worse outcome
 * than a missing `kaneo_user_id`, which is a record rather than a permission.
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

  const body = JSON.stringify(payload);
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
 * The whole of the Operon side of a first Initiative sign-in.
 *
 * A no-op for every user who did not arrive through Operon's OIDC flow, because
 * `takeOperonOidcClaims` only has an entry for one that did.
 */
async function provisionOperonUser(user: {
  id: string;
  email: string;
  name?: string | null;
}) {
  const claims = takeOperonOidcClaims(user.email);
  if (!claims) return;

  let workspaceId = await findOperonWorkspaceId();
  let apiKey: string | undefined;

  if (workspaceId) {
    await joinOperonWorkspace(workspaceId, user.id);
  } else if (claims.role === "admin") {
    // Decision 49: the FIRST ADMIN's login bootstraps the workspace, and the key
    // platform-service will call back with is minted in the same breath.
    workspaceId = await createOperonWorkspace(user.id);
    if (workspaceId) {
      apiKey = (await mintOperonApiKey(user.id)) ?? undefined;
    }
  } else {
    // A member reached Initiative before any admin did. Refusing the sign-in would
    // be worse than landing them in an empty shell: Operon already authenticated
    // them, and the first admin's login will not retroactively join them, so this
    // is loud on purpose.
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

          // Operon: bootstrap or join the single workspace, then report the new
          // Kaneo user back to Operon (decisions 48, 49). A no-op for any user who
          // did not arrive through Operon's OIDC flow.
          //
          // CAUGHT, not thrown. The user row is committed by the time this runs,
          // and this hook never fires again for that user, so a throw would turn a
          // recoverable provisioning failure into an account that exists but can
          // never sign in.
          try {
            await provisionOperonUser(user);
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
