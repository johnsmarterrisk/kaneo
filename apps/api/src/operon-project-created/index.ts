import { eq } from "drizzle-orm";
import db from "../database";
import { userTable } from "../database/schema";
import { subscribeToEvent } from "../events";
import { postToGenericWebhook } from "../plugins/generic-webhook/client";

/**
 * Operon fork addition — `project.created`, delivered on a WORKSPACE-LEVEL path.
 *
 * ── WHY THIS CANNOT BE A PLUGIN HANDLER ───────────────────────────────────────────────
 *
 * Every integration in this codebase is keyed on a PROJECT (`integrationTable` is
 * `UNIQUE (projectId, type)` and `registry.ts` resolves handlers with
 * `getActiveIntegrations(projectId)`). A project that was created a millisecond ago has no
 * integration row of its own, so a plugin handler for its own creation is unreachable by
 * construction — the one event that announces a project can never travel the path that is
 * opened by having announced it. That is the deadlock this module breaks: it reads the
 * destination from the INSTANCE's configuration rather than from the new project's row.
 *
 * ── WHY IT MATTERS TO OPERON, AND NOT ONLY AS A MISSING FEED ROW ──────────────────────
 *
 * Operon provisions each project's `generic-webhook` integration from a five-minute polling
 * sweep (`platform-service/src/signals/kaneo-provisioning.js`), because there was no
 * creation event to hang it off. A project created between two sweeps therefore had NO live
 * delivery path, and every task event in its first minutes was lost to the ledger — visible
 * only later, and anonymously, as a reconciliation row. This delivery is what lets the
 * platform provision that integration on receipt, before the person has finished typing
 * their first task.
 *
 * ── WHY IT IS INERT ON EVERY DEPLOYMENT THAT IS NOT OPERON'S ──────────────────────────
 *
 * The destination and the shared secret are both read from the environment, and a missing
 * either stands the module down with no delivery and no error. Upstream sets neither, so an
 * ordinary Kaneo instance behaves exactly as `v2.23.1` does: no new request, no new event
 * name reaching a generic-webhook consumer that never subscribed to one. See
 * `docs/fork-discipline.md` §3 row 12.
 */

/** The event this module both names and consumes. Published by `project/controllers/create-project.ts`. */
export const OPERON_PROJECT_CREATED_EVENT = "project.created";

export type OperonProjectCreatedEvent = {
  projectId: string;
  workspaceId: string;
  name: string;
  slug: string;
  icon: string | null;
  /**
   * The person who created it, resolved by the route from `c.get("userId")` — the same
   * current-user rule `task.created` uses. Optional because a caller that is not a signed-in
   * human (a seed, a future import) has no Kaneo actor, and a null actor is true where a
   * guessed one would be a lie in a permanent ledger.
   */
  currentUserId?: string | null;
};

/**
 * Operon's in-network receiver, `POST /webhooks/kaneo`.
 *
 * `OPERON_INTERNAL_API_URL` is the variable A5 already sets on this service for the
 * server-to-server channel, reused here so the two directions cannot drift onto different
 * hostnames. The path is spelled the same way the Operon provisioner spells it.
 */
