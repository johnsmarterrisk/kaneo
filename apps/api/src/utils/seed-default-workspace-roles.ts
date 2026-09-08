import { DEFAULT_ROLE_NAMES, defaultRolePayloads } from "@kaneo/permissions";
import { and, inArray, sql } from "drizzle-orm";
import { upgradeOperonMemberRolePayload } from "../auth";
import db, { schema } from "../database";

/**
 * Backfill the editable default roles (viewer/member/admin) for every
 * workspace that's missing them. Runs on API startup after Drizzle
 * migrations.
 *
 * These three roles used to be static (compiled into better-auth's
 * `roles` config). They were converted to DB rows so admins can override
 * them per workspace, but that means existing workspaces, which were
 * created before the switch, have no rows yet. Without this backfill,
 * better-auth's dynamic-access-control resolution would treat them as
 * having an empty permission set on existing workspaces.
 *
 * Idempotent: only inserts rows that aren't already present.
 */
export async function seedDefaultWorkspaceRoles() {
  try {
    const tableExists = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = 'workspace_role'
      ) AS exists;
    `);

    const exists =
      tableExists.rows[0]?.exists === true ||
      tableExists.rows[0]?.exists === "t";
    if (!exists) {
      console.log(
        "🛈 workspace_role table does not exist; skipping default-role seed.",
      );
      return;
    }

    const workspaces = await db
      .select({
        id: schema.workspaceTable.id,
        slug: schema.workspaceTable.slug,
      })
      .from(schema.workspaceTable);

    if (workspaces.length === 0) {
      return;
    }

    const workspaceIds = workspaces.map((w) => w.id);

    const existingRows = await db
      .select({
        workspaceId: schema.workspaceRoleTable.workspaceId,
        role: schema.workspaceRoleTable.role,
      })
      .from(schema.workspaceRoleTable)
      .where(
        and(
          inArray(schema.workspaceRoleTable.workspaceId, workspaceIds),
          inArray(
            schema.workspaceRoleTable.role,
            DEFAULT_ROLE_NAMES as unknown as string[],
          ),
        ),
      );

    const present = new Set(
      existingRows.map((r) => `${r.workspaceId}:${r.role}`),
    );

    const now = new Date();
    const rows: Array<typeof schema.workspaceRoleTable.$inferInsert> = [];
    for (const workspaceId of workspaceIds) {
      for (const name of DEFAULT_ROLE_NAMES) {
        if (present.has(`${workspaceId}:${name}`)) continue;
        rows.push({
          workspaceId,
          role: name,
          permission: JSON.stringify(defaultRolePayloads[name]),
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // OPERON FORK — decision 124, round 3. This USED to be `if (rows.length === 0)
    // return;`, which is the right answer to "is there anything to INSERT" and the
    // wrong answer to "is there anything to UPGRADE": an instance whose Operon
    // workspace already holds all three rows took that return on every boot, so the
    // upgrade below never ran. Hoisting the upgrade ABOVE the insert would have been
    // wrong in the other direction — an existing workspace whose `member` row is
    // MISSING matches nothing, and the insert that follows then writes upstream's
    // payload, which the creation hook cannot repair because the workspace already
    // exists. So the return became a conditional and the upgrade runs AFTER the
    // insert, on both paths.
    if (rows.length > 0) {
      // Postgres' bind protocol caps parameters at 65535 per query, so insert
      // in chunks. 6 columns × 1000 rows = 6000 params per batch, leaving ample
      // headroom even for instances with tens of thousands of workspaces.
      const BATCH_SIZE = 1000;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        await db
          .insert(schema.workspaceRoleTable)
          .values(rows.slice(i, i + BATCH_SIZE));
      }
      console.log(
        `✅ Seeded ${rows.length} default workspace role row(s) across ${workspaceIds.length} workspace(s).`,
      );
    }

    // OPERON FORK — R13/R14, decisions 114 and 124. `upgradeOperonMemberRolePayload`
    // carries both gates itself (Operon mode AND the Operon slug), so this loop is a
    // no-op on an ordinary Kaneo instance and on every workspace that is not
    // Operon's. Counts are reported rather than swallowed: a row an admin has edited
    // is deliberately left alone, and "how many were left alone" is a fact an
    // operator should be able to read in the boot log.
    let upgraded = 0;
    let alreadyCurrent = 0;
    let customised = 0;
    for (const workspace of workspaces) {
      const outcome = await upgradeOperonMemberRolePayload(
        workspace.id,
        workspace.slug,
      );
      if (outcome === "upgraded") upgraded += 1;
      else if (outcome === "already-upgraded") alreadyCurrent += 1;
      else if (outcome === "customised") customised += 1;
    }
    if (upgraded + alreadyCurrent + customised > 0) {
      console.log(
        `✅ Operon member role: ${upgraded} upgraded, ${alreadyCurrent} already current, ${customised} left as customised.`,
      );
    }
  } catch (error) {
    console.error("❌ Failed to seed default workspace roles:", error);
    throw error;
  }
}
