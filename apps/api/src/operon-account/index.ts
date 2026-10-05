import { and, asc, eq, inArray, ne, or } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  mintOperonAgentApiKey,
  OPERON_ACCOUNT_RECOVERY_ATTEMPTS,
  OPERON_ACCOUNT_RECOVERY_DELAY_MS,
  OPERON_PROVIDER_ID,
  type PostgresFailure,
  postgresFailure,
  reconcileWorkspaceMemberRole,
  UNIQUE_VIOLATION,
} from "../auth";
import db from "../database";
import {
  accountTable,
  activityTable,
  apikeyTable,
  projectTable,
  sessionTable,
  taskTable,
  teamMemberTable,
  teamTable,
  userTable,
  workspaceUserTable,
} from "../database/schema";
import { publishEvent } from "../events";
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
 * account rows {@link OPERON_ACCOUNT_RECOVERY_ATTEMPTS} more times,
 * {@link OPERON_ACCOUNT_RECOVERY_DELAY_MS} apart, and succeeds the moment the matching row
 * appears — under the SAME provider-and-subject verification, never on the email. A row
 * that arrives carrying a different subject is the 409 immediately. Only an expired window
 * is a terminal 409, and that answer carries `waitedMs` so the window is visible in the
 * log rather than inferred. The wait holds no transaction, no row lock and no advisory
 * lock: this transaction's `user` insert is already rolled back before the first re-read.
 */

type OperonRole = "admin" | "member";

/**
 * The account claim was lost to another writer — a repeat call, or the OIDC first-login
 * path racing this one. Thrown from inside the transaction so the `user` insert this
 * caller made is rolled back before the winner is re-read.
 */
class AccountClaimLost extends Error {}

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
 *
 * ── THERE IS NO "DOES A MEMBERSHIP EXIST" CHECK HERE ANY MORE (round-1 finding 1) ────
 *
 * There was, and it was the same read-then-insert `createOperonWorkspace` already refuses
 * to make for the workspace slug and this route already refuses to make for the account
 * subject. Two writers — this one and Better Auth's `addMember` on the login path — both
 * read "no membership" and both inserted, and NOTHING in upstream's schema forbade the
 * second row. The damage is not the duplicate itself but what it does to the reconcile
 * below: it updates the row it read, so a later demotion from `admin` to `member` moved
 * one row and left the other still saying `admin`, and the demotion reported success
 * without happening.
 *
 * Migration `0047` makes `(workspace_id, user_id)` unique, and the insert claims it
 * through `ON CONFLICT DO NOTHING` rather than a `try/catch` on SQLSTATE 23505 — the
 * conflict is then resolved by Postgres inside the statement, so it can never abort an
 * enclosing transaction the way a raised unique violation would. Either way the loser
 * falls through to the same reconcile, which is the recovery: re-read the winner's row
 * and put the role right.
 */
