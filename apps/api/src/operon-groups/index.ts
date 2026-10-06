import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { operonS2SChannel } from "../auth";
import db, { schema } from "../database";
import type { BaseVariables } from "../openapi";

/**
 * Group mentions read from Operon (Operon group-mentions spec D10, D11, D14; fork
 * touch-list row 15 in Operon's `docs/fork-discipline.md`).
 *
 * Operon stays the only store of people groups. This module never writes or caches one:
 * the editor list and every comment or description save ask Operon's signed
 * `POST /internal/kaneo/groups` at that moment, so each side expands from Operon's tables
 * at its own read (D11's consistency rule).
 *
 * The markup is user-controlled, so a `group:<slug>` id is only a candidate: Operon answers
 * for the asker (nothing for a guest, an agent or a stranger), and the fork keeps only the
 * group members that belong to the task's workspace before anyone is notified.
 */

/** The same budget as the agent liveness fetch: headers and body inside one abort. */
export const OPERON_GROUPS_TIMEOUT_MS = 2000;

/** The mention id prefix the editor gives a group item (`group:<slug>`). */
export const OPERON_GROUP_ID_PREFIX = "group:";

/** Operon's handle grammar (`identity/groups.js` `SLUG_RE`), checked on every answer. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/**
 * Operon's one workspace, by the slug the bootstrap creates it under (`auth.ts`,
 * `OPERON_WORKSPACE_SLUG`). Repeated here rather than exported from `auth.ts`, which is
 * row 1's file: this row does not touch it.
 */
const OPERON_WORKSPACE_SLUG = "operon";

export type OperonGroup = {
  slug: string;
  name: string;
  memberCount: number;
  kaneoUserIds: string[];
};

export type OperonGroupsFailure =
  | "unconfigured"
  | "platform_status"
  | "unreachable"
  | "timeout"
  | "malformed";

export type OperonGroupsResult =
  | { ok: true; groups: OperonGroup[] }
  | { ok: false; reason: OperonGroupsFailure };

const GROUP_KEYS = ["kaneoUserIds", "memberCount", "name", "slug"];

function isOperonGroup(value: unknown): value is OperonGroup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== GROUP_KEYS.join(",")) return false;
  return (
    typeof row.slug === "string" &&
    SLUG_RE.test(row.slug) &&
    typeof row.name === "string" &&
    row.name.length > 0 &&
    Number.isInteger(row.memberCount) &&
    (row.memberCount as number) >= 0 &&
    Array.isArray(row.kaneoUserIds) &&
    row.kaneoUserIds.length <= (row.memberCount as number) &&
    row.kaneoUserIds.every((id) => typeof id === "string" && id.length > 0)
  );
}

/**
 * Operon's groups as `kaneoUserId` may see them. Fails closed on everything but a 2xx
 * body that is exactly `{ groups: [...] }` with every row well formed: a stray field, a
 * bad slug or a count smaller than its id list rejects the whole answer, because a
 * partly-trusted list would notify people Operon never named.
 */
