import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { workspaceUserTable } from "../database/schema";
import { isInstanceAdmin } from "../utils/is-instance-admin";

/**
 * Operon fork addition (Tables, docs/fork-discipline.md row 18, spec R-D / RF-9): the one
 * "table admin" gate. Any API key is refused (403 `api_key_not_allowed`) — an agent or
 * Operon's service key never defines a table or its columns. Then an instance admin passes,
 * or a member whose workspace role (comma-separated, as `hasOwnerRole` reads it) contains
 * `owner` or `admin`. A CUSTOM role is refused whatever permissions it grants, including
 * `project: ["update"]`: Operon's admins are exactly the workspace's owner/admin members,
 * and an editable role row must not widen who can reshape a table (RF-9).
 *
 * Runs after `workspaceAccess`, which sets the verified `workspaceId`.
 */
export const TABLE_ADMIN_ROLES = ["owner", "admin"] as const;

export function roleIsTableAdmin(role: string | null | undefined): boolean {
  if (!role) return false;
  return role
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => (TABLE_ADMIN_ROLES as readonly string[]).includes(entry));
}

function refuse(code: "api_key_not_allowed" | "admin_only", message: string) {
  return new HTTPException(403, {
    res: Response.json({ error: code, message }, { status: 403 }),
  });
}

export async function isTableAdmin(c: Context): Promise<boolean> {
  if (c.get("apiKey")) return false;
  if (await isInstanceAdmin(c)) return true;
  const userId = c.get("userId") as string | undefined;
  const workspaceId = c.get("workspaceId") as string | undefined;
  if (!userId || !workspaceId) return false;
  const [member] = await db
    .select({ role: workspaceUserTable.role })
    .from(workspaceUserTable)
    .where(
      and(
        eq(workspaceUserTable.workspaceId, workspaceId),
        eq(workspaceUserTable.userId, userId),
      ),
    )
    .limit(1);
  return roleIsTableAdmin(member?.role);
}

export async function requireTableAdmin(c: Context, next: Next) {
  if (c.get("apiKey")) {
    console.warn("[operon] tables.admin_refused", {
      reason: "api_key_not_allowed",
      workspaceId: c.get("workspaceId") ?? null,
    });
    throw refuse(
      "api_key_not_allowed",
      "Tables are administered from a signed-in session",
    );
  }
  if (!(await isTableAdmin(c))) {
    console.warn("[operon] tables.admin_refused", {
      reason: "admin_only",
      workspaceId: c.get("workspaceId") ?? null,
      userId: c.get("userId") ?? null,
    });
    throw refuse("admin_only", "Only a workspace owner or admin can do this");
  }
  await next();
}
