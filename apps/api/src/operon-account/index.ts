import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  accountTable,
  apikeyTable,
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

export default operonAccount;