export async function fetchOperonGroups(
  kaneoUserId: string,
): Promise<OperonGroupsResult> {
  const channel = operonS2SChannel();
  if (!channel) return { ok: false, reason: "unconfigured" };

  const body = JSON.stringify({
    kaneoUserId,
    timestamp: new Date().toISOString(),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPERON_GROUPS_TIMEOUT_MS);
  try {
    const response = await fetch(`${channel.base}/internal/kaneo/groups`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Operon-Signature": channel.sign(body),
      },
      body,
      signal: controller.signal,
      // A redirect would replay a signed body at an address nobody vouched for.
      redirect: "manual",
    });
    if (!response.ok) return { ok: false, reason: "platform_status" };
    let answer: unknown;
    try {
      answer = JSON.parse(await response.text());
    } catch {
      return {
        ok: false,
        reason: controller.signal.aborted ? "timeout" : "malformed",
      };
    }
    if (
      !answer ||
      typeof answer !== "object" ||
      Array.isArray(answer) ||
      Object.keys(answer).join(",") !== "groups"
    ) {
      return { ok: false, reason: "malformed" };
    }
    const groups = (answer as { groups: unknown }).groups;
    if (!Array.isArray(groups) || !groups.every(isOperonGroup)) {
      return { ok: false, reason: "malformed" };
    }
    return { ok: true, groups };
  } catch {
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The mention ids to notify: plain ids pass through unchanged and in order; each
 * `group:<slug>` becomes that group's Initiative users who are members of `workspaceId`,
 * read from Operon for `askerId` at this moment. Every person appears once. The caller
 * removes the author afterwards (raw diff, expand, minus author — D11's order).
 *
 * If Operon cannot be read, the group ids notify nobody and one WARN says how many were
 * dropped and why; direct mentions still go out, and the save itself is never failed
 * (spec §6, fail closed, never silent). No workspace means no group can be checked
 * against one, so group ids are dropped then too.
 */
export async function expandGroupMentionIds(
  ids: string[],
  { askerId, workspaceId }: { askerId: string; workspaceId: string | null },
): Promise<string[]> {
  const groupIds = ids.filter((id) => id.startsWith(OPERON_GROUP_ID_PREFIX));
  if (groupIds.length === 0) return ids;
  const plain = ids.filter((id) => !id.startsWith(OPERON_GROUP_ID_PREFIX));

  const fail = (reason: OperonGroupsFailure | "no_workspace") => {
    console.warn(
      JSON.stringify({
        evt: "operon_group_expand_failed",
        count: groupIds.length,
        reason,
      }),
    );
    return [...new Set(plain)];
  };
  if (!workspaceId) return fail("no_workspace");

  const answer = await fetchOperonGroups(askerId);
  if (!answer.ok) return fail(answer.reason);

  const bySlug = new Map(answer.groups.map((group) => [group.slug, group]));
  const candidates = new Set<string>();
  for (const id of groupIds) {
    const group = bySlug.get(id.slice(OPERON_GROUP_ID_PREFIX.length));
    // An unknown slug (deleted, mistyped, or hidden from this asker) reaches nobody.
    for (const memberId of group?.kaneoUserIds ?? []) candidates.add(memberId);
  }

  let members = new Set<string>();
  if (candidates.size > 0) {
    const rows = await db
      .select({ userId: schema.workspaceUserTable.userId })
      .from(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspaceId),
          inArray(schema.workspaceUserTable.userId, [...candidates]),
        ),
      );
    members = new Set(rows.map((row) => row.userId));
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const expanded = id.startsWith(OPERON_GROUP_ID_PREFIX)
      ? (
          bySlug.get(id.slice(OPERON_GROUP_ID_PREFIX.length))?.kaneoUserIds ??
          []
        ).filter((memberId) => members.has(memberId))
      : [id];
    for (const memberId of expanded) {
      if (seen.has(memberId)) continue;
      seen.add(memberId);
      out.push(memberId);
    }
  }
  return out;
}

/**
 * `GET /api/operon/groups` — the editor's group items for the signed-in person.
 *
 * Mounted AFTER `api.use("*")`, so a signed-out caller is already 401. It answers a
 * BROWSER SESSION only (an API key, Operon's own or anyone's, is 403: the list is for a
 * person typing `@`), and only a person with an actual `workspace_member` row in the
 * Operon workspace — `validateWorkspaceAccess` would wave a Kaneo admin through without
 * one, so it is not used here. Member ids never leave the server: the item carries the
 * two counts, `initiativeCount` being how many of the group have an Initiative account.
 * A plain Hono router, not an OpenAPI one, for A8's reason (`apps/docs/` is off the
 * touch list).
 */
const operonGroups = new Hono<{ Variables: BaseVariables }>();

operonGroups.get("/groups", async (c) => {
  if (c.get("apiKey") || !c.get("session")) {
    throw new HTTPException(403, {
      message: "Group mentions are for a signed-in person",
    });
  }
  const userId = c.get("userId");
  const [membership] = await db
    .select({ id: schema.workspaceUserTable.id })
    .from(schema.workspaceUserTable)
    .innerJoin(
      schema.workspaceTable,
      eq(schema.workspaceTable.id, schema.workspaceUserTable.workspaceId),
    )
    .where(
      and(
        eq(schema.workspaceTable.slug, OPERON_WORKSPACE_SLUG),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    )
    .limit(1);
  if (!membership) {
    throw new HTTPException(403, {
      message: "You don't have access to this workspace",
    });
  }

  const answer = await fetchOperonGroups(userId);
  if (!answer.ok) {
    console.warn(
      JSON.stringify({
        evt: "operon_groups_read_failed",
        reason: answer.reason,
      }),
    );
    c.header("Cache-Control", "no-store");
    return c.json({ error: "operon_unavailable" }, 503);
  }
  c.header("Cache-Control", "no-store");
  return c.json({
    groups: answer.groups.map((group) => ({
      slug: group.slug,
      name: group.name,
      initiativeCount: group.kaneoUserIds.length,
      memberCount: group.memberCount,
    })),
  });
});

export default operonGroups;
