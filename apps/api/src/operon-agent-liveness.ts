import { and, asc, eq, gt, isNull, like, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { metadataHasOperonServiceMarker, operonS2SChannel } from "./auth";
import db, { schema } from "./database";
import { apiKeyEnabledCondition, verifyApiKey } from "./utils/verify-api-key";

// ── Which keys are Operon credentials (agent-initiative D7, D13, D20) ──────────────────
//
// Here rather than in `auth.ts` so `mcp/index.ts` reaches it without a new `auth.ts`
// import: upstream's MCP unit tests replace `auth.ts` with a mock that exports only `auth`.

type VerifiedApiKey = NonNullable<
  Awaited<ReturnType<typeof verifyApiKey>>
>["key"];

/** Which Operon credential a VERIFIED key's `metadata` marks it as, if any. */
export function operonKeyKind(metadata: unknown): "service" | "agent" | null {
  // The plugin's historical double-stringified shape, tolerated as for the service marker.
  if (typeof metadata === "string") {
    try {
      return operonKeyKind(JSON.parse(metadata));
    } catch {
      return null;
    }
  }
  if (metadataHasOperonServiceMarker(metadata)) return "service";
  return metadata &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>).operonAgent === true
    ? "agent"
    : null;
}

/** Verify one presented string and say which Operon credential it is, if any. */
export async function classifyOperonKey(
  candidate: string,
): Promise<{ kind: "service" | "agent"; key: VerifiedApiKey } | null> {
  const verified = await verifyApiKey(candidate).catch(() => null);
  if (!verified?.valid || !verified.key) return null;
  const kind = operonKeyKind(verified.key.metadata);
  return kind ? { kind, key: verified.key } : null;
}

/**
 * Which Operon credentials (the service key, an agent key) are presented on this request?
 *
 * The question the `/api/auth/*` guard in `index.ts` asks, and it has to be asked of the
 * ROW rather than of the string: the prefix is a routing marker anyone can type, while
 * the `metadata` marker can only have been written by a server-side mint. A prefixed
 * string that does not verify is simply not a key and is left to Better Auth to refuse
 * as one.
 *
 * Both spellings are checked because `index.ts`'s existing `/auth/*` handler REWRITES a
 * `Authorization: Bearer <key>` into `x-api-key` before calling `auth.handler` — a guard
 * that only read `x-api-key` would be walked around by sending the same key as a bearer.
 * Every header's result is kept, one verify each (agent-initiative D7, D20): an agent key
 * must be found even when the other header holds something else.
 */
export async function classifyOperonRequestKeys(headers: Headers) {
  const candidates = [
    headers.get("x-api-key")?.trim(),
    headers
      .get("authorization")
      ?.match(/^Bearer\s+(\S+)$/i)?.[1]
      ?.trim(),
  ].filter((value): value is string => !!value);

  const presented: {
    kind: "service" | "agent";
    key: VerifiedApiKey;
    value: string;
  }[] = [];
  for (const candidate of candidates) {
    const classified = await classifyOperonKey(candidate);
    if (classified) presented.push({ ...classified, value: candidate });
  }
  return presented;
}

/**
 * Operon is the single authority on whether an agent is alive (Operon agent-initiative
 * spec D20, D21).
 *
 * Every path that accepts a verified `{ operonAgent: true }` key asks Operon's platform,
 * over the fork's existing signed channel, on EVERY request: no answer is cached, so a
 * disable takes effect on the next request whose check starts after it commits, with no
 * write to Initiative, through a fork outage, a maintenance hold or a restore.
 *
 * It FAILS CLOSED. Only a 2xx JSON body of exactly `{ active: true }` passes; a
 * `false`, any other status, a redirect, a network error, a timeout, a stalled or
 * unparseable body, a different shape, or an unset URL or secret all refuse. While the
 * platform is unreachable no agent works, and that is intended: humans and the service
 * key never come here. The reason is logged and never answered, so a caller cannot tell
 * which check failed.
 */
export const OPERON_AGENT_LIVENESS_TIMEOUT_MS = 2000;

type NotAliveReason =
  | "not_active"
  | "platform_status"
  | "unreachable"
  | "timeout"
  | "malformed"
  | "unconfigured";

