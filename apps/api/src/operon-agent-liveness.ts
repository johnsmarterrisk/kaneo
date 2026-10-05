import { HTTPException } from "hono/http-exception";
import { metadataHasOperonServiceMarker, operonS2SChannel } from "./auth";
import { verifyApiKey } from "./utils/verify-api-key";

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

/**
 * Throws the 401 a disabled key gets on `/api/*` unless Operon vouches for this agent.
 * Callers on other paths catch it and answer what a disabled key gets there.
 * `keyId` is for the ids-only refusal log; it is never sent.
 */
export async function assertOperonAgentAlive(
  kaneoUserId: string,
  keyId: string,
): Promise<void> {
  const reason = await livenessFailure(kaneoUserId);
  if (!reason) return;
  console.warn(
    `[operon] operon.agent_key_not_alive: kaneo user ${kaneoUserId} key ${keyId} reason ${reason}`,
  );
  throw new HTTPException(401, { message: "Unauthorized" });
}