async function reconcileMembership(
  workspaceId: string,
  userId: string,
  role: OperonRole,
): Promise<void> {
  const inserted = await db
    .insert(workspaceUserTable)
    .values({
      workspaceId,
      userId,
      role,
      joinedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [workspaceUserTable.workspaceId, workspaceUserTable.userId],
    })
    .returning({ id: workspaceUserTable.id });

  if (inserted.length > 0) return;

  await reconcileWorkspaceMemberRole(workspaceId, userId, role);
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
    image?: unknown;
  } | null;

  const sub = body?.sub;
  const email = body?.email;
  const name = body?.name;
  const role = body?.role;
  const image = body?.image;

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
  // Operon profile avatars (R10): optional `image`, Operon's image address for this `sub`.
  // Absent is fine; anything present must be an http(s) URL of at most 2048 characters.
  if (
    image !== undefined &&
    (typeof image !== "string" ||
      image.length > 2048 ||
      !/^https?:\/\/\S+$/.test(image))
  ) {
    throw new HTTPException(400, {
      message: "image must be an http(s) URL of at most 2048 characters",
    });
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
          image: image ?? null,
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
    for (
      let attempt = 0;
      attempt <= OPERON_ACCOUNT_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      if (attempt > 0) {
        await sleep(OPERON_ACCOUNT_RECOVERY_DELAY_MS);
        waitedMs += OPERON_ACCOUNT_RECOVERY_DELAY_MS;
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

/**
 * Operon fork route — remove a revoked person's workspace membership on Operon's word
 * (Operon spec `revoke-initiative-membership-spec.md` R1–R7).
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────────────
 *
 * Operon's "Revoke access" locks a person out of Operon, but their `workspace_member`
 * row here stayed, so they kept appearing in the task assignee picker, and Initiative's
 * Members page is read-only under Operon — nobody could remove them by hand. Operon's
 * `POST /auth/revoke` (and its 5-minute provisioner backstop) now call this route.
 *
 * ── WHY NOT `auth.api.removeMember` ──────────────────────────────────────────────────
 *
 * Better Auth's `/organization/remove-member` is session-only: it runs `orgMiddleware` and
 * `orgSessionMiddleware`, reads the CALLER's own member row and checks `member: ["delete"]`.
 * Our caller is the Operon service key, which this fork deliberately refuses on
 * `/api/auth/*`, so that endpoint cannot be called from here. What it does underneath is
 * the organization adapter's `deleteMember`: delete the `member` row, then (teams are
 * enabled) the user's `teamMember` rows for that organization's teams. That adapter is not
 * exported, so its two statements are transcribed below — the same precedent `POST /user`
 * set when it wrote the membership with a direct INSERT instead of `auth.api.addMember`.
 * `afterRemoveMember` only runs `syncWorkspaceSeats`, a no-op with billing off, so it is
 * not called.
 *
 * ── THE OWNER RULE IS IN THE DELETE'S PREDICATE ──────────────────────────────────────
 *
 * Same fixed point as `reconcileWorkspaceMemberRole` in `auth.ts`: the workspace OWNER is
 * never removed, and a rule checked only in application memory is not one. The DELETE
 * names the row id, the workspace, the user, the role this call READ and `role <> 'owner'`;
 * a promotion landing between the read and the delete makes it match zero rows, and zero
 * rows is the re-read signal — owner → 409, absent → idempotent success. The service key's
 * holder is refused outright for the same reason: removing it would strand Operon's key.
 *
 * ── SESSIONS GO TOO, WHATEVER THE MEMBERSHIP SAID ────────────────────────────────────
 *
 * Every `session` row for an Operon-managed person (one carrying the `custom`-provider
 * account `POST /user` links) is deleted, including when the membership was already
 * absent and when they belong to another workspace. An instance admin passes
 * `hasWorkspacePermission` / `validateWorkspaceAccess` BEFORE the membership lookup, and
 * `bearer()` / device clients authenticate by `session` rows, so a live session would
 * outlive the revoke otherwise. The `user` and `account` rows are never touched: tasks,
 * comments and activity keep their author. This workspace's tasks assigned to the person
 * are unassigned (open-items 182), each with an `unassigned` activity row.
 */
class MembershipChangedTwice extends Error {}

class ProtectedMember extends Error {}

/** Better Auth stores multi-role members as a comma-separated role string. */
function hasOwnerRole(role: string): boolean {
  return role.split(",").some((part) => part.trim() === "owner");
}

operonAccount.post("/remove-member", async (c) => {
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
  } | null;
  const kaneoUserId = body?.kaneoUserId;
  if (typeof kaneoUserId !== "string" || kaneoUserId.trim() === "") {
    throw new HTTPException(400, { message: "kaneoUserId is required" });
  }

  const workspaceId = await workspaceIdForHolder(holderId);
  if (!workspaceId) {
    throw new HTTPException(409, {
      message: "No workspace exists for the Operon service key's holder yet",
    });
  }

  if (kaneoUserId === holderId) {
    console.warn(
      `[operon] operon.member_remove_refused: kaneo user ${kaneoUserId} holds the Operon service key`,
    );
    throw new HTTPException(409, {
      message: "The Operon service key's holder cannot be removed",
    });
  }

  // Only a person Operon provisioned is Operon's to remove. `POST /user` links every
  // Operon-managed user with a `custom`-provider account row (kept through a re-key and
  // never deleted by this route), so that row is the proof. Any other id — unknown, or an
  // Initiative user Operon never managed — answers removed 0 with NO side effects: the
  // session delete below would otherwise let the service key sign an unrelated user out
  // of every other workspace.
  const [operonAccountRow] = await db
    .select({ id: accountTable.id })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.userId, kaneoUserId),
        eq(accountTable.providerId, OPERON_PROVIDER_ID),
      ),
    )
    .limit(1);
  if (!operonAccountRow) {
    console.warn(
      `[operon] operon.member_remove_skipped: kaneo user ${kaneoUserId} is not an Operon-managed user; nothing was touched`,
    );
    return c.json(
      { kaneoUserId, removed: 0, sessionsRevoked: 0, tasksUnassigned: 0 },
      200,
    );
  }

  let result: {
    removed: number;
    sessionsRevoked: number;
    unassignedTasks: { id: string; projectId: string; title: string }[];
  };
  try {
    result = await db.transaction(async (tx) => {
      let removed = 0;
      let settled = false;
      for (let attempt = 0; attempt < 2 && !settled; attempt += 1) {
        const [member] = await tx
          .select({
            id: workspaceUserTable.id,
            role: workspaceUserTable.role,
          })
          .from(workspaceUserTable)
          .where(
            and(
              eq(workspaceUserTable.workspaceId, workspaceId),
              eq(workspaceUserTable.userId, kaneoUserId),
            ),
          )
          .limit(1);

        if (!member) {
          settled = true;
          break;
        }
        if (hasOwnerRole(member.role)) throw new ProtectedMember();

        const deleted = await tx
          .delete(workspaceUserTable)
          .where(
            and(
              eq(workspaceUserTable.id, member.id),
              eq(workspaceUserTable.workspaceId, workspaceId),
              eq(workspaceUserTable.userId, kaneoUserId),
              eq(workspaceUserTable.role, member.role),
              ne(workspaceUserTable.role, "owner"),
            ),
          )
          .returning({ id: workspaceUserTable.id });

        if (deleted.length > 0) {
          removed = deleted.length;
          settled = true;
        }
      }
      if (!settled) throw new MembershipChangedTwice();

      // The adapter's second statement: this user's team rows for THIS workspace's teams.
      await tx
        .delete(teamMemberTable)
        .where(
          and(
            eq(teamMemberTable.userId, kaneoUserId),
            inArray(
              teamMemberTable.teamId,
              tx
                .select({ id: teamTable.id })
                .from(teamTable)
                .where(eq(teamTable.workspaceId, workspaceId)),
            ),
          ),
        );

      // Operon open-items 182 (John, 2026-09-30): the `user` row is kept, so a task
      // assigned to the removed person would keep them as assignee while the picker can
      // no longer show them. Unassign ONLY this workspace's tasks (project → workspace);
      // their tasks in any other workspace are not Operon's to touch. Runs even when the
      // membership was already absent, and a second call finds nothing (0).
      const unassigned = await tx
        .update(taskTable)
        .set({ userId: null })
        .where(
          and(
            eq(taskTable.userId, kaneoUserId),
            inArray(
              taskTable.projectId,
              tx
                .select({ id: projectTable.id })
                .from(projectTable)
                .where(eq(projectTable.workspaceId, workspaceId)),
            ),
          ),
        )
        .returning({
          id: taskTable.id,
          projectId: taskTable.projectId,
          title: taskTable.title,
        });

      // The same `unassigned` activity row `update-task-assignee` writes through the
      // `task.unassigned` subscriber, with the service key's holder as actor — the user
      // every Operon service-key write already acts as. Inserted here so it commits (or
      // rolls back) with the unassignment itself; `task.unassigned` is published only after
      // the commit (below), marked `activityRecorded` so the activity subscriber skips it.
      if (unassigned.length > 0) {
        await tx.insert(activityTable).values(
          unassigned.map((task) => ({
            taskId: task.id,
            type: "unassigned",
            userId: holderId,
            content: null,
            eventData: {},
          })),
        );
      }

      const sessions = await tx
        .delete(sessionTable)
        .where(eq(sessionTable.userId, kaneoUserId))
        .returning({ id: sessionTable.id });

      return {
        removed,
        sessionsRevoked: sessions.length,
        unassignedTasks: unassigned,
      };
    });
  } catch (error) {
    if (error instanceof ProtectedMember) {
      console.warn(
        `[operon] operon.member_remove_refused: kaneo user ${kaneoUserId} owns workspace ${workspaceId}`,
      );
      throw new HTTPException(409, {
        message: "The workspace owner cannot be removed",
      });
    }
    if (error instanceof MembershipChangedTwice) {
      console.warn(
        `[operon] operon.member_remove_conflict: membership for kaneo user ${kaneoUserId} changed twice under the remove; nothing was removed`,
      );
      throw new HTTPException(409, {
        message: "The membership changed while it was being removed; retry",
      });
    }
    throw error;
  }

  const { removed, sessionsRevoked, unassignedTasks } = result;
  const tasksUnassigned = unassignedTasks.length;
  // After the commit, never inside it: the same `task.unassigned` event the normal
  // unassign path publishes, once per task, so open Initiative views refresh and
  // webhook subscribers (Operon's included) hear of it. The activity row is already
  // written in the transaction, hence `activityRecorded`.
  for (const task of unassignedTasks) {
    await publishEvent("task.unassigned", {
      taskId: task.id,
      projectId: task.projectId,
      userId: holderId,
      title: task.title,
      type: "unassigned",
      activityRecorded: true,
    });
  }

  console.log(
    `[operon] operon.member_removed: kaneo user ${kaneoUserId} workspace ${workspaceId} removed=${removed} sessions_revoked=${sessionsRevoked} tasks_unassigned=${tasksUnassigned}`,
  );
  return c.json(
    { kaneoUserId, removed, sessionsRevoked, tasksUnassigned },
    200,
  );
});

