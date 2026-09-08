import { and, asc, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  accountTable,
  apikeyTable,
  userTable,
  workspaceUserTable,
} from "../database/schema";
import type { BaseVariables } from "../openapi";

/**
 * Operon fork route — re-key a custom-provider account (Operon spec R33, decision 43).
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────────────
 *
 * Operon is this instance's identity provider, and its OIDC subject is the user's 64-hex
 * Nostr pubkey. Better Auth stores that subject as `account.accountId` beside
 * `providerId = 'custom'`. Operon can rotate a pubkey (`POST /auth/reissue`, for a lost or
 * compromised key), and when it does, the account row here has to move with it — otherwise
 * the next sign-in presents a subject no account carries and, because this table has only an
 * index on `user_id` and no unique constraint on `(provider_id, account_id)`, Better Auth
 * creates a SECOND user and the person's whole history is stranded behind the old one.
 *
 * Upstream has no route that can write this column: `apps/api/src/user/` manages avatars and
 * account deletion, Better Auth's own account endpoints link and unlink providers rather
 * than re-key one, and nothing else touches `accountTable`. This is the smallest addition
 * that closes it.
 *
 * ── WHY IT IS A PLAIN HONO ROUTE AND NOT AN OPENAPI ONE ──────────────────────────────
 *
 * Publishing a private server-to-server hook in upstream's public API document would be
 * wrong on its own terms, and this route is not part of Kaneo's API. Registered as a plain
 * handler it is reachable and authenticated exactly like every other `/api` route while
 * staying out of the spec. See `docs/fork-discipline.md` in the Operon repository.
 *
 * ── THE GUARD, AND WHY "IT IS AN API KEY" WAS NOT ONE ────────────────────────────────
 *
 * The first revision required only that the caller had authenticated with an API key rather
 * than a browser session. That is not an authorization check, it is a spelling check.
 * Anyone with a Kaneo account could mint themselves a personal key, point their OWN account
 * at an unused subject, and then assign their Operon subject to an ADMINISTRATOR's Kaneo
 * account; Better Auth would resolve that subject to the administrator on the next sign-in.
 * This route hands out identities, so it needs the credential that is allowed to hand out
 * identities, and it needs to be told which identity it is moving off.
 *
 * Four things are now true before a single column is written:
 *
 *   1. **A DEDICATED credential, not merely an API key.** The key must carry the
 *      `{ operonService: true }` metadata the workspace bootstrap stamps on it
 *      (`auth.ts`, `OPERON_SERVICE_KEY_METADATA`) AND the `operon: ["rekey"]` scope
 *      (`OPERON_SERVICE_KEY_PERMISSIONS`). Neither half is forgeable on its own terms:
 *      `hooks.before` refuses client-supplied `metadata` on `/api-key/create` and
 *      `/api-key/update`, so only a server-side mint can set the marker; and the scope
 *      alone would not do, because the create endpoint accepts `permissions` straight
 *      from a client request. Metadata is read from the `apikey` row by id rather than
 *      from the request context, because `authenticateApiRequest` projects only
 *      `{id, userId, enabled, permissions}` into the context and widening that shared
 *      upstream helper is more fork surface than one indexed lookup here.
 *   2. **The TARGET is authorized, not just the caller.** The account being moved must
 *      belong to a user who shares a workspace with the key's holder. Operon runs one
 *      workspace (decision 49), so in practice this says "the target is somebody on this
 *      instance" — and it says it in a way that keeps meaning something if that ever
 *      changes.
 *   3. **The OLD subject is supplied and checked.** `previousAccountId` is what the caller
 *      believes the row currently holds. A mismatch is a 409, not a silent overwrite: it
 *      means Operon and Kaneo disagree about which identity this row is, and guessing is
 *      how a rotation lands on the wrong person.
 *   4. **A subject collision is a 409.** Two Kaneo accounts holding the same
 *      `(provider_id, account_id)` pair is precisely the state this route exists to
 *      prevent, and the table carries no unique constraint that would stop it.
 *
 * ── STILL IDEMPOTENT ─────────────────────────────────────────────────────────────────
 *
 * The row is addressed by `userId`, never by the outgoing `accountId`: the user id is the
 * stable join Operon already records as `identities.kaneo_user_id`. A retry after a partial
 * failure finds the row already carrying the NEW subject and answers 200 with
 * `updated: 0` — checked BEFORE the `previousAccountId` comparison, because after a
 * successful write the old subject is by definition no longer there.
 */
