import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireEntitlement } from "../billing/require-entitlement-middleware";
import db from "../database";
import {
  customFieldDefinitionTable,
  operonTableProjectTable,
} from "../database/schema";
import type { BaseVariables } from "../openapi";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import { requireTableAdmin } from "./admin";
import { createTable } from "./create-table";
import { TABLE_DEFAULT_ICON } from "./schema";

/**
 * Operon fork addition (Tables, docs/fork-discipline.md row 18, spec 7.9): the Tables REST
 * routes under `/api/operon/tables`. A plain Hono router, not `apiRouter().openapi(...)`,
 * for the reason rows 3 and 17 give: nothing here belongs in the public API document.
 */
const operonTables = new Hono<{
  Variables: BaseVariables & { workspaceId: string };
}>();

function badRequest(message: string): never {
  throw new HTTPException(400, {
    res: Response.json(
      { error: "validation_failed", message },
      { status: 400 },
    ),
  });
}

operonTables.post(
  "/tables",
  workspaceAccess.fromBody(),
  requireTableAdmin,
  // The ordinary project-create gates still apply: a built-in role with project:create
  // removed, or a workspace the entitlement gate denies, cannot create a table either.
  requireWorkspacePermission({ project: ["create"] }),
  requireEntitlement,
  async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      slug?: unknown;
      icon?: unknown;
    } | null;
    if (!body || typeof body !== "object")
      badRequest("A JSON body is required");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!name || name.length > 200) badRequest("name is required");
    if (!slug) badRequest("slug is required");
    if (body.icon !== undefined && typeof body.icon !== "string") {
      badRequest("icon must be a string");
    }
    const icon =
      typeof body.icon === "string" && body.icon.trim()
        ? body.icon.trim()
        : TABLE_DEFAULT_ICON;

    let project: Awaited<ReturnType<typeof createTable>>;
    try {
      project = await createTable({
        workspaceId: c.get("workspaceId"),
        name,
        slug,
        icon,
        userId: c.get("userId"),
      });
    } catch (error) {
      // The transaction rolled back: nothing was created and nothing announced (RF-4).
      console.error("[operon] tables.table_create_refused", {
        workspaceId: c.get("workspaceId"),
        errorClass: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
    return c.json({ ...project, isTable: true }, 200);
  },
);

export async function readTable(projectId: string) {
  const [flag] = await db
    .select()
    .from(operonTableProjectTable)
    .where(eq(operonTableProjectTable.projectId, projectId))
    .limit(1);
  if (!flag) return null;
  const columns = await db
    .select({
      id: customFieldDefinitionTable.id,
      name: customFieldDefinitionTable.name,
      kind: customFieldDefinitionTable.type,
      required: customFieldDefinitionTable.required,
      options: customFieldDefinitionTable.options,
      position: customFieldDefinitionTable.position,
    })
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, projectId))
    .orderBy(
      asc(customFieldDefinitionTable.position),
      asc(customFieldDefinitionTable.id),
    );
  return {
    projectId,
    isTable: true,
    groupFieldId: flag.groupFieldId,
    dateFieldId: flag.dateFieldId,
    statusFieldId: flag.statusFieldId,
    columns,
  };
}

operonTables.get(
  "/tables/:projectId",
  workspaceAccess.fromProject("projectId"),
  requireWorkspacePermission({ project: ["read"] }),
  async (c) => {
    const table = await readTable(c.req.param("projectId") ?? "");
    if (!table) {
      return c.json(
        { error: "not_a_table", message: "This project is not a table" },
        404,
      );
    }
    return c.json(table, 200);
  },
);

export default operonTables;
