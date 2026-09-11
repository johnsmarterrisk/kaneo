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
 * Deliver one project creation, or say why it was not delivered.
 *
 * Never throws. Its caller is the event bus, whose subscriber wrapper only console-logs a
 * rejection — and a project creation that already COMMITTED must not surface as a failure to
 * the person who made it. The failure is logged with the destination host and never the
 * secret, and the platform's reconciliation sweep is the second layer that recovers it.
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

let subscribed = false;

/**
 * Subscribe once. Idempotent for the same reason `initializeEventSubscriptions` is: a second
 * call would register a second listener and deliver every project twice.
 */
export function initOperonProjectCreatedDelivery(): void {
  if (subscribed) return;
  subscribed = true;

  void subscribeToEvent<OperonProjectCreatedEvent>(
    OPERON_PROJECT_CREATED_EVENT,
    async (data) => {
      await deliverOperonProjectCreated(data);
    },
  );
}