const operonAccount = new Hono<{ Variables: BaseVariables }>();

const PUBKEY = /^[0-9a-f]{64}$/;

/** The scope no upstream role grants and no upstream route reads. */
const REKEY_SCOPE = { resource: "operon", action: "rekey" } as const;

type ContextApiKey = { id?: string } | undefined;

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    // The api-key plugin has shipped double-stringified metadata in the past and
    // carries its own migration for it; a second parse costs nothing and means a
    // legacy row is read rather than silently failing the marker check.
    if (typeof value === "string") {
      const inner: unknown = JSON.parse(value);
      return inner && typeof inner === "object" && !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : null;
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Is this request carrying the credential the workspace bootstrap minted?
 *
 * Returns the key's holder id when it is, so the caller can authorize the target
 * against it, and `null` for every other caller — a browser session, an ordinary
 * user's key, or a key whose scope was trimmed.
 */
async function resolveOperonServiceKeyHolder(
  apiKeyId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      referenceId: apikeyTable.referenceId,
      userId: apikeyTable.userId,
      permissions: apikeyTable.permissions,
      metadata: apikeyTable.metadata,
    })
    .from(apikeyTable)
    .where(eq(apikeyTable.id, apiKeyId))
    .limit(1);

  if (!row) return null;

  const metadata = parseJsonObject(row.metadata);
  if (metadata?.operonService !== true) return null;

  const permissions = parseJsonObject(row.permissions);
  const granted = permissions?.[REKEY_SCOPE.resource];
  if (!Array.isArray(granted) || !granted.includes(REKEY_SCOPE.action)) {
    return null;
  }

  return row.referenceId || row.userId || null;
}

/** Do these two users share at least one workspace? */
async function sharesWorkspace(
  holderId: string,
  targetUserId: string,
): Promise<boolean> {
  const [holderWorkspaces, targetWorkspaces] = await Promise.all([
    db
      .select({ workspaceId: workspaceUserTable.workspaceId })
      .from(workspaceUserTable)
      .where(eq(workspaceUserTable.userId, holderId)),
    db
      .select({ workspaceId: workspaceUserTable.workspaceId })
      .from(workspaceUserTable)
      .where(eq(workspaceUserTable.userId, targetUserId)),
  ]);

  const holderSet = new Set(holderWorkspaces.map((row) => row.workspaceId));
  return targetWorkspaces.some((row) => holderSet.has(row.workspaceId));
}

