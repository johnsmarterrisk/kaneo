import { createHash, createHmac, randomUUID } from "node:crypto";
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
  operonMemberPayload,
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
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import {
  findBillableWorkspaces,
  formatBillableWorkspacesMessage,
} from "./billing/controllers/find-billable-workspaces";
import { syncWorkspaceSeats } from "./billing/controllers/sync-seats";
import db, { schema } from "./database";
import { publishEvent } from "./events";
import {
  beginOperonCredentialOp,
  endOperonCredentialOp,
  observeOperonMaintenance,
  operonMaintenanceDeferral,
  recordUnresolvedOperonDelivery,
} from "./operon-maintenance-state";
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
import { verifyApiKey } from "./utils/verify-api-key";
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

/**
 * {@link isOperonOidcOnly}, exported for `index.ts`'s `/api/auth/*` guard.
 *
 * The guard has to live in the Hono app rather than in Better Auth's own `hooks.before`
 * (see the comment on it), and this fork does not duplicate the switch to get it there.
 */
export const isOperonOidcOnlyInstance = isOperonOidcOnly;
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

/**
 * Upstream's `member` payload AS IT STOOD when the Operon upgrade was written —
 * a FROZEN literal, deliberately not `defaultRolePayloads.member`.
 *
 * It is the only payload {@link upgradeOperonMemberRolePayload} will overwrite, so
 * it is the line between "this row is still the default nobody has touched" and
 * "an admin edited this row and we must leave it alone". Deriving it from the live
 * export would move that line every time upstream changes the default, which would
 * re-target the upgrade at rows an operator may have deliberately set — see
 * decision 114 and the matching comment on `operonMemberPayload`.
 */
const PREVIOUS_DEFAULT_MEMBER_PAYLOAD: Record<string, string[]> = {
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ["read"],
  project: ["create", "read"],
  task: ["create", "read", "update"],
  label: ["create", "read", "update", "delete"],
  workspace: ["read"],
};

/**
 * Whether a stored `workspace_role.permission` string means the same thing as
 * `expected`.
 *
 * Compared as parsed JSON with each action list order-insensitive, NOT as bytes:
 * the rows are hand-editable in the Roles UI and one was hand-edited on the dev
 * instance, so a payload that differs only in key or action order is the same
 * grant and must not be mistaken for a customisation.
 */
function isSamePermissionPayload(
  stored: string,
  expected: Record<string, string[]>,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const actual = parsed as Record<string, unknown>;
  const expectedKeys = Object.keys(expected);
  if (Object.keys(actual).length !== expectedKeys.length) return false;

  for (const key of expectedKeys) {
    const value = actual[key];
    if (!Array.isArray(value)) return false;
    const want = [...(expected[key] ?? [])].sort();
    const have = [...value].map(String).sort();
    if (have.length !== want.length) return false;
    if (have.some((action, index) => action !== want[index])) return false;
  }
  return true;
}

export type OperonMemberRoleUpgrade =
  | "upgraded"
  | "already-upgraded"
  | "customised"
  | "missing"
  | "skipped";

/**
 * Give the Operon workspace's `member` role `task: delete` and `task: assign`
 * (R13/R14, decisions 114 and 124).
 *
 * TWO GATES, BOTH REQUIRED. `@kaneo/permissions` ships to every instance that
 * builds this fork and `seed-default-workspace-roles.ts` enumerates every
 * workspace with no filter, so an ungated version of this would grant the extra
 * permissions on an ordinary Kaneo instance and in every workspace on it. It
 * therefore runs only when this instance is in Operon mode AND only against the
 * workspace whose slug is Operon's; every other caller gets `"skipped"` and no
 * write at all.
 *
 * IT ONLY EVER OVERWRITES THE PREVIOUS DEFAULT. A row that already carries the
 * upgraded payload is `"already-upgraded"` (this is what makes the boot backfill
 * idempotent over an instance whose row was fixed by hand), and a row carrying
 * anything else is `"customised"` and is left exactly as the operator set it.
 *
 * It is exported because it has TWO callers, and needs both (decision 124):
 * `seedDefaultWorkspaceRoles` at boot, for a workspace that already exists, and
 * `afterCreateOrganization` for one that does not exist yet — without the second,
 * a fresh install's members cannot assign or delete until somebody restarts the
 * API.
 */
export async function upgradeOperonMemberRolePayload(
  workspaceId: string,
  workspaceSlug: string | null | undefined,
): Promise<OperonMemberRoleUpgrade> {
  if (!isOperonOidcOnly) return "skipped";
  if (workspaceSlug !== OPERON_WORKSPACE_SLUG) return "skipped";

  const [row] = await db
    .select({
      id: schema.workspaceRoleTable.id,
      permission: schema.workspaceRoleTable.permission,
    })
    .from(schema.workspaceRoleTable)
    .where(
      and(
        eq(schema.workspaceRoleTable.workspaceId, workspaceId),
        eq(schema.workspaceRoleTable.role, "member"),
      ),
    )
    .limit(1);

  if (!row) return "missing";
  if (isSamePermissionPayload(row.permission, operonMemberPayload)) {
    return "already-upgraded";
  }
  if (
    !isSamePermissionPayload(row.permission, PREVIOUS_DEFAULT_MEMBER_PAYLOAD)
  ) {
    return "customised";
  }

  await db
    .update(schema.workspaceRoleTable)
    .set({
      permission: JSON.stringify(operonMemberPayload),
      updatedAt: new Date(),
    })
    .where(eq(schema.workspaceRoleTable.id, row.id));

  console.log(
    `[operon] workspace ${workspaceId}: member role upgraded to the operon payload (task: delete, assign).`,
  );
  return "upgraded";
}

/** The provider id Better Auth stores an Operon OIDC subject under (decision 43). */
export const OPERON_PROVIDER_ID = "custom";

/** Postgres' unique-violation SQLSTATE. */
export const UNIQUE_VIOLATION = "23505";

/**
 * Three more reads, 500 ms apart — decision 122's frozen literals, exported because
 * BOTH conflict recoveries wait on the same seam.
 *
 * Better Auth's `createOAuthUser` commits the `user` and THEN the `account` as two
 * separate statements (the Drizzle adapter is built below with no `transaction` option
 * and `@better-auth/drizzle-adapter` defaults it to `false`). So the loser of a race
 * against an OIDC first login can find the email committed with the account row still
 * milliseconds away, and a terminal verdict there would call a succeeding sign-in an
 * identity mismatch. `operon-account/index.ts` waits this window out on the
 * provisioning route, and {@link recoverOperonOidcUser} waits it out on the OIDC path.
 */
export const OPERON_ACCOUNT_RECOVERY_ATTEMPTS = 3;
export const OPERON_ACCOUNT_RECOVERY_DELAY_MS = 500;

export type PostgresFailure = {
  code?: string;
  constraint?: string;
  detail?: string;
  cause?: unknown;
};

/**
 * The pg error under a drizzle one.
 *
 * `drizzle-orm@0.45` wraps every driver error in a `DrizzleQueryError` whose `cause` is
 * the `pg` error carrying `code` and `constraint`, and a transaction adds another layer;
 * Better Auth's adapter factory can add a third. Reading `error.code` directly finds
 * nothing, which would send a unique violation down the failure path instead of the
 * recovery.
 */
export function postgresFailure(error: unknown): PostgresFailure | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as PostgresFailure;
    if (typeof candidate.code === "string") return candidate;
    current = candidate.cause;
  }
  return null;
}

