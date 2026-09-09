import { createHmac, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";

/**
 * Operon fork route — THE MAINTENANCE BARRIER'S FORK HALF
 * (Operon spec R25, R32, G10a, decisions 34, 50, 51 and 54).
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────────────
 *
 * Operon takes a quiesced window before it dumps its two databases, because the two stores
 * are in different Postgres instances with no transaction between them and a writer that
 * touches both is a writer a dump pair can straddle. Four of the five cross-store writers
 * are Operon's own and Operon can simply stop admitting them. **The fifth begins HERE**:
 * `auth.ts`'s sign-in path mints or revokes an Initiative API key and delivers it to
 * Operon, which persists it encrypted — a row in each store, initiated in the fork.
 *
 * A flag alone does not close it. Operon's acknowledgement gains `maintenance: true` and
 * the sign-in path defers on it (that half is in `auth.ts`), but a sign-in that read
 * `serviceKeyValid: false` from an ack sent BEFORE the flag was taken is already past it:
 * it re-checks inside `withOperonServiceKeyLock` and then revokes, mints and delivers
 * regardless. So the fork also has to ACCOUNT for what it has already admitted, and let
 * Operon read that account. That is this module.
 *
 * ── THE THREE NUMBERS, AND WHY THE THIRD IS NOT A NUMBER ─────────────────────────────
 *
 *   * `maintenance` — the last thing Operon TOLD this fork, so an acquisition can confirm
 *     the fork has actually SEEN the flag rather than assuming the next sign-in will.
 *   * `credentialOpsInFlight` — incremented when `withOperonServiceKeyLock` grants the
 *     advisory lock and decremented only after `postOperonKaneoUser` has RETURNED, so the
 *     delivery is inside the counted region and not after it. Every early return and every
 *     throw decrements, because a counter that leaks on an error path is a permanent drain
 *     failure — one login that threw would 503 Operon's reissues for ever.
 *   * `unresolvedDeliveries` — and this is round 3's blocker.
 *     `postOperonKaneoUser` aborts its own request after `OPERON_S2S_TIMEOUT_MS`
 *     (`auth.ts`, ten seconds) and returns `null` from its `catch`. The abort closes the
 *     fork's socket and tells Operon NOTHING: the credential transaction Operon opened is
 *     still on its way to its own commit. Decrementing on that `null` would report a drain
 *     that has not happened, and Operon would start dumping over an open cross-store write.
 *     **So a delivery that ends without an HTTP status is not decremented to zero — it is
 *     recorded `unresolved` by its `deliveryId`**, and it stays unresolved until Operon,
 *     which is the only party that can see its own store, posts a verdict.
 *
 * A STATUS IS AN ANSWER. A 4xx (Operon's replay 409, or a 401) wrote nothing; a 2xx wrote
 * everything, even when its body will not parse. Both decrement normally and record nothing
 * unresolved. "Unknown" is exactly and only the `catch` path.
 *
 * ── WHY THE STATE IS PROCESS-LOCAL AND THAT IS CORRECT ───────────────────────────────
 *
 * It is an account of what THIS process has admitted and not yet finished. A restart ends
 * every operation it was counting — the sockets close with the process — so a counter that
 * survived a restart would be a counter that could only ever be wrong in the direction that
 * blocks backups for ever. Operon's acquisition already fails visibly on a fork it cannot
 * read; a fork that has just restarted answers zero, which is the truth.
 *
 * ── WHY THE TWO ROUTES ARE HMAC-VERIFIED WHEN NOTHING ELSE HERE IS ───────────────────
 *
 * This is the Operon-to-fork direction, and it is the direction with **no authentication
 * today**: the fork-to-Operon callback has been HMAC-signed with `OPERON_KANEO_S2S_SECRET`
 * since A5, and Operon's reply to it is a plain `res.json` the fork parses unverified
 * (decision 54 withdraws the draft's claim that it was signed, and deliberately does not
 * add response signing — the reply arrives on the connection this fork opened to a name
 * inside `operon-net`). Signing the new direction with the SAME secret and the same
 * algorithm is what makes the channel genuinely MUTUALLY authenticated, and it costs no new
 * configuration on either side.
 *
 * The routes are mounted BEFORE `api.use("*")` in `apps/api/src/index.ts`, exactly as
 * `POST /github-integration/webhook` is, because their caller holds an HMAC and not a Kaneo
 * API key — see the comment at the mount. **Neither takes a lock of its own**, so neither
 * can itself become the thing that never drains.
 *
 * See `docs/fork-discipline.md` §3 row 9 in the Operon repository.
 */

/** The header Operon signs with, and the one the fork already signs its own callbacks with. */
export const OPERON_SIGNATURE_HEADER = "x-operon-signature";

/** The signed instant, ISO-8601. Part of the canonical string, so it cannot be swapped. */
export const OPERON_TIMESTAMP_HEADER = "x-operon-timestamp";

/**
 * How far a signed request's timestamp may sit from this clock, either way.
 *
 * The same five minutes Operon's own receiver tolerates
 * (`platform-service/src/identity/internal-kaneo.js`, `MAX_DELIVERY_SKEW_MS`), so the two
 * directions of one channel do not disagree about what "recent" means. It is also the whole
 * of the replay guard, and that is sufficient here rather than lazy: `GET
 * /maintenance-state` is a read, and `POST /resolve-deliveries` clears ids that are already
 * gone on a second application, so a replay inside the window changes nothing either way.
 */
export const OPERON_MAX_SIGNATURE_SKEW_MS = 5 * 60 * 1000;

/**
 * How long an observed `maintenance: true` is believed when Operon sends no
 * `retry_after_s`, and the ceiling on how long any hint is believed.
 *
 * A deferral that never lifts is an outage: if Operon is killed while the flag is held,
 * nothing will ever send this fork a `maintenance: false`, and a fork that deferred for
 * ever would refuse to repair a missing service key permanently. So the observation
 * EXPIRES, and the next sign-in after it does the work — which is precisely what
 * "honouring `retry_after_s`" means on this side.
 */
export const OPERON_MAINTENANCE_DEFAULT_TTL_MS = 15 * 60 * 1000;

/** The ceiling on a `retry_after_s` hint, so a bad number cannot wedge the fork for a day. */
export const OPERON_MAINTENANCE_MAX_TTL_MS = 60 * 60 * 1000;

/** The verdicts Operon may post about an unresolved delivery (decision 54). */
export type OperonDeliveryVerdict = "settled" | "absent";

type ObservedMaintenance = {
  held: boolean;
  retryAfterS: number | null;
  /** `Date.now()` when the ack carrying it was parsed. */
  observedAt: number;
  /** When the observation stops being believed. */
  expiresAt: number;
};

const NOT_HELD: ObservedMaintenance = {
  held: false,
  retryAfterS: null,
  observedAt: 0,
  expiresAt: 0,
};

let credentialOpsInFlight = 0;
let observedMaintenance: ObservedMaintenance = NOT_HELD;
/** `deliveryId` -> the instant it was recorded. Insertion-ordered, so the route is stable. */
const unresolvedDeliveries = new Map<string, number>();

/**
 * Record what Operon's acknowledgement said about its maintenance window.
 *
 * Called from `postOperonKaneoUser` on every ack it manages to parse. A `null` ack — an
 * unreachable Operon, or a body that would not parse — changes NOTHING: silence is not
 * evidence that a window closed, and treating it as such is how a fork would revoke a
 * credential in the middle of a dump.
 */
export function observeOperonMaintenance(
  ack: {
    maintenance?: boolean;
    retry_after_s?: number;
  } | null,
): void {
  if (!ack || typeof ack !== "object") return;

  if (ack.maintenance !== true) {
    // An explicit `false`, or an older Operon that does not carry the field at all. Both
    // mean "not quiescing", which is the state this fork must return to the moment the
    // window closes — otherwise the deferral would outlive the backup by a TTL.
    observedMaintenance = NOT_HELD;
    return;
  }

  const hint =
    typeof ack.retry_after_s === "number" &&
    Number.isFinite(ack.retry_after_s) &&
    ack.retry_after_s > 0
      ? ack.retry_after_s
      : null;
  const now = Date.now();
  const ttl = hint
    ? Math.min(hint * 1000, OPERON_MAINTENANCE_MAX_TTL_MS)
    : OPERON_MAINTENANCE_DEFAULT_TTL_MS;

  observedMaintenance = {
    held: true,
    retryAfterS: hint,
    observedAt: now,
    expiresAt: now + ttl,
  };
}

/**
 * Should the mint / revoke / deliver path stand down right now?
 *
 * Read by both writers in `auth.ts` — the first-admin bootstrap mint and the re-mint — and
 * reported as the route's `maintenance` field, so Operon reads back the same fact the fork
 * is acting on rather than one it inferred.
 */
export function operonMaintenanceDeferral(): {
  deferred: boolean;
  retryAfterS: number | null;
} {
  if (!observedMaintenance.held) return { deferred: false, retryAfterS: null };
  if (Date.now() >= observedMaintenance.expiresAt) {
    observedMaintenance = NOT_HELD;
    return { deferred: false, retryAfterS: null };
  }
  return { deferred: true, retryAfterS: observedMaintenance.retryAfterS };
}

/**
 * Admission: the advisory lock was granted and a credential operation is starting.
 *
 * Paired with {@link endOperonCredentialOp} in a `finally`, never at the return sites — a
 * decrement per return is a decrement somebody will forget on the next early return added.
 */
export function beginOperonCredentialOp(): void {
  credentialOpsInFlight += 1;
}

/** The operation reached a terminal state. Never below zero, whatever a caller does. */
export function endOperonCredentialOp(): void {
  credentialOpsInFlight = Math.max(0, credentialOpsInFlight - 1);
}

/**
 * A delivery ended WITHOUT an HTTP status, so nothing here knows whether Operon wrote.
 *
 * Recorded rather than assumed in either direction: assuming it landed lets Operon dump
 * over an open transaction, and assuming it did not would have this fork re-mint over a
 * credential that was in fact delivered.
 */
export function recordUnresolvedOperonDelivery(deliveryId: string): void {
  if (!deliveryId) return;
  if (!unresolvedDeliveries.has(deliveryId)) {
    unresolvedDeliveries.set(deliveryId, Date.now());
  }
  // The id, never the credential (Operon AGENTS.md rule 23). A delivery id is a random
  // UUID this process generated and authenticates as nothing.
  console.warn(
    `[operon] the credential delivery ${deliveryId} ended without an HTTP status; recorded unresolved until operon reports a verdict`,
  );
}

/**
 * Apply Operon's verdicts. Returns the ids that were actually cleared.
 *
 * `absent` gets a named line because it means this fork minted a credential Operon never
 * received: nothing is broken, but the next sign-in's `serviceKeyValid: false` re-check is
 * what re-delivers it, and an operator reading the log should be able to see that happen
 * rather than infer it.
 */
export function resolveOperonDeliveries(
  verdicts: Array<{ deliveryId: string; verdict: OperonDeliveryVerdict }>,
): string[] {
  const cleared: string[] = [];
  for (const { deliveryId, verdict } of verdicts) {
    if (!unresolvedDeliveries.delete(deliveryId)) continue;
    cleared.push(deliveryId);
    if (verdict === "absent") {
      console.warn(
        `[operon] operon reports delivery ${deliveryId} ABSENT — a service key was minted that operon never received; the next admin sign-in re-delivers it`,
      );
    }
  }
  return cleared;
}

/** The whole account, as the route reports it. */
export function operonMaintenanceState(): {
  maintenance: boolean;
  credentialOpsInFlight: number;
  unresolvedDeliveries: string[];
} {
  return {
    maintenance: operonMaintenanceDeferral().deferred,
    credentialOpsInFlight,
    unresolvedDeliveries: [...unresolvedDeliveries.keys()],
  };
}

/** Test seam. Never called by the server — the state is per-process and per-run. */
export function __resetOperonMaintenanceState(): void {
  credentialOpsInFlight = 0;
  observedMaintenance = NOT_HELD;
  unresolvedDeliveries.clear();
}

/**
 * The bytes both sides sign.
 *
 * Method and PATH are in it because a signature over the body alone would let a
 * `resolve-deliveries` body be replayed at `maintenance-state`, or a GET's signature be
 * lifted onto a POST. The timestamp is in it because a signature over a fixed string would
 * be a bearer token with no expiry.
 */
export function operonCanonicalRequest(
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`;
}

/**
 * Verify Operon's signature over the exact bytes received.
 *
 * Pure and exported so the four cases — valid, unsigned, wrongly signed and outside the
 * window — can be asserted without a socket.
 */
export function verifyOperonRequestSignature(args: {
  method: string;
  path: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  secret: string | undefined;
  now?: number;
}): { ok: true } | { ok: false; reason: string; status: 401 | 503 } {
  const { method, path, timestamp, signature, body, secret } = args;

  if (!secret) {
    // Fail CLOSED and loudly. An unset secret must never mean "skip the check" — that
    // would turn a misconfigured deployment into an unauthenticated read of this fork's
    // internal state. 503, not 401: the fault is this instance's, not the caller's.
    return { ok: false, reason: "secret_not_configured", status: 503 };
  }
  if (!signature)
    return { ok: false, reason: "signature_missing", status: 401 };
  if (!timestamp)
    return { ok: false, reason: "timestamp_missing", status: 401 };

  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) {
    return { ok: false, reason: "timestamp_unparseable", status: 401 };
  }
  // Both directions. A sender that could pre-date a request could pre-date it arbitrarily
  // far forward and keep one signature usable for a week.
  if (Math.abs((args.now ?? Date.now()) - at) > OPERON_MAX_SIGNATURE_SKEW_MS) {
    return { ok: false, reason: "stale_timestamp", status: 401 };
  }

  const expected = createHmac("sha256", secret)
    .update(operonCanonicalRequest(method, path, timestamp, body))
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim(), "utf8");
  // The LENGTH of a signature is not a secret, only its contents are, and
  // `timingSafeEqual` throws on a length mismatch — so the lengths are compared first.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_mismatch", status: 401 };
  }
  return { ok: true };
}

const operonMaintenanceStateRouter = new Hono();

/**
 * Verify this request, or say how to refuse it.
 *
 * The BODY IS PASSED IN rather than read here, because `c.req.text()` consumes the stream
 * and the POST handler needs the same bytes the signature was checked over — parsing
 * `c.req.json()` afterwards would verify one representation and act on another.
 */
function verifyIncoming(
  c: Context,
  body: string,
): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  const verdict = verifyOperonRequestSignature({
    method: c.req.method,
    path: c.req.path,
    timestamp: c.req.header(OPERON_TIMESTAMP_HEADER),
    signature: c.req.header(OPERON_SIGNATURE_HEADER),
    body,
    secret: process.env.OPERON_KANEO_S2S_SECRET,
  });

  if (verdict.ok) return { ok: true };

  // Never the signature and never the body — only the reason.
  console.warn(
    `[operon] maintenance-state request refused (${verdict.reason})`,
  );
  return {
    ok: false,
    status: verdict.status,
    error:
      verdict.status === 503
        ? "server-to-server auth is not configured"
        : "invalid signature",
  };
}

/**
 * `GET /api/internal/operon/maintenance-state` — the whole account, under HMAC.
 *
 * Operon polls this after setting its flag and admits its backup only when the counter is
 * zero, the unresolved list is empty and its OWN in-flight credential-transaction set is
 * empty — on two consecutive readings a settle interval apart, because the three are read
 * at different instants across two hosts.
 */
operonMaintenanceStateRouter.get("/maintenance-state", (c) => {
  const check = verifyIncoming(c, "");
  if (!check.ok) return c.json({ error: check.error }, check.status);
  return c.json(operonMaintenanceState());
});

/**
 * `POST /api/internal/operon/resolve-deliveries` — Operon's verdicts, under the same HMAC.
 *
 * Body: `{ verdicts: [{ deliveryId, verdict: "settled" | "absent" }] }`. Only the ids named
 * are cleared, and an id this fork does not hold is silently not cleared rather than an
 * error: Operon reconciles from ITS store, and a fork that restarted since is allowed to
 * have forgotten.
 */
operonMaintenanceStateRouter.post("/resolve-deliveries", async (c) => {
  const body = await c.req.text();
  const check = verifyIncoming(c, body);
  if (!check.ok) return c.json({ error: check.error }, check.status);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return c.json({ error: "a json body is required" }, 400);
  }

  const raw = (parsed as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(raw)) {
    return c.json({ error: "verdicts must be an array" }, 400);
  }

  const verdicts: Array<{
    deliveryId: string;
    verdict: OperonDeliveryVerdict;
  }> = [];
  for (const entry of raw) {
    const deliveryId = (entry as { deliveryId?: unknown })?.deliveryId;
    const verdict = (entry as { verdict?: unknown })?.verdict;
    if (typeof deliveryId !== "string" || !deliveryId) continue;
    if (verdict !== "settled" && verdict !== "absent") continue;
    verdicts.push({ deliveryId, verdict });
  }

  const cleared = resolveOperonDeliveries(verdicts);
  return c.json({ cleared, ...operonMaintenanceState() });
});

export default operonMaintenanceStateRouter;