operonAccount.patch("/account-id", async (c) => {
  const contextKey = c.get("apiKey") as ContextApiKey;
  if (!contextKey?.id) {
    throw new HTTPException(403, {
      message: "This route requires an API key, not a user session",
    });
  }

  const holderId = await resolveOperonServiceKeyHolder(contextKey.id);
  if (!holderId) {
    throw new HTTPException(403, {
      message: "This route requires the Operon service key",
    });
  }

  const body = (await c.req.json().catch(() => null)) as {
    kaneoUserId?: unknown;
    accountId?: unknown;
    previousAccountId?: unknown;
  } | null;

  const kaneoUserId = body?.kaneoUserId;
  const accountId = body?.accountId;
  const previousAccountId = body?.previousAccountId;

  if (typeof kaneoUserId !== "string" || kaneoUserId.trim() === "") {
    throw new HTTPException(400, { message: "kaneoUserId is required" });
  }
  if (typeof accountId !== "string" || !PUBKEY.test(accountId)) {
    throw new HTTPException(400, {
      message: "accountId must be a 64-character lowercase hex pubkey",
    });
  }
  if (
    typeof previousAccountId !== "string" ||
    !PUBKEY.test(previousAccountId)
  ) {
    throw new HTTPException(400, {
      message: "previousAccountId must be a 64-character lowercase hex pubkey",
    });
  }

  const [existing] = await db
    .select({ id: accountTable.id, accountId: accountTable.accountId })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.userId, kaneoUserId),
        eq(accountTable.providerId, "custom"),
      ),
    )
    .limit(1);

  if (!existing) {
    // 404 rather than a cheerful 200: Operon treats a re-key that changed nothing as a
    // failed rotation and refuses to report the rotation complete.
    throw new HTTPException(404, {
      message: "No custom-provider account for that user",
    });
  }

  if (!(await sharesWorkspace(holderId, kaneoUserId))) {
    throw new HTTPException(403, {
      message: "That account is not in the service key's workspace",
    });
  }

  // Checked before the `previousAccountId` comparison: a retry of a call that already
  // landed finds the NEW subject in place, and the old one is by definition gone.
  if (existing.accountId === accountId) {
    return c.json({ updated: 0, kaneoUserId, accountId }, 200);
  }

  if (existing.accountId !== previousAccountId) {
    throw new HTTPException(409, {
      message: "The account does not currently hold that previous subject",
    });
  }

  const [collision] = await db
    .select({ userId: accountTable.userId })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.providerId, "custom"),
        eq(accountTable.accountId, accountId),
        ne(accountTable.userId, kaneoUserId),
      ),
    )
    .limit(1);

  if (collision) {
    throw new HTTPException(409, {
      message: "Another account already holds that subject",
    });
  }

  // `previousAccountId` is in the WHERE clause and not merely checked above, so two
  // concurrent rotations cannot both write: the second matches nothing.
  const updated = await db
    .update(accountTable)
    .set({ accountId, updatedAt: new Date() })
    .where(
      and(
        eq(accountTable.userId, kaneoUserId),
        eq(accountTable.providerId, "custom"),
        eq(accountTable.accountId, previousAccountId),
      ),
    )
    .returning({ id: accountTable.id });

  if (updated.length === 0) {
    throw new HTTPException(409, {
      message: "The account does not currently hold that previous subject",
    });
  }

  return c.json({ updated: updated.length, kaneoUserId, accountId }, 200);
});

