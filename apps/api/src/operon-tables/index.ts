import { and, asc, eq, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireEntitlement } from "../billing/require-entitlement-middleware";
import db from "../database";
import {
  customFieldDefinitionTable,
  operonTableProjectTable,
} from "../database/schema";
import type { BaseVariables } from "../openapi";
import {
  hasWorkspacePermission,
  requireWorkspacePermission,
} from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import { isTableAdmin, requireTableAdmin } from "./admin";
import { readColumnHistory } from "./columns";
import { createTable } from "./create-table";
import { editOptions, readOptionEdit } from "./options";
import { outboxHealth } from "./outbox";
import { readTableRow } from "./read-row";
import { TABLE_DEFAULT_ICON } from "./schema";
import { tableError } from "./values";
import {
  deleteTableRow,
  loadTable,
  type RowBody,
  refusalReason,
  writeTableRow,
} from "./write-row";

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

// Static paths first: Hono matches in registration order, and `/tables/:projectId` would
// otherwise take `outbox-health` as a project id.

/**
 * RF-10: the Tables outbox backlog of ONE workspace, for that workspace's table admin. The
 * instance-wide stall alert stays server-side (outbox.ts).
 */
operonTables.get(
  "/tables/outbox-health",
  workspaceAccess.fromQuery(),
  requireTableAdmin,
  async (c) => c.json(await outboxHealth(c.get("workspaceId")), 200),
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
    .where(
      and(
        eq(customFieldDefinitionTable.projectId, projectId),
        isNull(customFieldDefinitionTable.hiddenAt),
      ),
    )
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

/**
 * R-B3: the admin-only recovery read of one column, hidden or not — its current values and
 * its value history. Every other surface omits a hidden column.
 */
operonTables.get(
  "/tables/:projectId/fields/:fieldId/history",
  workspaceAccess.fromProject("projectId"),
  async (c, next) => {
    try {
      await requireTableAdmin(c, next);
    } catch (error) {
      console.warn("[operon] tables.history_read_refused", {
        projectId: c.req.param("projectId") ?? null,
        fieldId: c.req.param("fieldId") ?? null,
        actorUserId: c.get("userId") ?? null,
      });
      throw error;
    }
  },
  async (c) => {
    const projectId = c.req.param("projectId") ?? "";
    const fieldId = c.req.param("fieldId") ?? "";
    if (!(await loadTable(projectId))) {
      tableError(404, "not_a_table", "This project is not a table");
    }
    const result = await readColumnHistory(
      projectId,
      fieldId,
      c.req.query("cursor") || undefined,
    );
    console.log("[operon] tables.history_read", {
      projectId,
      fieldId,
      actorUserId: c.get("userId"),
    });
    return c.json(result, 200);
  },
);

function via(c: { get: (key: "apiKey") => unknown }) {
  return c.get("apiKey") ? ("api_key" as const) : ("session" as const);
}

async function readBody(c: { req: { json: () => Promise<unknown> } }) {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    tableError(422, "validation_failed", "A JSON object body is required");
  }
  return body as RowBody;
}

/** "New topic…" (spec 7.3 step 3): a table admin who also holds project:update. */
async function canAddTopic(c: Context) {
  return (
    (await isTableAdmin(c)) &&
    (await hasWorkspacePermission(c, { project: ["update"] }))
  );
}

/**
 * Add, rename or merge a choice column's options (spec 7.3a, task 7): table admin and
 * project:update. Rename and Merge rewrite every row carrying the option, one signal each.
 */
operonTables.post(
  "/tables/:projectId/fields/:fieldId/options",
  workspaceAccess.fromProject("projectId"),
  async (c, next) => {
    try {
      await requireTableAdmin(c, next);
    } catch (error) {
      console.warn("[operon] tables.option_refused", {
        projectId: c.req.param("projectId") ?? null,
        fieldId: c.req.param("fieldId") ?? null,
        reason: "admin_only",
        actorUserId: c.get("userId") ?? null,
      });
      throw error;
    }
  },
  requireWorkspacePermission({ project: ["update"] }),
  async (c) => {
    const projectId = c.req.param("projectId") ?? "";
    const fieldId = c.req.param("fieldId") ?? "";
    const edit = readOptionEdit(await c.req.json().catch(() => null));
    try {
      const result = await editOptions({
        projectId,
        fieldId,
        actorUserId: c.get("userId"),
        edit,
      });
      return c.json(result, 200);
    } catch (error) {
      const reason = await refusalReason(error);
      if (reason) {
        console.warn("[operon] tables.option_refused", {
          projectId,
          fieldId,
          reason,
          actorUserId: c.get("userId"),
        });
      }
      throw error;
    }
  },
);

async function answerRow(projectId: string, taskId: string) {
  const table = await loadTable(projectId);
  if (!table) tableError(404, "not_a_table", "This project is not a table");
  const row = await readTableRow(table, taskId);
  if (!row)
    tableError(404, "row_not_in_table", "That entry is not in this table");
  return row;
}

/** Add an entry (spec 7.3): one transaction for the row, its history and its signals. */
operonTables.post(
  "/tables/:projectId/rows",
  workspaceAccess.fromProject("projectId"),
  requireWorkspacePermission({ task: ["create"] }),
  async (c) => {
    const projectId = c.req.param("projectId") ?? "";
    const result = await writeTableRow({
      projectId,
      workspaceId: c.get("workspaceId"),
      actorUserId: c.get("userId"),
      via: via(c),
      body: await readBody(c),
      canAddTopic: await canAddTopic(c),
    });
    return c.json(
      { row: await answerRow(projectId, result.taskId), replayed: false },
      200,
    );
  },
);

/** Change an entry; a save equal to what is stored writes nothing and answers 200 (R-G). */
operonTables.patch(
  "/tables/:projectId/rows/:taskId",
  workspaceAccess.fromProject("projectId"),
  requireWorkspacePermission({ task: ["update"] }),
  async (c) => {
    const projectId = c.req.param("projectId") ?? "";
    const taskId = c.req.param("taskId") ?? "";
    const result = await writeTableRow({
      projectId,
      workspaceId: c.get("workspaceId"),
      actorUserId: c.get("userId"),
      via: via(c),
      taskId,
      body: await readBody(c),
      canAddTopic: await canAddTopic(c),
    });
    return c.json(
      {
        row: await answerRow(projectId, result.taskId),
        unchanged: !result.changed,
      },
      200,
    );
  },
);

/** Delete an entry: its `task.deleted` signal commits with the delete; history stays. */
operonTables.delete(
  "/tables/:projectId/rows/:taskId",
  workspaceAccess.fromProject("projectId"),
  requireWorkspacePermission({ task: ["delete"] }),
  async (c) => {
    const projectId = c.req.param("projectId") ?? "";
    const taskId = c.req.param("taskId") ?? "";
    await deleteTableRow({
      projectId,
      actorUserId: c.get("userId"),
      via: via(c),
      taskId,
    });
    return c.json({ rowId: taskId, tableId: projectId, deleted: true }, 200);
  },
);

export default operonTables;
