import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { apikeyTable, userTable, workspaceUserTable } from "../database/schema";

// Operon fork addition (spec S11, widened by Smart Desk D25): the on-behalf-of gate,
// shared by the Telegraph external-link write route and the task create / import
// routes. See `docs/fork-discipline.md` in the Operon repository.

const OPERON_SERVICE_MARKER = "operonService";
export const OPERON_ON_BEHALF_OF_HEADER = "X-Operon-On-Behalf-Of";
// Smart Desk F0b (D2): the keyed task create. Honoured for the marked key only.
export const OPERON_IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const OPERON_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    // The api-key plugin has shipped double-stringified metadata in the past; a
    // second parse costs nothing and means a legacy row is read rather than
    // silently failing the marker check.
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
 * Operon's service key is minted against ONE user id — the workspace owner — so a
 * naive server-side call would perform every user's write AS THE OWNER, silently
 * granting a Kaneo viewer a write a viewer is refused. A request authenticated by a
 * key whose ROW carries the unforgeable `{ operonService: true }` marker therefore
 * MUST name the user it acts for in `X-Operon-On-Behalf-Of: <kaneo user id>`; the
 * gate rebinds `c.set("userId", …)` BEFORE `requireWorkspacePermission` runs, so
 * BOTH the API key ceiling and the initiating user's role must pass, and the task
 * handlers' `currentUserId: c.get("userId")` records that user as the actor. A
 * marked key with no header is refused with 400 rather than falling back to the
 * owner's authority.
 *
 * THE MARKER IS NOT IN THE REQUEST CONTEXT, and that is the trap this gate exists
 * to avoid. `authenticateApiRequest` projects only `{id, userId, enabled,
 * permissions}` into `c.get("apiKey")`, so reading `c.get("apiKey").metadata`
 * would evaluate falsy and silently ignore the header on the genuine service key.
 * The row is re-read by id instead, exactly as `resolveOperonServiceKeyHolder`
 * (`apps/api/src/operon-account/index.ts`) does. The marker escapes client control
 * because `hooks.before` refuses client-supplied metadata, so no caller can mint
 * themselves a marked key; the header is IGNORED, never trusted, on any credential
 * whose row does not carry it, and on every browser session.
 */
/** True when the request's API key ROW carries Operon's server-minted marker. */
async function isOperonServiceKey(c: Context) {
  const apiKey = c.get("apiKey") as { id?: string } | undefined;
  // A browser session has no context key id.
  if (!apiKey?.id) return false;

  const [row] = await db
    .select({ metadata: apikeyTable.metadata })
    .from(apikeyTable)
    .where(eq(apikeyTable.id, apiKey.id))
    .limit(1);

  return (
    parseJsonObject(row?.metadata ?? null)?.[OPERON_SERVICE_MARKER] === true
  );
}

export async function requireOperonOnBehalfOf(c: Context, next: Next) {
  // Sessions and unmarked keys: unchanged, header ignored.
  if (!(await isOperonServiceKey(c))) return next();

  // Only a key carrying the widened ceiling may act for anyone. A marked key minted
  // before D25 is refused rather than falling back to its owner's authority.
  const apiKey = c.get("apiKey") as
    | { permissions?: Record<string, string[]> | null }
    | undefined;
  if (!apiKey?.permissions?.task?.includes("create")) {
    return c.json(
      { message: "The Operon service key must be re-minted (task:create)" },
      403,
    );
  }

  const requested = c.req.header(OPERON_ON_BEHALF_OF_HEADER)?.trim();
  if (!requested) {
    return c.json(
      { message: `${OPERON_ON_BEHALF_OF_HEADER} is required` },
      400,
    );
  }

  // The named user must exist AND be a member of THIS workspace. Without this an
  // instance admin — whom `hasWorkspacePermission` passes before its membership
  // lookup — could be named into a workspace they do not belong to.
  const [member] = await db
    .select({ userId: workspaceUserTable.userId })
    .from(workspaceUserTable)
    .innerJoin(userTable, eq(userTable.id, workspaceUserTable.userId))
    .where(
      and(
        eq(workspaceUserTable.workspaceId, c.get("workspaceId")),
        eq(workspaceUserTable.userId, requested),
      ),
    )
    .limit(1);
  if (!member) {
    return c.json(
      { message: "The named user is not a member of this workspace" },
      403,
    );
  }

  c.set("userId", requested);
  // F0b: the verified mark, recorded so the task-create handler can honour
  // `Idempotency-Key` without re-reading the key's row (isOperonServiceKey stays
  // private). Set ONLY here, after every check passed.
  c.set("operonServiceKey", true);
  return next();
}

/**
 * The `Idempotency-Key` of a keyed task create (Smart Desk F0b, F1/F2), or undefined.
 * Read only when `requireOperonOnBehalfOf` recorded the marked key; for any other
 * caller the header is ignored and the create behaves as upstream built it. A key
 * outside 1–200 characters of `[A-Za-z0-9:_-]` is refused 400 before anything is
 * created.
 */
export function readOperonIdempotencyKey(c: Context): string | undefined {
  if (c.get("operonServiceKey") !== true) return undefined;
  const key = c.req.header(OPERON_IDEMPOTENCY_KEY_HEADER);
  if (key === undefined) return undefined;
  if (!OPERON_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new HTTPException(400, {
      message: `${OPERON_IDEMPOTENCY_KEY_HEADER} must be 1-200 characters of A-Z, a-z, 0-9, ':', '_' or '-'`,
    });
  }
  return key;
}

/**
 * The widened ceiling (`task:create`) also satisfies upstream's GitHub and Gitea
 * issue-import routes, which D25 does not name and which take no on-behalf-of user.
 * The marked service key is refused on them outright.
 */
export async function refuseOperonServiceKey(c: Context, next: Next) {
  if (await isOperonServiceKey(c)) {
    return c.json(
      { message: "The Operon service key may not call this route" },
      403,
    );
  }
  return next();
}