/** Was this a unique violation, and was it the index whose name matches `named`? */
function isUniqueViolationOn(error: unknown, named: RegExp): boolean {
  const failure = postgresFailure(error);
  if (failure?.code !== UNIQUE_VIOLATION) return false;
  return named.test(`${failure.constraint ?? ""} ${failure.detail ?? ""}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * Move ONE workspace membership to `role` — atomically, and never off `owner`.
 *
 * ── WHY THE OWNER RULE IS IN THE UPDATE'S PREDICATE (round-1 finding 3) ──────────────
 *
 * The previous shape was SELECT the row, decide from the role it carried, then UPDATE it
 * BY ITS ID. Those are two statements on two snapshots, so an ownership transfer landing
 * between them was silently overwritten: this call read `admin`, an operator (or Better
 * Auth's own `organization.updateMemberRole`) made that same row the `owner`, and the
 * UPDATE — which only ever said `WHERE id = …` — wrote `member` over `owner` and left the
 * workspace with nobody who owns it. Decision 115 says `owner` is a fixed point, and a
 * fixed point that is only checked in application memory is not one.
 *
 * So the protection is now IN the write. Both halves of it are:
 *
 *   * `role = <the role this call actually read>` — a compare-and-set. Anything that
 *     changed the row since the read makes this update match zero rows instead of
 *     clobbering the change.
 *   * `role <> 'owner'` — the rule itself, stated where the database can enforce it, so
 *     it holds even against a row whose role changed to `owner` and back.
 *
 * ZERO ROWS IS NOT A FAILURE, IT IS THE RE-READ SIGNAL. The loop re-reads and decides
 * again on the fresh row; the second pass sees the `owner` the transfer wrote and returns
 * without demoting it. Two passes are enough because the only outcomes are "still the role
 * we read" (impossible — the first update would have matched), "owner" (terminal) and
 * "already the role we want" (terminal); a third pass would only cover a caller racing
 * itself, which logs rather than loops forever.
 *
 * It is exported because it has three callers: {@link joinOperonWorkspace}'s reconcile,
 * that function's concurrent-writer recovery, and `POST /internal/operon/user`'s
 * `reconcileMembership` in `operon-account/index.ts`. All three had the same bug.
 */
export async function reconcileWorkspaceMemberRole(
  workspaceId: string,
  userId: string,
  role: "admin" | "member",
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [existing] = await db
      .select({
        id: schema.workspaceUserTable.id,
        role: schema.workspaceUserTable.role,
      })
      .from(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspaceId),
          eq(schema.workspaceUserTable.userId, userId),
        ),
      )
      .limit(1);

    // Nothing to reconcile. The caller is responsible for creating the membership;
    // inventing one here would join somebody a deletion just removed.
    if (!existing) return;

    if (existing.role === "owner") {
      console.warn(
        `[operon] workspace membership for kaneo user ${userId} is "owner" but the oidc claim says "${role}"; owner is never demoted by reconciliation`,
      );
      return;
    }

    if (existing.role === role) return;

    const updated = await db
      .update(schema.workspaceUserTable)
      .set({ role })
      .where(
        and(
          eq(schema.workspaceUserTable.id, existing.id),
          eq(schema.workspaceUserTable.role, existing.role),
          ne(schema.workspaceUserTable.role, "owner"),
        ),
      )
      .returning({ id: schema.workspaceUserTable.id });

    if (updated.length > 0) {
      console.log(
        `[operon] workspace role for kaneo user ${userId} set from the oidc claim: ${role} (was ${existing.role})`,
      );
      return;
    }
  }

  console.warn(
    `[operon] workspace role for kaneo user ${userId} was changed by a concurrent writer twice while reconciling to "${role}"; leaving it as it stands`,
  );
}

/**
 * Add a later user to the single workspace, at the role Operon says they hold —
 * and RECONCILE that role on every subsequent login. Idempotent.
 *
 * The workspace role follows `claims.role` in both directions, exactly as
 * `syncOperonInstanceRole` already makes the INSTANCE role follow it: an Operon
 * admin is a Kaneo workspace `admin`, an Operon member is a workspace `member`,
 * and a row that disagrees with the claim is corrected rather than left stale
 * (R15).
 *
 * WITH ONE FIXED POINT: `owner` is NEVER demoted (decision 115).
 * `createOperonWorkspace` goes through `auth.api.createOrganization` precisely
 * because that endpoint makes the caller the workspace OWNER, so the bootstrap
 * admin's row is `owner` — and no OIDC claim will ever say `owner`, because
 * Operon's `role` claim is two-valued. An unconditional reconcile would therefore
 * demote the bootstrap admin on their very next login and leave the workspace
 * with no owner, which Better Auth's own member-update path refuses anyway.
 * Moving ownership off a person is an explicit operator action, not a login side
 * effect, so the disagreement is LOGGED with both roles named and nothing is
 * changed.
 */
async function joinOperonWorkspace(
  workspaceId: string,
  userId: string,
  role: "admin" | "member",
) {
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

  // The role decision belongs to `reconcileWorkspaceMemberRole` and not to the row this
  // read returned: an ownership transfer between the read and the write is exactly what
  // round-1 finding 3 was about, so this read answers only "is there a membership at
  // all" and the reconcile re-reads the role inside its own compare-and-set.
  if (existing) {
    await reconcileWorkspaceMemberRole(workspaceId, userId, role);
    return;
  }

  try {
    await auth.api.addMember({
      body: {
        userId,
        organizationId: workspaceId,
        // `roles: { owner }` above keeps only `owner` STATIC, so better-auth infers
        // the role union as `"owner"` alone. `member` and `admin` are real — they
        // are `DEFAULT_ROLE_NAMES`, seeded into `workspace_role` by
        // `afterCreateOrganization` and resolved through dynamic access control —
        // they simply are not in the static type. Same cast, and same reason, as the
        // `ac as unknown as AccessControl` widening above.
        role: role as unknown as "owner",
      },
    });
  } catch (error) {
    // ── THE SELECT ABOVE AND THIS INSERT ARE NOT ONE STATEMENT (T11) ──────────────
    //
    // `workspace_member` has a SECOND writer now: `POST /internal/operon/user` puts a
    // provisioned person into the workspace before they have ever signed in. So a login
    // can read "no membership", the other writer can insert one, and `addMember` fails
    // the WHOLE sign-in over a row that says exactly what this call was about to write.
    // It can fail in either of two ways now, and both land here: its own re-check
    // (`User is already a member of this organization`), or — since migration 0047 —
    // the `workspace_member_workspace_user_unique` violation underneath it, which is the
    // one that fires when the two writers interleave too closely for any check to see.
    // Re-read: if the row is there, the other writer won a race whose outcome we wanted,
    // and all that is left is to reconcile its role under the same owner rule.
    const [raced] = await db
      .select({ id: schema.workspaceUserTable.id })
      .from(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspaceId),
          eq(schema.workspaceUserTable.userId, userId),
        ),
      )
      .limit(1);

    if (!raced) throw error;

    await reconcileWorkspaceMemberRole(workspaceId, userId, role);

    console.warn(
      `[operon] workspace membership for kaneo user ${userId} was created by a concurrent writer; reconciled to "${role}"`,
    );
  }
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
 * The literal prefix every Operon service key carries, and why a prefix at all.
 *
 * The api-key plugin's session hook decides whether a request becomes a Better Auth
 * session by asking `customAPIKeyGetter(ctx)` for a key, and that getter is called from
 * the hook's MATCHER, which is synchronous (`!!findApiKeyAndConfig(ctx)` —
 * `@better-auth/api-key/dist/index.mjs:2366,2395`). A getter that had to consult the
 * `apikey` table to recognise the service key would return a Promise, and `!!promise` is
 * `true` for every request — the hook would match everything and skip nothing.
 *
 * So the marker the getter reads has to be IN THE KEY STRING. `prefix` is the plugin's
 * own supported way to put it there (`createApiKey` accepts it, `${prefix}${key}` is the
 * value handed out), it is stored in plain text beside the hash, and it changes nothing
 * about verification: `utils/verify-api-key.ts` hashes the WHOLE presented string.
 *
 * It is a marker, never a secret and never an authorization: the 403 guard and the
 * re-key route both authorise on the unforgeable `metadata` marker read back from the
 * row. A caller who guesses the prefix and prepends it to their own key gets a key that
 * does not verify.
 */
export const OPERON_SERVICE_KEY_PREFIX = "operon_svc_";

/** Does this presented credential claim, by its prefix, to be the service key? */
export function looksLikeOperonServiceKey(value: string | null | undefined) {
  return (
    typeof value === "string" &&
    value.trim().startsWith(OPERON_SERVICE_KEY_PREFIX)
  );
}

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
      prefix: OPERON_SERVICE_KEY_PREFIX,
      permissions: { ...OPERON_SERVICE_KEY_PERMISSIONS },
      metadata: { ...OPERON_SERVICE_KEY_METADATA },
    },
  });
  return created?.key ?? null;
}

/**
 * Turn off every `operonService`-marked key on this instance.
 *
 * Called immediately before a re-mint, so the instance never carries two credentials that
 * both satisfy the re-key route's marker check. A key is DISABLED rather than deleted:
 * `verifyApiKey` and the plugin both refuse `enabled = false`, so it is dead either way,
 * and the row is still there to answer "which credential was in use on the day of the
 * incident?" — which a delete would have thrown away.
 *
 * The marker is read by parsing each row's `metadata` in JS rather than by a `LIKE` over
 * the column, because the api-key plugin has shipped double-stringified metadata in the
 * past and `operon-account/index.ts` already carries the two-pass parse for that reason.
 * The set is at most a handful of rows on this instance.
 */
async function revokeOperonServiceKeys(): Promise<number> {
  const rows = await db
    .select({
      id: schema.apikeyTable.id,
      metadata: schema.apikeyTable.metadata,
      enabled: schema.apikeyTable.enabled,
    })
    .from(schema.apikeyTable);

  const doomed = rows
    .filter(
      (row) => row.enabled !== false && hasOperonServiceMarker(row.metadata),
    )
    .map((row) => row.id);

  if (doomed.length === 0) return 0;

  await db
    .update(schema.apikeyTable)
    .set({ enabled: false })
    .where(inArray(schema.apikeyTable.id, doomed));

  return doomed.length;
}

/**
 * The public fingerprint of a service key — the handle Operon can compute from the
 * credential it HOLDS and this fork can compute from a row it has never seen in plaintext.
 *
 * Better Auth stores `base64url(sha256(key))`, unpadded, in `apikey.key`
 * (`@better-auth/api-key/dist/index.mjs:2314`; this fork's own `utils/verify-api-key.ts`
 * hashes identically), so the first {@link OPERON_SERVICE_KEY_ID_LENGTH} characters of that
 * column ARE this fingerprint — no new column, no metadata to backfill, and every
 * historical row already carries one.
 *
 * It is truncated on purpose. The full 43-character hash is the verifier the database
 * compares against, so shipping it would be shipping a credential; 16 base64url characters
 * is 96 bits — unique across any set of keys this instance will ever hold, and useless as
 * a verifier.
 */
export const OPERON_SERVICE_KEY_ID_LENGTH = 16;

/** The fingerprint of a key held in PLAINTEXT — one just minted, or one Operon holds. */
export function operonServiceKeyId(key: string): string {
  return createHash("sha256")
    .update(key)
    .digest("base64url")
    .slice(0, OPERON_SERVICE_KEY_ID_LENGTH);
}

/**
 * The fingerprints of every `operonService` key this instance would still accept.
 *
 * This is the list Operon needs in order to tell a REVOKED credential from a live one.
 * Operon holds the key in its process and cannot ask the `apikey` table anything, so its
 * acknowledgement reported PRESENCE — and a revoked key is present. Round-3's blocker was
 * exactly that gap: a delivery carrying an already-revoked key installed cleanly, and no
 * later login could tell the difference.
 *
 * The filter is the one `verifyApiKey` applies — enabled, unexpired, carrying the
 * unforgeable marker — so a fingerprint in this list is a key that would actually
 * authenticate. It rides inside the HMAC-signed callback body with everything else, so it
 * costs no second round trip and no second signing scheme.
 */
async function enabledOperonServiceKeyIds(): Promise<string[]> {
  const rows = await db
    .select({
      key: schema.apikeyTable.key,
      metadata: schema.apikeyTable.metadata,
      enabled: schema.apikeyTable.enabled,
      expiresAt: schema.apikeyTable.expiresAt,
    })
    .from(schema.apikeyTable);

  const now = Date.now();
  return rows
    .filter(
      (row) =>
        row.enabled !== false &&
        !(row.expiresAt instanceof Date && row.expiresAt.getTime() <= now) &&
        hasOperonServiceMarker(row.metadata),
    )
    .map((row) => String(row.key || "").slice(0, OPERON_SERVICE_KEY_ID_LENGTH))
    .filter((id) => id.length === OPERON_SERVICE_KEY_ID_LENGTH);
}

/**
 * Does this `apikey.metadata` blob carry the bootstrap's marker?
 *
 * Tolerates the plugin's historical double-stringified shape, exactly as
 * `operon-account/index.ts` does, so a legacy row is recognised rather than silently
 * treated as somebody's personal key.
 */
export function hasOperonServiceMarker(
  raw: string | null | undefined,
): boolean {
  if (!raw) return false;
  try {
    return metadataHasOperonServiceMarker(JSON.parse(raw));
  } catch {
    return false;
  }
}

/** The same question asked of an already-parsed `metadata` value. */
function metadataHasOperonServiceMarker(value: unknown): boolean {
  // The plugin's historical double-stringified shape: a JSON string INSIDE the column.
  if (typeof value === "string") return hasOperonServiceMarker(value);
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).operonService === true
  );
}

/**
 * Is the credential presented on this request the Operon service key?
 *
 * The question the `/api/auth/*` guard in `index.ts` asks, and it has to be asked of the
 * ROW rather than of the string: the prefix is a routing marker anyone can type, while
 * `{ operonService: true }` in `metadata` can only have been written by a server-side
 * mint. A prefixed string that does not verify is simply not a key and is left to Better
 * Auth to refuse as one.
 *
 * Both spellings are checked because `index.ts`'s existing `/auth/*` handler REWRITES a
 * `Authorization: Bearer <key>` into `x-api-key` before calling `auth.handler` — a guard
 * that only read `x-api-key` would be walked around by sending the same key as a bearer.
 */
export async function requestCarriesOperonServiceKey(
  headers: Headers,
): Promise<boolean> {
  const candidates = [
    headers.get("x-api-key")?.trim(),
    headers
      .get("authorization")
      ?.match(/^Bearer\s+(\S+)$/i)?.[1]
      ?.trim(),
  ].filter((value): value is string => !!value);

  for (const candidate of candidates) {
    const verified = await verifyApiKey(candidate).catch(() => null);
    if (
      verified?.valid &&
      metadataHasOperonServiceMarker(verified.key?.metadata)
    ) {
      return true;
    }
  }

  return false;
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
 *
 * ── WHAT IT RETURNS, AND WHY IT RETURNS ANYTHING ─────────────────────────────────
 *
 * `null` for "this delivery did not land" — unconfigured, refused, timed out, threw —
 * and Operon's parsed acknowledgement otherwise. The field that matters is
 * `serviceKeyValid`: Operon holds the API key in its PROCESS, not in a table, so it is the
 * only party that can say whether a credential is actually in use, and
 * {@link provisionOperonUser} re-mints on a `false`. Distinguishing "no answer" from
 * "answered false" is the whole point of the `null` — a mint we cannot deliver is churn,
 * not recovery.
 *
 * ── AND EVERY BODY NAMES THE KEYS THIS INSTANCE STILL ACCEPTS ────────────────────
 *
 * `enabledServiceKeyIds` is {@link enabledOperonServiceKeyIds}, signed with the rest of the
 * body. It is what turns Operon's answer from "I hold a key" into "I hold a key that still
 * works": Operon fingerprints the credential in its process and looks for it in this list.
 * A callback that omits it (an older fork against a newer Operon) leaves Operon unable to
 * judge, and it falls back to reporting presence — the previous behaviour, no worse.
 *
 * It is also what lets the receiver refuse to INSTALL a revoked key: a delivery whose own
 * `apiKey` is not in its own `enabledServiceKeyIds` is a delivery the sender revoked
 * between minting and sending, and installing it is the round-3 blocker.
 */
type OperonCallbackAck = {
  /** @deprecated Presence, not validity. Kept for one release; read `serviceKeyValid`. */
  serviceKeyOnFile?: boolean;
  /** The installed key is one of `enabledServiceKeyIds`. Absent on an older Operon. */
  serviceKeyValid?: boolean;
  /**
   * Operon is inside a quiesced maintenance window and is about to dump both stores
   * (Operon spec R25, decisions 34 and 54).
   *
   * While it is `true` the mint / revoke / deliver path below DEFERS: it mints nothing and
   * REVOKES NOTHING — revoking and then deferring the delivery is strictly worse than doing
   * nothing, because it leaves Operon with no credential at all until the window closes.
   * Absent on an older Operon, which is indistinguishable from `false` and is treated as it.
   */
  maintenance?: boolean;
  /** How long the window is expected to last, in seconds. A hint, not a promise. */
  retry_after_s?: number;
} | null;

/**
 * Does Operon need a fresh service key?
 *
 * `serviceKeyValid` when Operon reports it, `serviceKeyOnFile` when it does not — a newer
 * fork must not silently stop repairing an Operon that has not been redeployed yet. `null`
 * (no answer) is never a reason to mint.
 */
function operonNeedsServiceKey(ack: OperonCallbackAck): boolean {
  if (!ack) return false;
  if (typeof ack.serviceKeyValid === "boolean")
    return ack.serviceKeyValid === false;
  return ack.serviceKeyOnFile === false;
}

async function postOperonKaneoUser(payload: {
  sub: string;
  kaneoUserId: string;
  email: string;
  name: string;
  workspaceId: string | null;
  apiKey?: string;
  /**
   * The enabled set as of the moment the caller checked it. Passed by the two paths that
   * deliver a key — they read it inside the advisory lock, immediately before sending, so
   * the list and the key it vouches for cannot drift apart. Every other caller lets this
   * read it fresh.
   */
  enabledServiceKeyIds?: string[];
}): Promise<OperonCallbackAck> {
  const base = (process.env.OPERON_INTERNAL_API_URL || "").replace(/\/+$/, "");
  const secret = process.env.OPERON_KANEO_S2S_SECRET || "";
  if (!base || !secret) {
    console.warn(
      "[operon] OPERON_INTERNAL_API_URL or OPERON_KANEO_S2S_SECRET is unset; kaneo_user_id was not reported",
    );
    return null;
  }

  const { enabledServiceKeyIds, ...rest } = payload;
  // Hoisted out of the body literal because the DRAIN needs it: a delivery that ends
  // without an HTTP status is recorded `unresolved` BY THIS ID, and Operon reconciles it
  // against the claim row its own receiver wrote under the same id (decision 54).
  const deliveryId = randomUUID();
  const body = JSON.stringify({
    ...rest,
    enabledServiceKeyIds:
      enabledServiceKeyIds ?? (await enabledOperonServiceKeyIds()),
    deliveryId,
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
      // A STATUS IS AN ANSWER, and that is why nothing is recorded unresolved here
      // (decision 54): a 4xx — Operon's replay 409, or a 401 — wrote nothing, and the
      // caller's `finally` decrement below is the whole truth about this operation.
      console.error(
        `[operon] internal/kaneo/user rejected the callback (${response.status})`,
      );
      return null;
    }
    // The key itself is never logged (Operon AGENTS.md rule 23).
    console.log(
      `[operon] reported kaneo user for workspace ${payload.workspaceId ?? "none"}`,
    );
    // A body that will not parse is not a reason to fail a sign-in: it costs the caller
    // the re-mint signal for this login and nothing else, and the next login asks again.
    // A 2xx WROTE EVERYTHING, even when its body will not parse, so an unparseable body
    // is still an answer and still records nothing unresolved.
    const ack = (await Promise.resolve()
      .then(() => response.json())
      .catch(() => null)) as OperonCallbackAck;
    const parsed = ack && typeof ack === "object" ? ack : null;
    // What Operon just told us about its window, remembered for the two writers below.
    observeOperonMaintenance(parsed);
    return parsed;
  } catch (error) {
    // ── NO STATUS CAME BACK, SO NOTHING HERE KNOWS WHETHER OPERON WROTE ───────────────
    //
    // This is round 3's blocker. The abort above fires at OPERON_S2S_TIMEOUT_MS and lands
    // here; it closes this fork's socket and tells Operon nothing, while the credential
    // transaction Operon opened on receipt runs on to its own commit. Returning `null` and
    // letting the counter fall to zero would report a drain that has not happened, and
    // Operon's acquisition would start dumping over an open cross-store write. So the
    // delivery is recorded UNRESOLVED and only Operon — the one party that can see its own
    // store — can clear it, on the resolve route.
    recordUnresolvedOperonDelivery(deliveryId);
    console.error("[operon] internal/kaneo/user callback failed", error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * The claims of the sign-in that is happening now, found by the identity the DATABASE
 * says this user holds — never by the address they happen to carry (round-2 finding 1).
 *
 * `account` is the authority: an Operon user has exactly one `custom` row and its
 * `accountId` is the subject Operon authenticated. Reading the claims under that subject
 * makes it impossible for this reconciliation to report a login to Operon under an
 * identity the login was not for, however many callbacks are in flight for the address.
 *
 * The loop, rather than a single row, is for the one moment a user legitimately carries
 * two: a rekey (`operon-account/index.ts`) moves the subject, and a login that raced it
 * must still find its own entry. Only the subject with a live capture answers, and the
 * capture is consumed, so at most one can.
 */
async function takeOperonClaimsForUser(userId: string) {
  const subjects = await db
    .select({ accountId: schema.accountTable.accountId })
    .from(schema.accountTable)
    .where(
      and(
        eq(schema.accountTable.userId, userId),
        eq(schema.accountTable.providerId, OPERON_PROVIDER_ID),
      ),
    );

  for (const { accountId } of subjects) {
    const claims = takeOperonOidcClaims(accountId);
    if (claims) return claims;
  }
  return null;
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
 * `takeOperonClaimsForUser` only finds an entry for one that did — and
 * `mapCustomOAuthProfileToUser` refills that entry on EVERY OIDC callback, which is
 * what makes the retry possible at all.
 *
 * ── THE CLAIMS ARE FOUND BY THE SUBJECT THIS USER HOLDS, NOT BY THEIR EMAIL ──────
 *
 * Round-2 finding 1. This used to be `takeOperonOidcClaims(user.email)` against a map
 * keyed by email, so a second callback for the same address — a different Operon
 * identity, a rekey in flight — could have overwritten the entry and this session would
 * have been reported to Operon under SOMEBODY ELSE'S subject, permanently binding
 * `identities.kaneo_user_id` to the wrong person. The subject is now read from the
 * `account` table, which is the authority for who this Kaneo user actually is, and the
 * claims are collected under it. An address is an attribute; the subject is the identity.
 *
 * ── AND A NO-OP ON EVERY INSTANCE THAT IS NOT AN OPERON INSTANCE ─────────────────
 *
 * `providerId: "custom"` is upstream's GENERIC OIDC slot. Any self-hosted Kaneo can
 * point it at Okta or Keycloak, and this function has no business rewriting `user.role`
 * from their `role` claim or auto-joining their people to the earliest workspace — both
 * of which it did, unconditionally, before the `isOperonOidcOnly` guard below.
 * `custom-oauth-profile.ts` gates the capture as well, so the map is empty on such an
 * instance and this guard is the second of two; it is here because a hole this shape
 * should be closed at the consumer as well as at the source.
 *
 * ── THE RE-MINT PATH ─────────────────────────────────────────────────────────────
 *
 * The key is minted exactly once, by the login that CREATES the workspace. If that mint
 * returned nothing, or the callback carrying it never reached Operon, every later login
 * found the workspace already there and delivered a callback with no key — so Operon was
 * left without a credential permanently, and `kaneoApiFetch` threw on every call.
 *
 * Operon's acknowledgement reports `serviceKeyValid` — whether the credential in its
 * process is one of the `enabledServiceKeyIds` this fork signs into every callback body.
 * VALIDITY, not presence: the round-3 blocker was that a revoked key is present, so
 * `serviceKeyOnFile` could not distinguish "the bootstrap key arrived" from "the bootstrap
 * key arrived and was revoked a second later", and no later login could repair it. On an
 * ADMIN's login, when the workspace already exists and Operon answers `false`, this mints
 * a fresh one — revoking every earlier `operonService`-marked key first, so the instance
 * never carries two credentials that satisfy the re-key route's marker — and delivers it
 * in a SECOND signed callback with its own delivery id and timestamp. The receiver installs
 * it under the same never-backwards ordering rule as any other delivery.
 *
 * Four things keep that from being a key mill:
 *
 *   * it needs an explicit `false`, so an unreachable Operon (ack `null`) mints nothing —
 *     a credential we cannot deliver is churn, not recovery;
 *   * it needs `claims.role === "admin"`, because a member's key would hang off a user
 *     without the permissions the ceiling is a ceiling over;
 *   * a login that just delivered a freshly minted key does not ask again — Operon
 *     computes the flag AFTER installing, so that same response already says `true`; and
 *   * the premise is re-asked INSIDE the advisory lock before anything is revoked, so a
 *     repair that queued behind the bootstrap does not destroy the key the bootstrap just
 *     delivered.
 */
async function provisionOperonUser(user: {
  id: string;
  email: string;
  name?: string | null;
}) {
  if (!isOperonOidcOnly) return;

  const claims = await takeOperonClaimsForUser(user.id);
  if (!claims) return;

  await syncOperonInstanceRole(user.id, claims.role);

  let workspaceId = await findOperonWorkspaceId();
  // Whether the workspace was ALREADY there when this login started, which is the
  // question the re-mint below asks — not "is there one now". A login that is itself
  // part of the bootstrap must never re-mint: the concurrent-bootstrap loser would read
  // `serviceKeyValid: false` simply because the WINNER's delivery had not landed yet,
  // and would revoke the winning credential to replace it with its own.
  const workspaceExisted = workspaceId !== null;
  let bootstrapped = false;

  if (workspaceId) {
    await joinOperonWorkspace(workspaceId, user.id, claims.role);
  } else if (claims.role === "admin") {
    // Decision 49: the FIRST ADMIN's login bootstraps the workspace, and the key
    // platform-service will call back with is minted in the same breath — but ONLY
    // by the caller that actually won the slug claim. A concurrent second admin
    // login recovers the same workspace, joins it, and delivers no key.
    const bootstrap = await createOperonWorkspace(user.id);
    workspaceId = bootstrap.id;
    if (workspaceId && bootstrap.created) {
      bootstrapped = true;
    } else if (workspaceId) {
      await joinOperonWorkspace(workspaceId, user.id, claims.role);
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

  const identity = {
    sub: claims.sub,
    kaneoUserId: user.id,
    email: user.email,
    name: user.name || claims.name,
    workspaceId,
  };

  // ── THE BOOTSTRAP MINT AND ITS DELIVERY ARE ONE CRITICAL SECTION ────────────────
  //
  // Round-3's blocker. The mint used to sit here, outside the lock, and the delivery
  // rode along on the ordinary callback below: admin 1 created the workspace and minted
  // key A, admin 2 then found the workspace, was told no key was on file, revoked A and
  // delivered B — and admin 1's callback finally went out carrying A with a LATER signed
  // timestamp, so Operon installed the revoked credential and never learned otherwise.
  //
  // Mint → confirm-still-enabled → deliver now runs under the same advisory lock the
  // repair takes, so the two sequences cannot interleave at all. Losing the lock is not
  // an error: the login that holds it is either bootstrapping or repairing, and this one
  // falls through to the key-less callback below.
  //
  // ── AND IT STANDS DOWN INSIDE OPERON'S MAINTENANCE WINDOW (R25, decision 54) ────────
  //
  // The bootstrap mint precedes its own first callback, so it cannot be told about the
  // window by the ack it is about to receive — decisions 52 and 56 cover the genuinely
  // first login by ORDERING (the first Initiative sign-in happens before the `backup`
  // profile is ever enabled). What this guard covers is every bootstrap AFTER a window has
  // been observed on some earlier callback in this process: minting there would deliver a
  // credential into a store that is being dumped. The observation expires, so a killed
  // Operon cannot leave this fork deferring for ever.
  const bootstrapDeferral = operonMaintenanceDeferral();
  if (bootstrapped && workspaceId && bootstrapDeferral.deferred) {
    console.warn(
      `[operon] maintenance window: the bootstrap service key was NOT minted or delivered; retry_after_s=${bootstrapDeferral.retryAfterS ?? "unset"}`,
    );
  } else if (bootstrapped && workspaceId) {
    const outcome = await withOperonServiceKeyLock(() =>
      mintAndDeliverBootstrapServiceKey(identity),
    );
    if (!outcome.locked) {
      console.warn(
        "[operon] another login holds the service-key lock; the bootstrap minted nothing",
      );
    }
    // The delivery inside the lock IS this login's callback. Sending a second one would
    // re-report the same user for no reason and burn a delivery id.
    if (outcome.result) return;
  }

  // ── THE KEY-LESS SETTLE IS A CROSS-STORE WRITE TOO (R25, decisions 34 and 54) ───────
  //
  // Round-1's Important finding on the fork gate. This callback carries no credential, so it
  // never went near `withOperonServiceKeyLock` and was never counted — but Operon's receiver
  // settles `identities.kaneo_user_id` on it, and the Kaneo-side membership this function
  // has already written is the other half of that pair. A sign-in that landed between the
  // two dumps therefore straddled them while `credentialOpsInFlight` read zero.
  //
  // Counted with the SAME pair the lock uses, so the counter accounts for every cross-store
  // write this fork initiates rather than only the credential ones, and the `finally` is
  // what keeps a thrown callback from wedging every later acquisition. A timeout still
  // records the id unresolved, because `postOperonKaneoUser`'s `catch` does that for every
  // caller — and it must, for the same reason it does on a credential delivery: the abort
  // tells Operon nothing while its transaction runs on to its own commit.
  //
  // The barrier's OTHER half is Operon's: while the flag is held its receiver refuses a
  // key-less delivery BEFORE writing anything and answers the window instead.
  beginOperonCredentialOp();
  let ack: OperonCallbackAck;
  try {
    ack = await postOperonKaneoUser(identity);
  } finally {
    endOperonCredentialOp();
  }

  // NOTHING IS ROLLED BACK, exactly as the credential path rolls nothing back. Everything
  // written before this callback — the instance role and the workspace membership — is
  // KANEO-LOCAL and idempotent (see this function's header), so a deferred settle leaves a
  // COMPLETE membership on the fork side and no `kaneo_user_id` on Operon's. That is the
  // direction a restore heals from: the next sign-in re-reports the same `(sub,
  // kaneoUserId)` under a fresh delivery id and settles it. The reverse — Operon holding an
  // id for a Kaneo row its dump never captured — is the pairing that cannot heal, and is
  // exactly what the receiver's refusal prevents.
  //
  // LOGGED AND NOT RETURNED ON: the ack of a refused settle carries neither
  // `serviceKeyValid` nor `serviceKeyOnFile`, so `operonNeedsServiceKey` is already `false`
  // below; and an Operon that reports the window while still answering those fields is
  // caught by the re-mint's own deferral guard, which has the more specific line to log.
  const settleDeferral = operonMaintenanceDeferral();
  if (settleDeferral.deferred) {
    console.warn(
      `[operon] maintenance window: kaneo_user_id was NOT settled for kaneo user ${user.id}; the next sign-in after the window re-reports it; retry_after_s=${settleDeferral.retryAfterS ?? "unset"}`,
    );
  }

  if (
    claims.role === "admin" &&
    workspaceExisted &&
    workspaceId &&
    operonNeedsServiceKey(ack)
  ) {
    // The ack that got us here may itself have said `maintenance: true` — Operon reports
    // BOTH fields, because a key that is invalid stays invalid whether or not a backup is
    // running. Deferring here is what stops the re-mint from being ADMITTED at all; the
    // second check, inside the lock and after the re-check, is what stops one that WAS
    // admitted a moment before the flag was taken from revoking anything.
    const deferral = operonMaintenanceDeferral();
    if (deferral.deferred) {
      console.warn(
        `[operon] maintenance window: the service key was NOT re-minted and nothing was revoked; retry_after_s=${deferral.retryAfterS ?? "unset"}`,
      );
      return;
    }
    await remintAndDeliverOperonServiceKey({
      sub: claims.sub,
      user,
      name: user.name || claims.name,
      workspaceId,
    });
  }
}

/**
 * The advisory-lock key the re-mint is serialised on.
 *
 * A different number from the `2026` upstream's first-user promotion uses, because they
 * are different mutual exclusions and sharing one would make an admin login wait on a
 * signup for no reason.
 */
const OPERON_REMINT_LOCK = 2027;

/**
 * Run `work` while holding {@link OPERON_REMINT_LOCK}, or report that somebody else has it.
 *
 * Both writers of the service key take this — the bootstrap mint and the repair — because
 * a lock only one of two racing sequences respects is not a lock. Before round 3 the
 * bootstrap did not take it at all, which is how a repair could revoke a key the bootstrap
 * had already minted and was about to deliver.
 *
 * `pg_try_advisory_xact_lock`, not the blocking form: the holder keeps the lock across an
 * HTTP callback, and a login that sat waiting on that would be a login sitting on a pool
 * connection for the length of somebody else's network round trip. It skips instead, and
 * the next admin login asks Operon again — the recovery path exists precisely so a skipped
 * repair is not a permanent one.
 *
 * The lock is transaction-scoped, so a throw anywhere inside releases it. Nothing inside
 * uses `tx` for its statements: Better Auth's `createApiKey` and the revoke run on `db`,
 * and the transaction here is a mutex, not a unit of work.
 *
 * @returns `locked: false` when another login holds it, and `result` otherwise.
 */
async function withOperonServiceKeyLock<T>(
  work: () => Promise<T>,
): Promise<{ locked: boolean; result?: T }> {
  return db.transaction(async (tx) => {
    // `sql.raw` with a numeric constant, and not a bound parameter, for the same reason
    // `databaseHooks.user.create.after` writes `pg_advisory_xact_lock(2026)` literally:
    // a lock key is a constant, and a bound `unknown` would leave Postgres resolving the
    // function's argument type at run time rather than at parse time.
    const claim = await tx.execute(
      sql.raw(
        `SELECT pg_try_advisory_xact_lock(${OPERON_REMINT_LOCK}) AS locked`,
      ),
    );
    const locked = claim.rows[0]?.locked;
    if (locked !== true && locked !== "t") return { locked: false };
    // ── ADMISSION ACCOUNTING (Operon spec R25, decisions 34, 50 and 54) ──────────────
    //
    // THE LOCK IS THE ADMISSION POINT. Operon's maintenance flag stops the NEXT credential
    // operation; a sign-in that read `serviceKeyValid: false` from an ack sent before the
    // flag was taken is already past it and will revoke, mint and deliver regardless. So
    // the fork counts what it has admitted, and Operon's acquisition waits for that count
    // to reach zero before it dumps.
    //
    // The increment is here — after the lock is GRANTED, so a login that skipped is not
    // counted — and the decrement is in a `finally`, so the count is right on the success
    // path, on every early return inside `work`, and on a throw. `work()` spans
    // `postOperonKaneoUser`, which is what puts the DELIVERY inside the counted region
    // rather than after it. A counter that leaked on one error path would 503 Operon's
    // reissues for ever, which is why it is one `finally` and not a decrement per return.
    beginOperonCredentialOp();
    try {
      return { locked: true, result: await work() };
    } finally {
      endOperonCredentialOp();
    }
  });
}

/**
 * Mint the bootstrap service key and deliver it — inside the lock, and never after it has
 * been revoked.
 *
 * The enabled-set read between the mint and the POST is the "never deliver a dead key"
 * guard the reviewer asked for. Under the lock it should be impossible for the key to have
 * been revoked already, which is exactly why the check is cheap to keep: it is the
 * assertion that the lock is doing its job, and if a future caller ever mints outside the
 * lock again this refuses to ship the result rather than silently poisoning Operon.
 *
 * The same read is what the callback carries as `enabledServiceKeyIds`, so the list Operon
 * validates against and the list this function checked are literally the same array.
 *
 * @returns true when a callback carrying the key went out.
 */
async function mintAndDeliverBootstrapServiceKey(identity: {
  sub: string;
  kaneoUserId: string;
  email: string;
  name: string;
  workspaceId: string | null;
}): Promise<boolean> {
  const minted = await mintOperonApiKey(identity.kaneoUserId);
  if (!minted) {
    console.error(
      "[operon] the bootstrap mint returned nothing; the next admin login will recover",
    );
    return false;
  }

  const enabledServiceKeyIds = await enabledOperonServiceKeyIds();
  if (!enabledServiceKeyIds.includes(operonServiceKeyId(minted))) {
    // The key itself is never logged (Operon AGENTS.md rule 23).
    console.error(
      "[operon] the key just minted is already revoked; refusing to deliver it",
    );
    return false;
  }

  await postOperonKaneoUser({
    ...identity,
    apiKey: minted,
    enabledServiceKeyIds,
  });
  return true;
}

/**
 * Replace the Operon service key and deliver the replacement, at most one at a time.
 *
 * ── WHY THE LOCK SPANS THE DELIVERY AND NOT ONLY THE MINT ────────────────────────
 *
 * Two admins signing in at the same moment into a key-less Operon would both be told the
 * key is not valid. Serialising only the mint does not help: A mints Ka, B revokes Ka and
 * mints Kb, and then the two POSTs race — each callback's `timestamp` is stamped when it is
 * SENT, so A's delivery of the already-revoked Ka can carry the later timestamp and win
 * Operon's never-backwards comparison. Operon would end up holding a disabled key, which is
 * the exact failure this whole path exists to repair.
 *
 * Holding the lock across the delivery makes the sequence re-check → revoke → mint →
 * deliver indivisible, so the last delivery to be SENT is always the one carrying the only
 * enabled credential. Round 3 found the other half of that argument missing: the BOOTSTRAP
 * mint and delivery were outside this lock entirely, so a repair could interleave with them
 * however it liked. {@link mintAndDeliverBootstrapServiceKey} now takes the same lock,
 * through {@link withOperonServiceKeyLock}.
 *
 * `pg_try_advisory_xact_lock`, not the blocking form: a login that finds another one
 * already repairing has nothing useful to add and should not sit on a pool connection
 * waiting. It skips, and if the repair somehow did not take, the next admin login asks
 * Operon again. The lock is transaction-scoped, so a throw anywhere inside releases it.
 */
async function remintAndDeliverOperonServiceKey(args: {
  sub: string;
  user: { id: string; email: string };
  name: string;
  workspaceId: string;
}) {
  const identity = {
    sub: args.sub,
    kaneoUserId: args.user.id,
    email: args.user.email,
    name: args.name,
  };

  const outcome = await withOperonServiceKeyLock(async () => {
    // ── ELIGIBILITY IS RE-ASKED INSIDE THE LOCK ────────────────────────────────
    //
    // The `serviceKeyValid: false` that got us here was read OUTSIDE the lock, and by
    // the time the lock is granted it may be minutes stale — the login that held the
    // lock in the meantime was very probably the bootstrap, or another repair, either
    // of which has just delivered a live key. Revoking on the strength of that stale
    // answer is precisely how the winner's credential gets destroyed.
    //
    // So both halves of the premise are re-checked here, before anything is revoked:
    // the workspace still exists, and Operon still says it has no key that works. The
    // re-check is a key-less callback, so it can install nothing and cost nothing but
    // one delivery id.
    const workspaceId = await findOperonWorkspaceId();
    if (!workspaceId) {
      console.warn(
        "[operon] the workspace is gone; not re-minting a service key for it",
      );
      return;
    }

    const recheck = await postOperonKaneoUser({ ...identity, workspaceId });
    if (!recheck) {
      console.warn(
        "[operon] operon did not answer the re-mint re-check; nothing was revoked",
      );
      return;
    }
    // ── THE WINDOW IS RE-ASKED HERE TOO, AND IT IS ASKED BEFORE THE REVOKE ──────────
    //
    // This is the check that makes the barrier's flag half correct rather than nearly
    // correct (R25, decision 54). The `serviceKeyValid: false` that admitted this login was
    // read OUTSIDE the lock; Operon may have taken its maintenance flag in the meantime,
    // and this re-check is the first message that can say so. Revoking and THEN deferring
    // the delivery is strictly worse than doing nothing — it would leave Operon with no
    // credential at all for the length of the backup — so nothing is revoked, and the next
    // sign-in after the window does the work.
    if (recheck.maintenance === true) {
      console.warn(
        `[operon] maintenance window: operon is quiescing, so nothing was revoked, minted or delivered; retry_after_s=${recheck.retry_after_s ?? "unset"}`,
      );
      return;
    }
    if (!operonNeedsServiceKey(recheck)) {
      console.log(
        "[operon] operon now holds a valid service key; the re-mint is not needed",
      );
      return;
    }

    const revoked = await revokeOperonServiceKeys();
    const replacement = await mintOperonApiKey(args.user.id);
    if (!replacement) {
      // Nothing to deliver, and the old keys are already off. Say so loudly rather than
      // leaving a silent gap; the next admin login tries again.
      console.error(
        `[operon] operon reported no valid service key and the re-mint returned nothing (${revoked} earlier key(s) revoked)`,
      );
      return;
    }

    const enabledServiceKeyIds = await enabledOperonServiceKeyIds();
    if (!enabledServiceKeyIds.includes(operonServiceKeyId(replacement))) {
      console.error(
        "[operon] the replacement key is already revoked; refusing to deliver it",
      );
      return;
    }

    // The key itself is never logged (Operon AGENTS.md rule 23).
    console.warn(
      `[operon] operon reported no valid service key; re-minted (${revoked} earlier key(s) revoked)`,
    );
    await postOperonKaneoUser({
      ...identity,
      workspaceId,
      apiKey: replacement,
      enabledServiceKeyIds,
    });
  });

  if (!outcome.locked) {
    console.warn(
      "[operon] another login is already re-minting the service key; skipping",
    );
  }
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

const kaneoDrizzleAdapter = drizzleAdapter(db, {
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
});

type KaneoAdapter = ReturnType<typeof kaneoDrizzleAdapter>;

/**
 * A user this OIDC first login collided with on `user.email`, held back until the
 * subject proves they are the same person.
 *
 * `proved` is not bookkeeping. `recoverOperonOidcUser` hands the row back BEFORE anything
 * has established that the address and this callback's identity belong together, because
 * at that moment nothing can: the insert that failed carried a name, an email and a
 * verification flag, and no subject at all. The proof arrives one statement later, when
 * `createOAuthUser` writes the `account` row and finally names the subject Operon
 * verified — and the flag is what makes the whole call fail if it somehow never does.
 */
type OperonRecovery = {
  /** The user who already holds the address this callback tried to create. */
  userId: string;
  email: string;
  /** Has the CURRENT callback's provider and subject been proved to be theirs? */
  proved: boolean;
};

/**
 * One `createOAuthUser` call's worth of state, and not one byte more.
 *
 * Built fresh inside the `transaction` override below, so it is per-call rather than
 * per-process: two callbacks racing each other get two scopes and cannot see each
 * other's. That is the difference between this and the module-level, email-keyed cache
 * round-2 finding 1 was about.
 */
type OperonCreateScope = { recovery: OperonRecovery | null };

/** A sign-in whose address and subject came apart. Never adopted, always refused. */
class OperonIdentityMismatch extends Error {}

/**
 * The winner of a `user.email` race — HELD, not handed over (round-2 finding 1).
 *
 * The previous revision decided the whole question here, by peeking at the claims
 * `custom-oauth-profile.ts` had captured for this ADDRESS. That was the defect: the
 * capture was keyed by email, so a second callback for the same address overwrote the
 * first, and this function could verify one person's subject while serving the other
 * person's callback — returning user B to callback A, after which Better Auth attached
 * A's own distinct account to B and issued A a session for B.
 *
 * So this function no longer decides anything. It re-reads the user who now holds the
 * address, records them on the scope, and hands them back provisionally; the identity
 * check moves to {@link adoptOperonOidcAccount}, which runs on the very next statement
 * and has the one thing missing here — the subject this callback actually authenticated,
 * as Better Auth itself resolved it from the userinfo document. A recovery that never
 * reaches that check fails the whole call (see `operonDatabaseAdapter`), so "held" is
 * enforced rather than intended.
 */
async function recoverOperonOidcUser(
  base: KaneoAdapter,
  scope: OperonCreateScope,
  data: Record<string, unknown>,
  error: unknown,
): Promise<Record<string, unknown> | null> {
  if (!isUniqueViolationOn(error, /email/i)) return null;

  const email = typeof data.email === "string" ? data.email : "";
  if (!email) return null;

  const claimant = await base.findOne<{ id: string }>({
    model: "user",
    where: [{ field: "email", value: email }],
  });
  // The email was claimed and released again. There is no winner to hand back.
  if (!claimant) return null;

  scope.recovery = { userId: claimant.id, email, proved: false };
  return claimant as unknown as Record<string, unknown>;
}

/**
 * The account write that follows a recovery — and the check that makes the recovery safe.
 *
 * This is where the sign-in's own identity finally arrives: `data` is the account
 * `createOAuthUser` is about to write, so `providerId` and `accountId` are Better Auth's
 * resolution of THIS callback's provider and subject, not a cache lookup that another
 * request could have moved. Three things must hold before the recovered user is allowed
 * to stand:
 *
 *   1. **The provider is Operon's.** A recovered user is never handed to a different
 *      configured provider — that is how a GitHub or Google callback would otherwise
 *      inherit a Kaneo account it never authenticated.
 *   2. **The account being written is for the recovered user.** Anything else means the
 *      two statements are not about the same call.
 *   3. **That user ALREADY carries this exact subject.** Not "shares the address": the
 *      row `(provider_id, account_id)` has to be theirs. If it is somebody else's, or if
 *      it never appears, the sign-in fails rather than merging two people.
 *
 * ── AND IT REPLACES THE INSERT RATHER THAN FOLLOWING IT ──────────────────────────────
 *
 * Deliberately. The `transaction` override opens no transaction — the Drizzle adapter is
 * built with no `transaction` option and the installed adapter defaults it to `false`, so
 * upstream's own implementation is a pass-through — which means a write made here and
 * then rejected would STAY written. Checking first is the only order in which a refusal
 * leaves nothing behind.
 *
 * The wait is decision 122's, for decision 122's reason: `createOAuthUser` commits the
 * `user` and the `account` as two separate statements, so the winner's account row can
 * still be milliseconds away. A window buys time for a row to appear; it never buys
 * permission to skip the check.
 */
async function adoptOperonOidcAccount(
  base: KaneoAdapter,
  recovery: OperonRecovery,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { providerId, accountId, userId } = data;

  if (
    providerId !== OPERON_PROVIDER_ID ||
    typeof accountId !== "string" ||
    userId !== recovery.userId
  ) {
    throw new OperonIdentityMismatch(
      `[operon] operon.identity_mismatch: a login that recovered kaneo user ${recovery.userId} from the address ${recovery.email} then tried to attach a ${String(providerId)} account to ${String(userId)}; refusing`,
    );
  }

  for (
    let attempt = 0;
    attempt <= OPERON_ACCOUNT_RECOVERY_ATTEMPTS;
    attempt += 1
  ) {
    if (attempt > 0) await sleep(OPERON_ACCOUNT_RECOVERY_DELAY_MS);

    const existing = await base.findOne<{ userId: string }>({
      model: "account",
      where: [
        { field: "providerId", value: OPERON_PROVIDER_ID },
        { field: "accountId", value: accountId },
      ],
    });

    if (!existing) continue;

    if (existing.userId !== recovery.userId) {
      // The subject exists and belongs to somebody else, so this address and this
      // identity have come apart. Terminal at once.
      throw new OperonIdentityMismatch(
        `[operon] operon.identity_mismatch: oidc login for ${recovery.email} lost the user race, but subject ${accountId} belongs to kaneo user ${existing.userId} and that email is held by ${recovery.userId}`,
      );
    }

    recovery.proved = true;
    console.warn(
      `[operon] oidc first login lost the user race for ${recovery.email}; recovered kaneo user ${recovery.userId}, whose custom account already carries subject ${accountId}`,
    );
    return existing as unknown as Record<string, unknown>;
  }

  throw new OperonIdentityMismatch(
    `[operon] operon.identity_mismatch: oidc login for ${recovery.email} lost the user race and no custom account carrying subject ${accountId} arrived within ${OPERON_ACCOUNT_RECOVERY_ATTEMPTS * OPERON_ACCOUNT_RECOVERY_DELAY_MS}ms; refusing to merge on the email alone`,
  );
}

/**
 * The winner of an `account (provider_id, account_id)` race, IF it is the same row.
 *
 * NOT the first-login recovery path any more — that one never reaches an insert at all,
 * because {@link adoptOperonOidcAccount} answers before `base.create` is called. What is
 * left is every OTHER `custom` account write (Better Auth's own `createAccount` and
 * `linkAccount`) meeting migration 0046's key: a repeat of a write that already
 * succeeded. The row is returned only when it hangs off the very user this call was
 * about to attach it to; a subject that belongs to a different user is the collision
 * migration 0046 exists to surface, not something to adopt.
 */
async function recoverOperonOidcAccount(
  base: KaneoAdapter,
  data: Record<string, unknown>,
  error: unknown,
): Promise<Record<string, unknown> | null> {
  if (!isUniqueViolationOn(error, /account_provider_account_unique/)) {
    return null;
  }

  const { providerId, accountId, userId } = data;
  if (
    providerId !== OPERON_PROVIDER_ID ||
    typeof accountId !== "string" ||
    typeof userId !== "string"
  ) {
    return null;
  }

  const existing = await base.findOne<{ userId: string }>({
    model: "account",
    where: [
      { field: "providerId", value: providerId },
      { field: "accountId", value: accountId },
    ],
  });

  if (!existing || existing.userId !== userId) return null;

  console.warn(
    `[operon] custom account write found subject ${accountId} already linked to kaneo user ${userId}; reusing that account row`,
  );
  return existing as unknown as Record<string, unknown>;
}

/**
 * Identity-verified conflict recovery INSIDE Better Auth's OIDC first-login path
 * (round-1 finding 2, corrected by round-2 finding 1). Operon mode only.
 *
 * ── THE FAILURE ──────────────────────────────────────────────────────────────────────
 *
 * `handleOAuthUserInfo` (`better-auth/dist/oauth2/link-account.mjs`) looks the person up
 * with `findOAuthUser` and, finding nobody, calls `createOAuthUser`. Between those two
 * statements `POST /internal/operon/user` can commit a user carrying the same address —
 * which is the whole point of that route, since an admin provisions people who have not
 * signed in yet. The `user.email` unique key then rejects the insert, and the installed
 * Better Auth does NOT re-read: the catch returns `unable to create user` and the
 * callback redirects to `…/error?error=unable_to_create_user`. The person cannot sign in
 * to the account that was just created for them, and retrying only helps because the
 * NEXT attempt's lookup finds the committed row — which is luck, not a recovery.
 *
 * ── WHY IT IS THE ADAPTER AND NOT A `databaseHooks` SEAM ──────────────────────────────
 *
 * `databaseHooks.user.create.before` runs inside this very insert, but its contract is
 * "modify the data, or return `false` to abort" — it has no way to say "this person
 * already exists, use them", and `false` makes `createWithHooks` return `null`, which
 * `createOAuthUser` immediately dereferences. `hooks.before` on the callback path runs
 * before the lookup, not between the lookup and the insert. The one seam Better Auth
 * documents that sits exactly where the write happens is the ADAPTER — `database` takes
 * any adapter object — so the recovery is a wrapper over the drizzle adapter's `create`,
 * and the real callback reaches it without knowing anything changed.
 *
 * ── WHY `transaction` IS OVERRIDDEN, AND WHY THAT CHANGES NOTHING ─────────────────────
 *
 * `createOAuthUser` runs its two writes inside `runWithTransaction(adapter, …)`, which
 * calls `adapter.transaction(cb)` and re-binds the current adapter to whatever that hands
 * `cb`. The drizzle adapter is built with no `transaction` option and defaults it to
 * `false`, so upstream's implementation is `createAsIsTransaction` — literally
 * `(fn) => fn(adapter)`, a pass-through with no BEGIN at all. Left alone it would hand
 * back the UNWRAPPED adapter and every write inside `createOAuthUser` would bypass this
 * recovery. The override is the same pass-through handing back the wrapper, so it opens
 * no transaction upstream did not open and closes none it did.
 *
 * ── AND IT IS WHERE THE PER-CALL SCOPE COMES FROM (round-2 finding 1) ─────────────────
 *
 * That override is also the only per-`createOAuthUser` boundary in the whole path, which
 * is exactly what the corrected recovery needs. The scope built here binds the user
 * recovery to the account write of the SAME call — two concurrent callbacks get two
 * scopes — and the check after `callback` is the enforcement: a recovery that was handed
 * out and never proved against a real `(provider, subject)` row fails the sign-in
 * instead of quietly issuing a session for somebody else's account. There is no
 * remaining path on which a recovered user reaches `createSession` unproven.
 *
 * The top-level adapter is built with NO scope, so nothing outside `createOAuthUser`
 * recovers from an email collision at all — narrower than the previous revision, and
 * narrow on purpose: an email collision only ever means "the same person, written by the
 * other writer" on the first-login path.
 *
 * ── AND NOTHING OUTSIDE OPERON MODE IS TOUCHED ────────────────────────────────────────
 *
 * A non-Operon instance gets `kaneoDrizzleAdapter(options)` itself, the same object
 * upstream passes.
 */
const operonDatabaseAdapter: typeof kaneoDrizzleAdapter = (options) => {
  const base = kaneoDrizzleAdapter(options);
  if (!isOperonOidcOnly) return base;

  const build = (scope: OperonCreateScope | null): KaneoAdapter => {
    // Cast because `DBAdapter["create"]` is generic in both its input and its output row
    // type, and a wrapper that re-reads the winner cannot prove to TypeScript that the
    // row it read is the same shape the caller asked to write. It is: both come from the
    // same adapter, through the same model, with the same output transform.
    const create = (async (params: {
      model: string;
      data: Record<string, unknown>;
      select?: string[];
      forceAllowId?: boolean;
    }) => {
      // Before the insert, never after it: this pass-through "transaction" opens no
      // transaction, so a row written here and then refused would stay written.
      if (params.model === "account" && scope?.recovery) {
        return await adoptOperonOidcAccount(base, scope.recovery, params.data);
      }

      try {
        return await base.create(params);
      } catch (error) {
        const recovered =
          params.model === "user" && scope
            ? await recoverOperonOidcUser(base, scope, params.data, error)
            : params.model === "account"
              ? await recoverOperonOidcAccount(base, params.data, error)
              : null;

        if (!recovered) throw error;
        return recovered;
      }
    }) as KaneoAdapter["create"];

    return {
      ...base,
      create,
      transaction: async (callback) => {
        const inner: OperonCreateScope = { recovery: null };
        const result = await callback(build(inner));

        // The enforcement half of "held, not handed over". Unreachable while
        // `createOAuthUser` writes the account immediately after the user, and that is
        // the point: if a future Better Auth stops doing so, this sign-in fails loudly
        // rather than silently returning an unverified account.
        if (inner.recovery && !inner.recovery.proved) {
          throw new OperonIdentityMismatch(
            `[operon] operon.identity_mismatch: recovered kaneo user ${inner.recovery.userId} for the address ${inner.recovery.email} but no account write ever proved the subject; refusing the sign-in`,
          );
        }
        return result;
      },
    };
  };

  return build(null);
};

export const auth = betterAuth({
  baseURL: baseURLWithoutPath,
  trustedOrigins,
  secret: process.env.AUTH_SECRET || "",
  basePath: "/api/auth",
  database: operonDatabaseAdapter,
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
      // ── OPERON MODE: AN ADDRESS DOES NOT IDENTIFY A PERSON (round-2 finding 2) ────
      //
      // Upstream's implicit linking is the OTHER door into the defect the adapter
      // recovery above closes, and it opens EARLIER — before any write conflicts.
      // `handleOAuthUserInfo` falls back to a lookup by email when no account carries
      // the callback's subject, and with `custom` trusted and the provisioned user's
      // email verified by construction (decision 110), it attached the incoming subject
      // to whoever already held the address and issued THEIR session. Subject B is
      // provisioned at an address, subject A signs in with the same address, and A gets
      // B's account: no conflict, no recovery, no trace.
      //
      // Removing `custom` from `trustedProviders` would NOT have closed it: the trust
      // flag only gates the `!userInfo.emailVerified` half of that test, and Operon's
      // userinfo document sets `email_verified`. `disableImplicitLinking` is the switch
      // that actually refuses the fallback, so a callback whose subject no account
      // carries is `account_not_linked` — a failed sign-in, not a silent adoption.
      //
      // The provisioned-then-first-login path is untouched, because it never used this
      // fallback: `POST /internal/operon/user` writes the `custom` account in the same
      // transaction as the user, so `findOAuthUser` matches on
      // `(provider_id, account_id)` and never reaches the email branch. Changing an
      // identity remains the explicit re-key route's job (`operon-account/index.ts`),
      // which is server-to-server, credentialled and checks the outgoing subject.
      //
      // Operon mode only: on an ordinary self-hosted Kaneo, upstream's linking is
      // upstream's behaviour (R35).
      disableImplicitLinking: isOperonOidcOnly,
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

            // OPERON FORK — decision 124. The boot backfill cannot reach a
            // workspace that does not exist yet: on an empty install
            // `seedDefaultWorkspaceRoles` returns before this hook has ever run,
            // and the Operon workspace is then born HERE carrying upstream's
            // `member` payload — so without this call its members could not
            // assign or delete a task until somebody restarted the API. Upstream's
            // insert above is unchanged and still runs first; the upgrade is the
            // same twice-gated, previous-default-only rewrite the backfill applies,
            // and it is a no-op on every workspace that is not Operon's.
            await upgradeOperonMemberRolePayload(
              organization.id,
              organization.slug,
            );
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
      /**
       * THE PER-REQUEST SKIP. The Operon service key never becomes a Better Auth session.
       *
       * `enableSessionForAPIKeys` is a per-CONFIGURATION switch, so the service key
       * inherited it and could authenticate Better Auth's own endpoints: Codex got 200
       * from `/api/auth/list-sessions` with it, read the workspace owner's real session
       * token out of the response, and promoted another user with that token through
       * `/api/auth/admin/set-role`. The key's `permissions` ceiling never entered into
       * it — the escape was that the key MINTED A SESSION, and a session is read by
       * `hasWorkspacePermission` with no ceiling at all.
       *
       * The plugin's only per-request seam is this getter: it is called from the session
       * hook's matcher (`!!findApiKeyAndConfig(ctx)`), and returning `null` means the
       * hook does not match, so no session is constructed for this request — including
       * on `/get-session`, which the hook otherwise answers directly.
       *
       * It MUST be synchronous. The matcher coerces the return value with `!!`, so an
       * async getter returns a Promise, `!!promise` is `true`, and every request would
       * match. That is why the discriminator is {@link OPERON_SERVICE_KEY_PREFIX} in the
       * key string rather than the `metadata` marker in the row.
       *
       * A prefix is a marker, not an authorization, and this is not the security boundary
       * on its own — the `/api/auth/*` guard in `index.ts` refuses the same request with
       * 403 after reading the unforgeable marker back from the `apikey` row. This is the
       * belt: even if a route were added that the guard did not cover, no session exists
       * to be handed out. For every ordinary key the getter returns the header exactly as
       * the plugin's own default does, so upstream behaviour is untouched.
       *
       * It is deliberately NOT gated on Operon mode, because a skip that only applied in
       * one mode would be a skip that could be missed. The only key this fork ever mints
       * with that prefix is the service key, and it only mints one in Operon mode — so on
       * an ordinary instance nothing carries it unless a user CHOOSES the prefix on their
       * own `/api-key/create` call, in which case they have opted their own key out of
       * api-key sessions and lost nothing else. That is a strictly smaller surface than
       * the alternative.
       */
      customAPIKeyGetter: (ctx) => {
        const presented = ctx.headers?.get("x-api-key") ?? null;
        return looksLikeOperonServiceKey(presented) ? null : presented;
      },
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
          //
          // AND ONLY IN OPERON MODE. `providerId: "custom"` is upstream's generic OIDC
          // slot; on an instance that is not an Operon instance, a captured profile must
          // not be a licence to skip `DISABLE_REGISTRATION`'s invitation gate. The map is
          // already empty there (`custom-oauth-profile.ts` gates the capture), so this is
          // the second of two locks on the same door.
          if (isOperonOidcOnly && hasOperonOidcClaims(user.email)) {
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

      // ── ...AND THE SERVICE KEY IS NOT A WAY INTO BETTER AUTH AT ALL ───────
      //
      // Refusing `/api-key/*` closed one door and left the corridor open. Codex
      // presented the service key to `/api/auth/list-sessions`, got 200 and the
      // workspace OWNER's live session token, then used that token on
      // `/api/auth/admin/set-role` to promote another account. `permissions` was
      // never consulted: a Better Auth session is read by
      // `utils/is-instance-admin.ts` and `hasWorkspacePermission` with no key
      // ceiling anywhere in the path.
      //
      // The real refusal is the `/api/auth/*` guard in `index.ts`, which runs
      // BEFORE `auth.handler` for every one of the four places this fork mounts it
      // and reads the unforgeable `{ operonService: true }` marker back from the
      // `apikey` row. This is the same rule restated one layer in, on the prefix
      // alone, so that a call reaching Better Auth by some path the Hono guard does
      // not cover is still refused. It is deliberately cheap — no database read —
      // because it is the redundant one.
      //
      // Operon needs NOTHING under `/api/auth`: `kaneoApiFetch` calls Kaneo's own
      // `/api/*` routes, which authenticate through `authenticateApiRequest` and
      // `utils/verify-api-key.ts`, not through Better Auth's session.
      if (
        isOperonOidcOnly &&
        ctx.request &&
        looksLikeOperonServiceKey(ctx.headers?.get("x-api-key"))
      ) {
        throw new APIError("FORBIDDEN", {
          message:
            "The Operon service key may not be used against Better Auth endpoints.",
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