async function livenessFailure(
  kaneoUserId: string,
): Promise<NotAliveReason | null> {
  const channel = operonS2SChannel();
  if (!channel) return "unconfigured";

  const body = JSON.stringify({
    kaneoUserId,
    timestamp: new Date().toISOString(),
  });
  const controller = new AbortController();
  // One abort for the whole exchange: the body read below is inside it, so a platform
  // that sends headers and then stalls is still refused at the 2 s mark.
  const timer = setTimeout(
    () => controller.abort(),
    OPERON_AGENT_LIVENESS_TIMEOUT_MS,
  );
  try {
    const response = await fetch(
      `${channel.base}/internal/kaneo/agent-active`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operon-Signature": channel.sign(body),
        },
        body,
        signal: controller.signal,
        // A redirect would replay a signed body at an address nobody vouched for.
        redirect: "manual",
      },
    );
    if (!response.ok) return "platform_status";
    let answer: unknown;
    try {
      answer = JSON.parse(await response.text());
    } catch {
      return controller.signal.aborted ? "timeout" : "malformed";
    }
    if (
      answer &&
      typeof answer === "object" &&
      !Array.isArray(answer) &&
      Object.keys(answer).length === 1 &&
      (answer as Record<string, unknown>).active === true
    ) {
      return null;
    }
    return (answer as Record<string, unknown> | null)?.active === false
      ? "not_active"
      : "malformed";
  } catch {
    return controller.signal.aborted ? "timeout" : "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

// ── The plain-member ceiling (agent-initiative D3, applied at mint AND at use) ─────────

/**
 * The workspace the service key's holder belongs to. The holder is the workspace OWNER
 * the bootstrap minted under, and Operon runs exactly one workspace (decision 49), so
 * this is "the Operon workspace". Moved here from `operon-account/index.ts` so the mint
 * route and every use of an agent key ask the same question.
 */
export async function workspaceIdForHolder(
  holderId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: schema.workspaceUserTable.workspaceId })
    .from(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.userId, holderId))
    .orderBy(asc(schema.workspaceUserTable.joinedAt))
    .limit(1);
  return row?.workspaceId ?? null;
}

/**
 * The mint route's test, shared: a key is for a PLAIN member only — a membership of the
 * Operon workspace whose role is exactly `member`, and not an instance admin. The key's
 * permission ceiling caps permissions, not access: an instance admin or a workspace
 * admin passes role-based access checks (private assets through
 * `validateWorkspaceAccess`, for one) that ignore the ceiling.
 */
export async function operonPlainMemberRefusal(
  workspaceId: string,
  kaneoUserId: string,
): Promise<"no_membership" | "not_plain_member" | null> {
  const [member] = await db
    .select({
      role: schema.workspaceUserTable.role,
      userRole: schema.userTable.role,
    })
    .from(schema.workspaceUserTable)
    .innerJoin(
      schema.userTable,
      eq(schema.userTable.id, schema.workspaceUserTable.userId),
    )
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, kaneoUserId),
      ),
    )
    .limit(1);
  if (!member) return "no_membership";
  if (member.role !== "member" || member.userRole === "admin") {
    return "not_plain_member";
  }
  return null;
}

/**
 * At USE time there is no presenting service key, so "the Operon workspace" is the
 * workspace of the holder of the instance's enabled, unexpired service key(s) — the same
 * holder the mint route resolved from the key that minted. No holder, or more than one,
 * resolves nothing, and the caller refuses (fail closed).
 */
async function operonWorkspaceIdAtUse(): Promise<string | null> {
  const rows = await db
    .select({
      referenceId: schema.apikeyTable.referenceId,
      userId: schema.apikeyTable.userId,
      metadata: schema.apikeyTable.metadata,
    })
    .from(schema.apikeyTable)
    .where(
      and(
        apiKeyEnabledCondition(),
        or(
          isNull(schema.apikeyTable.expiresAt),
          gt(schema.apikeyTable.expiresAt, new Date()),
        ),
        // A cheap pre-filter; the marker itself is re-checked on each row below.
        like(schema.apikeyTable.metadata, "%operonService%"),
      ),
    );
  const holders = new Set(
    rows
      .filter((row) => metadataHasOperonServiceMarker(row.metadata))
      .map((row) => row.referenceId || row.userId)
      .filter((id): id is string => !!id),
  );
  const [holderId] = holders;
  if (holders.size !== 1 || !holderId) return null;
  return workspaceIdForHolder(holderId);
}

type CeilingReason = "no_operon_workspace" | "member_check_failed";

async function memberCeilingFailure(
  kaneoUserId: string,
): Promise<CeilingReason | "no_membership" | "not_plain_member" | null> {
  try {
    const workspaceId = await operonWorkspaceIdAtUse();
    if (!workspaceId) return "no_operon_workspace";
    return await operonPlainMemberRefusal(workspaceId, kaneoUserId);
  } catch {
    // A database error refuses like a dead key rather than escaping as a 500.
    return "member_check_failed";
  }
}

/**
 * Throws the 401 a disabled key gets on `/api/*` unless Operon vouches for this agent
 * AND its user is still a plain member (the mint route's test, re-applied on every use,
 * so an agent raised to workspace admin or instance admin after its key was minted is
 * refused, never served above the member ceiling). Callers on other paths catch it and
 * answer what a disabled key gets there. `keyId` is for the ids-only refusal log; it is
 * never sent.
 */
export async function assertOperonAgentAlive(
  kaneoUserId: string,
  keyId: string,
): Promise<void> {
  const reason =
    (await livenessFailure(kaneoUserId)) ??
    (await memberCeilingFailure(kaneoUserId));
  if (!reason) return;
  console.warn(
    `[operon] operon.agent_key_not_alive: kaneo user ${kaneoUserId} key ${keyId} reason ${reason}`,
  );
  throw new HTTPException(401, { message: "Unauthorized" });
}