export function operonProjectCreatedDestination(): string | null {
  const base = (process.env.OPERON_INTERNAL_API_URL || "").trim();
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/webhooks/kaneo`;
}

/**
 * The HMAC secret the receiver verifies with — the SAME `KANEO_WEBHOOK_SECRET` the
 * provisioner writes onto every project's integration, so this path is verified by exactly
 * the same key as the per-project ones and no second credential exists to rotate.
 */
export function operonProjectCreatedSecret(): string | null {
  const secret = (process.env.KANEO_WEBHOOK_SECRET || "").trim();
  return secret || null;
}

/**
 * The actor, looked up the way `generic-webhook/events.ts`'s `getActor` looks one up.
 *
 * Reproduced here in three lines rather than exported from that file, so the plugin keeps
 * upstream's body byte for byte (the standing choice of rows 8, 10 and 11). A user id that
 * resolves to no row still travels as the id: it is what the delivery knows, and dropping it
 * would lose attribution that the receiver can still resolve against its own records.
 */
async function resolveActor(
  userId: string | null | undefined,
): Promise<{ id: string | null; name: string | null }> {
  if (!userId) return { id: null, name: null };

  const [user] = await db
    .select({ id: userTable.id, name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);

  return { id: user?.id ?? userId, name: user?.name ?? null };
}

/**
 * The delivery body, in the SAME envelope every generic-webhook event uses — `event`,
 * `timestamp`, `integration`, `project`, `actor`, `data` — minus the `task` key, because
 * there is no task. A receiver that switches on `event` reads this with the code it already
 * has; one that assumes a task is present is reading a field this event never claimed.
 */
export function buildOperonProjectCreatedPayload(
  event: OperonProjectCreatedEvent,
  actor: { id: string | null; name: string | null },
  timestamp: string,
): Record<string, unknown> {
  const clientUrl = process.env.KANEO_CLIENT_URL || "http://localhost:5173";

  return {
    event: OPERON_PROJECT_CREATED_EVENT,
    timestamp,
    integration: { type: "generic-webhook" },
    project: {
      id: event.projectId,
      name: event.name,
      workspaceId: event.workspaceId,
      url: `${clientUrl}/dashboard/workspace/${event.workspaceId}/project/${event.projectId}`,
    },
    actor,
    data: { slug: event.slug, icon: event.icon ?? null },
  };
}

/**
 * Deliver one project creation, or say why it was not delivered. ONE attempt.
 *
 * Never throws. A project creation that already COMMITTED must not surface as a failure to
 * the person who made it. The failure is logged with the project and never the secret; what
 * recovers it is `startOperonProjectCreatedDelivery`'s background retries and, behind those,
 * the platform's five-minute reconciliation sweep.
 *
 * **A 2xx is delivered, and that includes 202.** `postToGenericWebhook` resolves on
 * `response.ok`, so Operon's "accepted, provisioning still pending" answer is a DELIVERY and
 * is never retried — the platform owns the retry of its own provisioning from that point on.
 * Only a non-2xx, a redirect or a timeout rejects, and only those are retried here.
 */
export async function deliverOperonProjectCreated(
  event: OperonProjectCreatedEvent,
  now: Date = new Date(),
): Promise<{ delivered: boolean; skipped: string | null }> {
  const destination = operonProjectCreatedDestination();
  const secret = operonProjectCreatedSecret();

  // Not an error, and deliberately not logged at warn: this is every deployment that is not
  // Operon's, on every project creation, forever.
  if (!destination || !secret) {
    return { delivered: false, skipped: "not_configured" };
  }

  if (!event || !event.projectId || !event.workspaceId) {
    console.error("operon project.created delivery skipped: incomplete event", {
      projectId: event?.projectId ?? null,
    });
    return { delivered: false, skipped: "incomplete_event" };
  }

  try {
    const actor = await resolveActor(event.currentUserId);
    await postToGenericWebhook(
      destination,
      buildOperonProjectCreatedPayload(event, actor, now.toISOString()),
      secret,
    );
    return { delivered: true, skipped: null };
  } catch (error) {
    console.error("operon project.created delivery failed", {
      projectId: event.projectId,
      workspaceId: event.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { delivered: false, skipped: "delivery_failed" };
  }
}

/**
 * ── WHY THE CONTROLLER AWAITS THIS AND NOT THE BUS (code gate round 1, finding 1) ──────
 *
 * `publishEvent` is `EventEmitter.emit`, and `emit` does NOT await an async listener: it
 * calls it, gets a promise back and drops it on the floor. So publishing alone let
 * `createProject()` answer while this delivery — and, on Operon's side, the provisioning it
 * triggers — were still in flight, and a task created immediately afterwards could still
 * reach a project with no integration row. That is the very window the event exists to
 * close, reopened one frame narrower.
 *
 * The fix is to make the delivery AWAITABLE and await it in the controller, under a bound:
 *
 *   BOUNDED   `OPERON_PROJECT_CREATED_TIMEOUT_MS` (4 s) is the longest a person waits for
 *             their project. The generic-webhook client's own timeout is 10 s, which is a
 *             fine ceiling for a background task and far too long for an interactive create,
 *             so the wait is cut short here rather than there.
 *   NOT LOST   A timed-out or refused first attempt is NOT abandoned — the same call keeps
 *             retrying in the background on `OPERON_PROJECT_CREATED_RETRY_BACKOFF_MS`, which
 *             the controller does not wait for. Operon answers 202 while ITS provisioning is
 *             pending, and 202 is a 2xx, so the two retry ladders never run at once.
 *   DEDUPED   Keyed on the project id. The controller and the bus subscription both land
 *             here for the same creation; the second one JOINS the first's promise rather
 *             than sending a second delivery, which is what lets the bus publish survive for
 *             any other consumer without the receiver seeing the event twice.
 */
export const OPERON_PROJECT_CREATED_TIMEOUT_MS = 4_000;

/**
 * The background ladder after the first attempt: three retries, ~21 s of wall clock. It stops
 * well inside Operon's five-minute reconciliation sweep, which is the durable backstop and the
 * only layer that survives a restart of this process.
 */
export const OPERON_PROJECT_CREATED_RETRY_BACKOFF_MS = [
  1_000, 5_000, 15_000,
] as const;

export type OperonProjectCreatedDelivery = {
  delivered: boolean;
  skipped: string | null;
};

/**
 * In-flight deliveries by project id — the dedupe described above. An entry is removed when
 * the whole ladder has settled, so a later re-publication of the same project (a redelivery,
 * a retried create) is delivered again rather than silently swallowed.
 */
const inFlight = new Map<string, Promise<OperonProjectCreatedDelivery>>();

/** A timer that never keeps the process alive; `unref` is absent under some fake clocks. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

async function deliverWithRetries(
  event: OperonProjectCreatedEvent,
): Promise<OperonProjectCreatedDelivery> {
  let result = await deliverOperonProjectCreated(event);

  // `not_configured` and `incomplete_event` are decisions, not failures: retrying either
  // would log the same refusal four times and change nothing.
  if (result.delivered || result.skipped !== "delivery_failed") return result;

  for (const [
    index,
    backoffMs,
  ] of OPERON_PROJECT_CREATED_RETRY_BACKOFF_MS.entries()) {
    await sleep(backoffMs);
    console.warn("operon project.created delivery retry", {
      projectId: event.projectId,
      attempt: index + 1,
      of: OPERON_PROJECT_CREATED_RETRY_BACKOFF_MS.length,
    });
    result = await deliverOperonProjectCreated(event);
    if (result.delivered) return result;
  }

  console.error("operon project.created delivery gave up", {
    projectId: event.projectId,
    workspaceId: event.workspaceId,
    attempts: OPERON_PROJECT_CREATED_RETRY_BACKOFF_MS.length + 1,
    detail:
      "Operon's five-minute provisioning sweep is the remaining layer for this project",
  });
  return result;
}

/**
 * Start the delivery for one creation, or join the one already running for that project.
 *
 * Never rejects. The returned promise settles when the whole retry ladder has, which is NOT
 * what the controller waits for — see `deliverOperonProjectCreatedBounded`.
 */
export function startOperonProjectCreatedDelivery(
  event: OperonProjectCreatedEvent,
): Promise<OperonProjectCreatedDelivery> {
  const key = event?.projectId;
  if (!key) return deliverOperonProjectCreated(event);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const started = deliverWithRetries(event).finally(() => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

/**
 * What `createProject()` awaits: the delivery, bounded.
 *
 * Resolves as soon as the delivery settles, or after `timeoutMs` — whichever is first. The
 * delivery itself is NOT cancelled by the timeout; it keeps retrying in the background.
 */
export async function deliverOperonProjectCreatedBounded(
  event: OperonProjectCreatedEvent,
  timeoutMs: number = OPERON_PROJECT_CREATED_TIMEOUT_MS,
): Promise<OperonProjectCreatedDelivery> {
  const delivery = startOperonProjectCreatedDelivery(event);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<OperonProjectCreatedDelivery>((resolve) => {
    timer = setTimeout(() => {
      console.warn("operon project.created delivery still pending", {
        projectId: event?.projectId ?? null,
        timeoutMs,
        detail:
          "create answered without waiting; delivery continues in the background",
      });
      resolve({ delivered: false, skipped: "timeout" });
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  try {
    return await Promise.race([delivery, bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let subscribed = false;

/**
 * Subscribe once. Idempotent for the same reason `initializeEventSubscriptions` is: a second
 * call would register a second listener and deliver every project twice.
 *
 * The subscription is no longer the controller's delivery path — it is the path for a
 * `project.created` published by anything ELSE. It shares the dedupe above, so when the
 * controller is the publisher the two land on one delivery.
 */
export function initOperonProjectCreatedDelivery(): void {
  if (subscribed) return;
  subscribed = true;

  void subscribeToEvent<OperonProjectCreatedEvent>(
    OPERON_PROJECT_CREATED_EVENT,
    async (data) => {
      await startOperonProjectCreatedDelivery(data);
    },
  );
}