/**
 * Operon fork route — pre-create a Kaneo user at PROVISION time (Operon spec R17,
 * decisions 110, 111, 116, 122).
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────────────
 *
 * Until now a Kaneo user came into existence on that person's FIRST Initiative sign-in:
 * `databaseHooks.session.create.after` reads the claims `custom-oauth-profile.ts`
 * captured and everything downstream hangs off it. So an admin could provision somebody
 * in Operon and then not be able to assign them a task, because Initiative had never
 * heard of them — the new person had to log in once before anybody could plan work for
 * them. This route removes that step: Operon's `POST /admin/provision` calls it after its
 * own COMMIT, and the person is in the assignee list before they have opened Initiative.
 *
 * ── THE THREE WRITES ARE ONE TRANSACTION ─────────────────────────────────────────────
 *
 * A `user` with no `account` is worse than no user at all: the first OIDC sign-in would
 * find the email taken, hit `accountLinking.requireLocalEmailVerified`, and either refuse
 * the link or mint a second user. A `user` and an `account` with no workspace membership
 * is a person nobody can assign — this route's entire purpose, silently unmet. So the
 * user, the `custom` account and the membership land together or not at all.
 *
 * `emailVerified` is set for the same reason (decision 110): Better Auth's account-linking
 * path refuses to attach an OIDC account to a local user whose email is unverified, and
 * this user's email is verified by construction — Operon is the identity provider that
 * issued it.
 *
 * The membership is a direct INSERT rather than `auth.api.addMember`, which is what
 * `joinOperonWorkspace` uses on the login path. That endpoint runs on Better Auth's own
 * pool connection and cannot join this transaction, and a membership written outside it
 * would reintroduce exactly the orphan state above. What the row has to be is settled by
 * its only reader: `workspace/controllers/get-workspace-members.ts` selects
 * `workspace_member` joined to `user`, which is the assignee list R17 is about.
 *
 * ── IDEMPOTENCY AND CONCURRENCY ARE THE DATABASE'S, NOT THE HANDLER'S ────────────────
 *
 * There is deliberately NO read-before-write "does this person exist yet" check. Two
 * readers racing the OIDC first-login path both see nothing and both insert; the answer
 * is a unique-insert claim, which is what migration `0046` adds and what
 * `createOperonWorkspace` already does for the workspace slug. Two keys can fire:
 *
 *   1. **`user.email`** (`schema.ts`: `email: text("email").notNull().unique()`) — and it
 *      is the one that fires FIRST, because the `user` insert happens before the account
 *      upsert. A repeat provision, or one racing the OIDC creation, dies here.
 *   2. **`account (provider_id, account_id)`** — migration `0046`, the coordination point
 *      this route and the OIDC path share.
 *
 * On (2) the recovery is unambiguous: this transaction's own `user` is rolled back, the
 * winner is re-read by the subject, its membership is reconciled and its id is returned
 * with `created: false`.
 *
 * On (1) the recovery MUST NOT merge on the email alone (decision 122). An email is an
 * attribute an admin retypes; a subject is not. Treating a collision on it as identity
 * would hand one person's Kaneo history to another. So the user is re-read by email, that
 * user's `account` rows are read, and the id is returned ONLY when one of them carries
 * `(providerId: "custom", accountId: sub)`. A different subject on that email is a 409
 * naming both, with an `operon.identity_mismatch` line.
 *
 * ── "NO `custom` ACCOUNT AT ALL" IS A WAIT, NOT A VERDICT ────────────────────────────
 *
 * Round 3's correction (decision 122). The Drizzle adapter is constructed in `auth.ts`
 * with no `transaction` option and `@better-auth/drizzle-adapter` defaults it to `false`,
 * while Better Auth's `createOAuthUser` commits the `user` and THEN the `account` as two
 * separate statements. So a committed email with no account row is not a mismatch — it is
 * a live OIDC first login caught mid-write, and a terminal 409 there would call a
 * succeeding sign-in an identity theft. The recovery therefore re-reads that user's
 * account rows {@link ACCOUNT_RECOVERY_ATTEMPTS} more times,
 * {@link ACCOUNT_RECOVERY_DELAY_MS} apart, and succeeds the moment the matching row
 * appears — under the SAME provider-and-subject verification, never on the email. A row
 * that arrives carrying a different subject is the 409 immediately. Only an expired window
 * is a terminal 409, and that answer carries `waitedMs` so the window is visible in the
 * log rather than inferred. The wait holds no transaction, no row lock and no advisory
 * lock: this transaction's `user` insert is already rolled back before the first re-read.
 */

/** Three more reads, 500 ms apart — decision 122's frozen literals. */
const ACCOUNT_RECOVERY_ATTEMPTS = 3;
const ACCOUNT_RECOVERY_DELAY_MS = 500;

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/** The provider id Better Auth stores an Operon OIDC subject under. */
const OPERON_PROVIDER_ID = "custom";

type OperonRole = "admin" | "member";

/**
 * The account claim was lost to another writer — a repeat call, or the OIDC first-login
 * path racing this one. Thrown from inside the transaction so the `user` insert this
 * caller made is rolled back before the winner is re-read.
 */
class AccountClaimLost extends Error {}

type PostgresFailure = {
  code?: string;
  constraint?: string;
  detail?: string;
  cause?: unknown;
};

/**
 * The pg error under a drizzle one.
 *
 * `drizzle-orm@0.45` wraps every driver error in a `DrizzleQueryError` whose `cause` is
 * the `pg` error carrying `code` and `constraint`, and a transaction adds another layer.
 * Reading `error.code` directly finds nothing, which would send a unique violation down
 * the 500 path instead of the recovery.
 */