/**
 * Operon fork routes — an Operon agent's own Initiative key (Operon agent-initiative spec
 * D3, D11). Same guard as `remove-member`: the Operon service key only, Operon-managed
 * users only, never the holder. Mint refuses anyone whose workspace role is not exactly
 * `member` and any instance admin, so an agent key never does more than a member. Revoke
 * disables every enabled key of the user, idempotently, and removes nothing else.
 */
async function requireServiceKeyAndAgentUser(
  c: Context<{ Variables: BaseVariables }>,
  action: "mint" | "revoke",
) {
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
  } | null;
  const kaneoUserId = body?.kaneoUserId;
  if (typeof kaneoUserId !== "string" || kaneoUserId.trim() === "") {
    throw new HTTPException(400, { message: "kaneoUserId is required" });
  }

  const refuse = (status: 404 | 409, reason: string, message: string) => {
    console.warn(
      `[operon] operon.agent_key_refused: kaneo user ${kaneoUserId} key ${contextKey.id} action ${action} reason ${reason}`,
    );
    return new HTTPException(status, { message });
  };
  if (kaneoUserId === holderId) {
    throw refuse(
      409,
      "holder",
      "The Operon service key's holder cannot hold an agent key",
    );
  }
  // `remove-member`'s proof that Operon provisioned this person: the `custom` account row.
  const [operonAccountRow] = await db
    .select({ id: accountTable.id })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.userId, kaneoUserId),
        eq(accountTable.providerId, OPERON_PROVIDER_ID),
      ),
    )
    .limit(1);
  if (!operonAccountRow) {
    throw refuse(404, "not_operon_managed", "Not an Operon-managed user");
  }
  return { holderId, kaneoUserId, refuse };
}

