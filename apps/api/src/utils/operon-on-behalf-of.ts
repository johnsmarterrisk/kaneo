import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import db from "../database";
import { apikeyTable } from "../database/schema";

// Operon fork addition (spec S11, widened by Smart Desk D25): the on-behalf-of gate,
// shared by the Telegraph external-link write route and the task create / import
// routes. See `docs/fork-discipline.md` in the Operon repository.

const OPERON_SERVICE_MARKER = "operonService";
export const OPERON_ON_BEHALF_OF_HEADER = "X-Operon-On-Behalf-Of";

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
export async function requireOperonOnBehalfOf(c: Context, next: Next) {
  const apiKey = c.get("apiKey") as { id?: string } | undefined;
  // A browser session has no context key id: unchanged, header ignored.
  if (!apiKey?.id) return next();

  const [row] = await db
    .select({ metadata: apikeyTable.metadata })
    .from(apikeyTable)
    .where(eq(apikeyTable.id, apiKey.id))
    .limit(1);

  const metadata = parseJsonObject(row?.metadata ?? null);
  // An unmarked key: unchanged, header ignored.
  if (metadata?.[OPERON_SERVICE_MARKER] !== true) return next();

  const requested = c.req.header(OPERON_ON_BEHALF_OF_HEADER)?.trim();
  if (!requested) {
    return c.json(
      { message: `${OPERON_ON_BEHALF_OF_HEADER} is required` },
      400,
    );
  }

  c.set("userId", requested);
  return next();
}