function postgresFailure(error: unknown): PostgresFailure | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as PostgresFailure;
    if (typeof candidate.code === "string") return candidate;
    current = candidate.cause;
  }
  return null;
}

/** Was this violation the `user.email` key rather than some other unique index? */
function isEmailViolation(failure: PostgresFailure): boolean {
  if (failure.code !== UNIQUE_VIOLATION) return false;
  const named = `${failure.constraint ?? ""} ${failure.detail ?? ""}`;
  return /email/i.test(named);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The workspace the service key's holder belongs to.
 *
 * The holder is the workspace OWNER the bootstrap minted under, and Operon runs exactly
 * one workspace (decision 49) — so "the holder's workspace" is both the right answer and
 * a self-authorizing one: this route can only ever add somebody to a workspace the
 * credential presenting the request is already in.
 */
async function workspaceIdForHolder(holderId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: workspaceUserTable.workspaceId })
    .from(workspaceUserTable)
    .where(eq(workspaceUserTable.userId, holderId))
    .orderBy(asc(workspaceUserTable.joinedAt))
    .limit(1);
  return row?.workspaceId ?? null;
}

/** The Kaneo user carrying this Operon subject, if any. */
async function userIdForSubject(sub: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: accountTable.userId })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.providerId, OPERON_PROVIDER_ID),
        eq(accountTable.accountId, sub),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Make sure the winner of a race is in the workspace at the role Operon says they hold.
 *
 * Same rule `joinOperonWorkspace` applies on the login path, and the same fixed point
 * (decision 115): an `owner` row is never demoted, because `createOrganization` makes the
 * bootstrap admin the OWNER and Operon's `role` claim is two-valued, so reconciling it
 * would leave the workspace with nobody who owns it.
 */
async function reconcileMembership(
  workspaceId: string,
  userId: string,
  role: OperonRole,
): Promise<void> {
  const [existing] = await db
    .select({
      id: workspaceUserTable.id,
      role: workspaceUserTable.role,
    })
    .from(workspaceUserTable)
    .where(
      and(
        eq(workspaceUserTable.workspaceId, workspaceId),
        eq(workspaceUserTable.userId, userId),
      ),
    )
    .limit(1);

  if (!existing) {
    await db.insert(workspaceUserTable).values({
      workspaceId,
      userId,
      role,
      joinedAt: new Date(),
    });
    return;
  }

  if (existing.role === "owner" || existing.role === role) return;

  await db
    .update(workspaceUserTable)
    .set({ role })
    .where(eq(workspaceUserTable.id, existing.id));
}

