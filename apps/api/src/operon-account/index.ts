import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { accountTable } from "../database/schema";
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
 * Every `apiRouter().openapi(...)` route lands in the generated `apps/docs/openapi.json`,
 * and `apps/docs/**` is outside this fork's declared touch list — publishing a private
 * server-to-server hook in upstream's public API document would also be wrong on its own
 * terms. Registered as a plain handler it is reachable and authenticated exactly like every
 * other `/api` route while staying out of the spec. See `docs/fork-discipline.md` in the
 * Operon repository.
 *
 * ── THE GUARD ────────────────────────────────────────────────────────────────────────
 *
 * `api.use("*")` has already run `authenticateApiRequest`, so an unauthenticated caller
 * never reaches this handler. The extra check here is that the caller authenticated with an
 * **API key** — the least-privilege key Operon holds as `KANEO_API_KEY` — and not with a
 * browser session. No human should be able to re-point their own account at another
 * subject, and a session-authenticated request to this path is that attempt.
 *
 * The row is addressed by `userId`, never by the outgoing `accountId`: the user id is the
 * stable join Operon already records as `identities.kaneo_user_id`, so a retry after a
 * partial failure converges instead of hunting a pubkey nothing holds any more.
 */
const operonAccount = new Hono<{ Variables: BaseVariables }>();

const PUBKEY = /^[0-9a-f]{64}$/;

operonAccount.patch("/account-id", async (c) => {
  if (!c.get("apiKey")) {
    throw new HTTPException(403, {
      message: "This route requires an API key, not a user session",
    });
  }

  const body = (await c.req.json().catch(() => null)) as {
    kaneoUserId?: unknown;
    accountId?: unknown;
  } | null;

  const kaneoUserId = body?.kaneoUserId;
  const accountId = body?.accountId;

  if (typeof kaneoUserId !== "string" || kaneoUserId.trim() === "") {
    throw new HTTPException(400, { message: "kaneoUserId is required" });
  }
  if (typeof accountId !== "string" || !PUBKEY.test(accountId)) {
    throw new HTTPException(400, {
      message: "accountId must be a 64-character lowercase hex pubkey",
    });
  }

  const updated = await db
    .update(accountTable)
    .set({ accountId, updatedAt: new Date() })
    .where(
      and(
        eq(accountTable.userId, kaneoUserId),
        eq(accountTable.providerId, "custom"),
      ),
    )
    .returning({ id: accountTable.id });

  if (updated.length === 0) {
    // 404 rather than a cheerful 200: Operon treats a re-key that changed nothing as a
    // failed rotation and refuses to report the rotation complete.
    throw new HTTPException(404, {
      message: "No custom-provider account for that user",
    });
  }

  return c.json({ updated: updated.length, kaneoUserId, accountId }, 200);
});

export default operonAccount;
