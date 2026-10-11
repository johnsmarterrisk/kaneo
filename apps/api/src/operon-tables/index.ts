import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireEntitlement } from "../billing/require-entitlement-middleware";
import db from "../database";
import {
  customFieldDefinitionTable,
  operonTableProjectTable,
  projectTable,
  taskTable,
} from "../database/schema";
import type { BaseVariables } from "../openapi";
import {
  hasWorkspacePermission,
  requireWorkspacePermission,
} from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import { isTableAdmin, requireTableAdmin } from "./admin";
import {
  readColumnHistory,
  readTableSettings,
  updateTableSettings,
} from "./columns";
import { createTable } from "./create-table";
import { editOptions, readOptionEdit } from "./options";
import { outboxHealth } from "./outbox";
import { readTableRow } from "./read-row";
import { TABLE_DEFAULT_ICON } from "./schema";
import { searchTableRows } from "./search";
import { tableError } from "./values";
import {
  listTableRows,
  loadTableSettings,
  readRowsQuery,
  workspaceSummary,
} from "./views";
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

/**
 * The table view's search (RF-11) and task 12's `search_table_rows`: a literal substring
 * over the workspace's tables (or one, `tableId`), for a caller who may read its projects
 * and tasks. A `tableId` of another workspace is refused before any row or count.
 */
operonTables.get(
  "/tables/search",
  workspaceAccess.fromQuery(),
  requireWorkspacePermission({ project: ["read"], task: ["read"] }),
  async (c) => {
    const limit = c.req.query("limit");
    return c.json(
      await searchTableRows({
        workspaceId: c.get("workspaceId"),
        query: c.req.query("q") ?? "",
        tableId: c.req.query("tableId") || undefined,
        cursor: c.req.query("cursor") || undefined,
        limit: limit ? Number(limit) : undefined,
      }),
      200,
    );
  },
);

/**
 * The workspace project list's Tables section (spec 7.10 US1): per table entries, group
 * and status counts and the last added row; on the first page the five newest rows.
 */
operonTables.get(
  "/tables/workspace/:workspaceId/summary",
  workspaceAccess.fromParam("workspaceId"),
  requireWorkspacePermission({ project: ["read"], task: ["read"] }),
  async (c) =>
    c.json(
      await workspaceSummary(
        c.get("workspaceId"),
        c.req.query("cursor") || undefined,
      ),
      200,
    ),
);

/**
 * One entry by its task id (spec 7.9, task 9): the record panel and Telegraph's record
 * cards. An ordinary task answers 404 `not_a_table_row`; the table's name and its status
 * and date column names ride along so a card can render without a second call.
 */
operonTables.get(
  "/tables/rows/:taskId",
  workspaceAccess.fromTaskId("taskId"),
  requireWorkspacePermission({ task: ["read"] }),
  async (c) => {
    const taskId = c.req.param("taskId") ?? "";
    const [task] = await db
      .select({ projectId: taskTable.projectId })
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .limit(1);
    const settings = task ? await loadTableSettings(task.projectId) : null;
    const row = settings ? await readTableRow(settings.table, taskId) : null;
    if (!settings || !row) {
      tableError(404, "not_a_table_row", "That task is not a table entry");
    }
    const name = (id: string | null) =>
      settings.table.defs.find((d) => d.id === id)?.name ?? null;
    return c.json(
      {
        row,
        table: {
          tableId: settings.table.project.id,
          name: settings.table.project.name,
          groupColumn: name(settings.table.groupFieldId),
          statusColumn: name(settings.statusFieldId),
          dateColumn: name(settings.dateFieldId),
        },
      },
      200,
    );
  },
);

export async function readTable(projectId: string, includeHidden = false) {
  const [flag] = await db
    .select({ flag: operonTableProjectTable, name: projectTable.name })
    .from(operonTableProjectTable)
    .innerJoin(
      projectTable,
      eq(projectTable.id, operonTableProjectTable.projectId),
    )
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
  // Hidden columns are listed for a table admin only (the Columns page's "Hidden columns").
  const hiddenColumns = includeHidden
    ? await db
        .select({
          id: customFieldDefinitionTable.id,
          name: customFieldDefinitionTable.name,
          kind: customFieldDefinitionTable.type,
          hiddenAt: customFieldDefinitionTable.hiddenAt,
        })
        .from(customFieldDefinitionTable)
        .where(
          and(
            eq(customFieldDefinitionTable.projectId, projectId),
            isNotNull(customFieldDefinitionTable.hiddenAt),
          ),
        )
        .orderBy(asc(customFieldDefinitionTable.hiddenAt))
    : undefined;
  return {
    projectId,
    name: flag.name,
    isTable: true,
    groupFieldId: flag.flag.groupFieldId,
    dateFieldId: flag.flag.dateFieldId,
    statusFieldId: flag.flag.statusFieldId,
    columns,
    ...(hiddenColumns ? { hiddenColumns } : {}),
  };
}

operonTables.get(
  "/tables/:projectId",
  workspaceAccess.fromProject("projectId"),
  requireWorkspacePermission({ project: ["read"] }),
  async (c) => {
    const table = await readTable(
      c.req.param("projectId") ?? "",
      await isTableAdmin(c),
    );
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

/**
 * The table's group, date and status columns (spec 7.1, task 10): table admin and
 * project:update. Each id must be an ACTIVE column of THIS table of the right kind (group
 * and status a dropdown, date a date); any refusal changes nothing. `null` clears one.
 */
operonTables.put(
  "/tables/:projectId/settings",
  workspaceAccess.fromProject("projectId"),
  requireTableAdmin,
  requireWorkspacePermission({ project: ["update"] }),
  async (c) => {
    const projectId = c.req.param("projectId") ?? "";
    const body = await c.req.json().catch(() => null);
    const settings = readTableSettings(body);
    await updateTableSettings(projectId, settings, c.get("userId"));
    return c.json(await readTable(projectId, true), 200);
  },
);

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

/**
 * The table view's rows (spec 7.9): sort and chip filters applied in SQL before the page is
 * cut; values keyed by active column name, Made by and Last change on every row.
 */
operonTables.get(
  "/tables/:projectId/rows",
  workspaceAccess.fromProject("projectId"),
  requireWorkspacePermission({ task: ["read"] }),
  async (c) => {
    const settings = await loadTableSettings(c.req.param("projectId") ?? "");
    if (!settings) {
      tableError(404, "not_a_table", "This project is not a table");
    }
    const q = readRowsQuery(
      settings,
      {
        sort: c.req.query("sort"),
        year: c.req.query("year"),
        cursor: c.req.query("cursor") || undefined,
        limit: c.req.query("limit"),
      },
      c.req.queries("filter") ?? [],
    );
    return c.json(await listTableRows(settings, q), 200);
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