operonAccount.post("/user", async (c) => {
  const contextKey = c.get("apiKey") as ContextApiKey;
  if (!contextKey?.id) {
    throw new HTTPException(403, {
      message: "This route requires an API key, not a user session",
    });
  }

  const holderId = await resolveOperonServiceKeyHolder(contextKey.id);
  if (!holderId) {
    throw new HTTPException(403, {
      message: "This route requires the Operon service key",
    });
  }

  const body = (await c.req.json().catch(() => null)) as {
    sub?: unknown;
    email?: unknown;
    name?: unknown;
    role?: unknown;
  } | null;

  const sub = body?.sub;
  const email = body?.email;
  const name = body?.name;
  const role = body?.role;

  if (typeof sub !== "string" || !PUBKEY.test(sub)) {
    throw new HTTPException(400, {
      message: "sub must be a 64-character lowercase hex pubkey",
    });
  }
  if (typeof email !== "string" || email.trim() === "") {
    throw new HTTPException(400, { message: "email is required" });
  }
  if (typeof name !== "string" || name.trim() === "") {
    throw new HTTPException(400, { message: "name is required" });
  }
  if (role !== "admin" && role !== "member") {
    throw new HTTPException(400, { message: "role must be admin or member" });
  }

  const workspaceId = await workspaceIdForHolder(holderId);
  if (!workspaceId) {
    // 409 and not 500: the service is fine, the precondition is not. The Operon workspace
    // is created by the first admin's own sign-in, so a provision that arrives before it
    // has nowhere to put the membership — a fact Operon retries rather than a bug.
    throw new HTTPException(409, {
      message: "No workspace exists for the Operon service key's holder yet",
    });
  }

  try {
    const kaneoUserId = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(userTable)
        .values({
          name: name.trim(),
          email: email.trim(),
          // Decision 110 — see the header: an unverified email makes the first OIDC
          // sign-in either refuse the link or mint a second user.
          emailVerified: true,
        })
        .returning({ id: userTable.id });

      if (!user) throw new Error("the user insert returned no row");

      const [account] = await tx
        .insert(accountTable)
        .values({
          accountId: sub,
          providerId: OPERON_PROVIDER_ID,
          userId: user.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [accountTable.providerId, accountTable.accountId],
        })
        .returning({ id: accountTable.id });

      if (!account) throw new AccountClaimLost();

      await tx.insert(workspaceUserTable).values({
        workspaceId,
        userId: user.id,
        role,
        joinedAt: new Date(),
      });

      return user.id;
    });

    return c.json({ kaneoUserId, created: true }, 200);
  } catch (error) {
    if (error instanceof AccountClaimLost) {
      const winner = await userIdForSubject(sub);
      if (!winner) {
        // The claim was lost and the winner is gone again: a delete raced this call.
        // Answering 200 with somebody's id would be a lie, so this is a conflict.
        throw new HTTPException(409, {
          message: "Another writer claimed that subject and then released it",
        });
      }
      await reconcileMembership(workspaceId, winner, role);
      return c.json({ kaneoUserId: winner, created: false }, 200);
    }

    const failure = postgresFailure(error);
    if (!failure || !isEmailViolation(failure)) throw error;

    const [claimant] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, email.trim()))
      .limit(1);

    if (!claimant) {
      throw new HTTPException(409, {
        message: "Another writer claimed that email and then released it",
      });
    }

    let waitedMs = 0;
    for (let attempt = 0; attempt <= ACCOUNT_RECOVERY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await sleep(ACCOUNT_RECOVERY_DELAY_MS);
        waitedMs += ACCOUNT_RECOVERY_DELAY_MS;
      }

      const accounts = await db
        .select({ accountId: accountTable.accountId })
        .from(accountTable)
        .where(
          and(
            eq(accountTable.userId, claimant.id),
            eq(accountTable.providerId, OPERON_PROVIDER_ID),
          ),
        );

      if (accounts.some((row) => row.accountId === sub)) {
        await reconcileMembership(workspaceId, claimant.id, role);
        return c.json({ kaneoUserId: claimant.id, created: false }, 200);
      }

      const storedSub = accounts[0]?.accountId;
      if (storedSub) {
        // A subject arrived and it is somebody else's. The window buys time for the row
        // to appear, never permission to skip the check — so this is terminal at once.
        console.warn(
          `[operon] operon.identity_mismatch: email ${email} is held by kaneo user ${claimant.id} carrying subject ${storedSub}, not ${sub}`,
        );
        return c.json(
          {
            error: "operon.identity_mismatch",
            email,
            incomingSub: sub,
            storedSub,
            kaneoUserId: claimant.id,
          },
          409,
        );
      }
    }

    // The window closed with still no `custom` account. `waitedMs` is in the answer as
    // well as the log so the reader can tell an expired window from an instant refusal.
    console.warn(
      `[operon] operon.identity_mismatch: email ${email} is held by kaneo user ${claimant.id} with no custom account after ${waitedMs}ms; refusing to merge on the email alone`,
    );
    return c.json(
      {
        error: "operon.identity_mismatch",
        email,
        incomingSub: sub,
        storedSub: null,
        kaneoUserId: claimant.id,
        waitedMs,
      },
      409,
    );
  }
});

export default operonAccount;