operonAccount.post("/agent-key", async (c) => {
  const { holderId, kaneoUserId, refuse } = await requireServiceKeyAndAgentUser(
    c,
    "mint",
  );
  const workspaceId = await workspaceIdForHolder(holderId);
  if (!workspaceId) {
    throw new HTTPException(409, {
      message: "No workspace exists for the Operon service key's holder yet",
    });
  }
  const [member] = await db
    .select({ role: workspaceUserTable.role, userRole: userTable.role })
    .from(workspaceUserTable)
    .innerJoin(userTable, eq(userTable.id, workspaceUserTable.userId))
    .where(
      and(
        eq(workspaceUserTable.workspaceId, workspaceId),
        eq(workspaceUserTable.userId, kaneoUserId),
      ),
    )
    .limit(1);
  if (!member) {
    throw refuse(404, "no_membership", "Not a member of the Operon workspace");
  }
  // The ceiling caps permissions, not access: an instance admin passes workspace access
  // checks without a membership (see `remove-member`), so only a plain member gets a key.
  if (member.role !== "member" || member.userRole === "admin") {
    throw refuse(
      409,
      "not_plain_member",
      "An agent key is minted only for a plain member",
    );
  }

  const minted = await mintOperonAgentApiKey(kaneoUserId);
  if (!minted) {
    throw new HTTPException(500, { message: "The agent key was not minted" });
  }
  console.log(
    `[operon] operon.agent_key_minted: kaneo user ${kaneoUserId} key ${minted.id}`,
  );
  // The answer carries the key itself: never cached anywhere on the way back.
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      kaneoUserId,
      key: minted.key,
      keyId: minted.id,
      expiresAt: minted.expiresAt,
    },
    200,
  );
});

operonAccount.post("/agent-key/revoke", async (c) => {
  const { kaneoUserId } = await requireServiceKeyAndAgentUser(c, "revoke");
  const revoked = await db
    .update(apikeyTable)
    .set({ enabled: false })
    .where(
      and(
        or(
          eq(apikeyTable.referenceId, kaneoUserId),
          eq(apikeyTable.userId, kaneoUserId),
        ),
        eq(apikeyTable.enabled, true),
      ),
    )
    .returning({ id: apikeyTable.id });
  for (const row of revoked) {
    console.log(
      `[operon] operon.agent_key_revoked: kaneo user ${kaneoUserId} key ${row.id}`,
    );
  }
  return c.json({ kaneoUserId, revoked: revoked.length }, 200);
});

export default operonAccount;
