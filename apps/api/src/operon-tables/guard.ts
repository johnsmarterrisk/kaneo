import { count, eq, inArray } from "drizzle-orm";
import type { Context, Next } from "hono";
import db from "../database";
import {
  commentTable,
  operonTableProjectTable,
  operonTableRowOutboxTable,
  projectTable,
  taskRelationTable,
  taskTable,
} from "../database/schema";
import { tableError } from "./values";
import type { Tx } from "./write-row";

/**
 * Operon fork addition (Tables tasks 5 and 9, docs/fork-discipline.md row 18, spec 7.5):
 * every upstream route that could change a table row outside the row writer — and so
 * without its history and its signal — is refused on table rows and table projects. The
 * Tables routes (`/api/operon/tables/...`) are the only write path. MCP tools call these
 * same REST routes with the caller's token (F12), so they inherit every refusal.
 *
 * One middleware, mounted once after authentication and before the routers it guards; it
 * reads a JSON body only where the id lives in the body (Hono caches the parsed body, so the
 * route's own validator still reads it).
 */
export async function isTableProject(projectId: string | null | undefined) {
  if (!projectId) return false;
  const [row] = await db
    .select({ projectId: operonTableProjectTable.projectId })
    .from(operonTableProjectTable)
    .where(eq(operonTableProjectTable.projectId, projectId))
    .limit(1);
  return Boolean(row);
}

/** The table project of each given task that is a table row (empty when none is). */
async function tableRowsAmong(taskIds: string[]) {
  const ids = taskIds.filter((id) => typeof id === "string" && id);
  if (ids.length === 0) return [];
  return db
    .select({ taskId: taskTable.id, projectId: taskTable.projectId })
    .from(taskTable)
    .innerJoin(
      operonTableProjectTable,
      eq(operonTableProjectTable.projectId, taskTable.projectId),
    )
    .where(inArray(taskTable.id, ids));
}

export async function isTableRow(taskId: string | null | undefined) {
  if (!taskId) return false;
  return (await tableRowsAmong([taskId])).length > 0;
}

type Refusal = {
  reason: string;
  projectId: string | null;
  taskId: string | null;
  message: string;
};

const USE_TABLE_ROUTE =
  "Entries of a table are changed through the table, not the task routes";

async function body(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

async function rowRefusal(
  taskIds: string[],
  reason: string,
  message: string,
): Promise<Refusal | null> {
  const [row] = await tableRowsAmong(taskIds);
  return row
    ? { reason, projectId: row.projectId, taskId: row.taskId, message }
    : null;
}

async function projectRefusal(
  projectId: string | null,
  reason: string,
  message: string,
): Promise<Refusal | null> {
  return (await isTableProject(projectId))
    ? { reason, projectId, taskId: null, message }
    : null;
}

const TASK_FIELD_ROUTES =
  /^\/api\/task\/(status|priority|assignee|due-date|title|description)\/([^/]+)$/;
const ONE_SEGMENT = /^\/api\/task\/([^/]+)$/;

async function refusalFor(c: Context): Promise<Refusal | null> {
  const method = c.req.method;
  const path = c.req.path.replace(/\/+$/, "") || "/";
  let match: RegExpExecArray | null;

  if (path.startsWith("/api/task/")) {
    if (method === "PATCH" && path === "/api/task/bulk") {
      const ids = (await body(c)).taskIds;
      return rowRefusal(
        Array.isArray(ids) ? (ids as string[]) : [],
        "table_row_use_table_route",
        USE_TABLE_ROUTE,
      );
    }
    match = /^\/api\/task\/import\/([^/]+)$/.exec(path);
    if (method === "POST" && match) {
      return projectRefusal(
        match[1] ?? null,
        "table_import_not_supported",
        "A table is filled through the table, not an import",
      );
    }
    match = /^\/api\/task\/move\/([^/]+)$/.exec(path);
    if (method === "PUT" && match) {
      const message = "Entries cannot move into or out of a table";
      const fromRow = await rowRefusal(
        [match[1] ?? ""],
        "table_move_not_supported",
        message,
      );
      if (fromRow) return fromRow;
      const destination = (await body(c)).destinationProjectId;
      return projectRefusal(
        typeof destination === "string" ? destination : null,
        "table_move_not_supported",
        message,
      );
    }
    match = TASK_FIELD_ROUTES.exec(path);
    if (method === "PUT" && match) {
      return rowRefusal(
        [match[2] ?? ""],
        "table_row_use_table_route",
        USE_TABLE_ROUTE,
      );
    }
    match = ONE_SEGMENT.exec(path);
    if (match) {
      const id = match[1] ?? "";
      if (method === "POST") {
        return projectRefusal(id, "table_row_use_table_route", USE_TABLE_ROUTE);
      }
      if (method === "PUT" || method === "DELETE") {
        return rowRefusal([id], "table_row_use_table_route", USE_TABLE_ROUTE);
      }
    }
    return null;
  }

  if (method === "PUT" && path === "/api/custom-field/value") {
    const taskId = (await body(c)).taskId;
    return rowRefusal(
      [typeof taskId === "string" ? taskId : ""],
      "table_row_use_table_route",
      USE_TABLE_ROUTE,
    );
  }

  if (
    method === "POST" &&
    (path === "/api/github-integration/import-issues" ||
      path === "/api/gitea-integration/import-issues")
  ) {
    const projectId = (await body(c)).projectId;
    return projectRefusal(
      typeof projectId === "string" ? projectId : null,
      "table_import_not_supported",
      "A table is filled through the table, not an import",
    );
  }

  match = /^\/api\/comment\/([^/]+)$/.exec(path);
  if (match) {
    const message = "Entries of a table have no comments";
    if (method === "POST") {
      return rowRefusal(
        [match[1] ?? ""],
        "table_row_comments_disabled",
        message,
      );
    }
    if (method === "PUT" || method === "DELETE") {
      const [comment] = await db
        .select({ taskId: commentTable.taskId })
        .from(commentTable)
        .where(eq(commentTable.id, match[1] ?? ""))
        .limit(1);
      return comment
        ? rowRefusal([comment.taskId], "table_row_comments_disabled", message)
        : null;
    }
    return null;
  }

  if (path === "/api/task-relation" || path.startsWith("/api/task-relation/")) {
    const message = "Entries of a table have no relations";
    if (method === "POST" && path === "/api/task-relation") {
      const b = await body(c);
      return rowRefusal(
        [b.sourceTaskId, b.targetTaskId].filter(
          (id): id is string => typeof id === "string",
        ),
        "table_row_relations_disabled",
        message,
      );
    }
    match = /^\/api\/task-relation\/([^/]+)$/.exec(path);
    if (method === "DELETE" && match) {
      const [relation] = await db
        .select({
          source: taskRelationTable.sourceTaskId,
          target: taskRelationTable.targetTaskId,
        })
        .from(taskRelationTable)
        .where(eq(taskRelationTable.id, match[1] ?? ""))
        .limit(1);
      return relation
        ? rowRefusal(
            [relation.source, relation.target],
            "table_row_relations_disabled",
            message,
          )
        : null;
    }
    return null;
  }

  match = /^\/api\/project\/([^/]+)$/.exec(path);
  if (method === "DELETE" && match) {
    // Early answer only; delete-project.ts re-checks under the project lock (RF-5).
    const projectId = match[1] ?? "";
    if (!(await isTableProject(projectId))) return null;
    const blocked = await tableDeleteBlock(db, projectId);
    return blocked
      ? {
          reason: blocked,
          projectId,
          taskId: null,
          message: TABLE_DELETE_MESSAGE,
        }
      : null;
  }

  return null;
}

export async function tableRowWriteGuard(c: Context, next: Next) {
  const refusal = await refusalFor(c);
  if (refusal) {
    const log =
      refusal.reason === "table_has_rows" ||
      refusal.reason === "table_outbox_pending"
        ? "[operon] tables.project_delete_refused"
        : "[operon] tables.guard_refused";
    console.warn(log, {
      route: `${c.req.method} ${c.req.routePath ?? c.req.path}`,
      projectId: refusal.projectId,
      taskId: refusal.taskId,
      reason: refusal.reason,
      actorUserId: c.get("userId") ?? null,
    });
    tableError(409, refusal.reason, refusal.message);
  }
  await next();
}

export const TABLE_DELETE_MESSAGE =
  "This table has entries or pending signals. Archive it instead (PUT /api/project/{id}/archive) — its entries and history are kept.";

type DbOrTx = typeof db | Tx;

/** `table_has_rows` / `table_outbox_pending`, or null when the table may be deleted. */
async function tableDeleteBlock(dbOrTx: DbOrTx, projectId: string) {
  const [rows] = await dbOrTx
    .select({ n: count() })
    .from(taskTable)
    .where(eq(taskTable.projectId, projectId));
  if ((rows?.n ?? 0) > 0) return "table_has_rows";
  const [pending] = await dbOrTx
    .select({ n: count() })
    .from(operonTableRowOutboxTable)
    .where(eq(operonTableRowOutboxTable.projectId, projectId));
  if ((pending?.n ?? 0) > 0) return "table_outbox_pending";
  return null;
}

/** Test seam: pause the authoritative delete check after its project lock. */
export const tableDeleteHooks: { afterLock?: () => Promise<void> } = {};

/**
 * RF-5, the authoritative check, inside `deleteProject`'s transaction: lock the project row
 * FOR UPDATE (every row write holds it FOR SHARE, so none can slip in), recount, refuse.
 * An ordinary project passes through untouched.
 */
export async function assertTableProjectDeletable(tx: Tx, projectId: string) {
  await tx
    .select({ id: projectTable.id })
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .for("update");
  const [flag] = await tx
    .select({ projectId: operonTableProjectTable.projectId })
    .from(operonTableProjectTable)
    .where(eq(operonTableProjectTable.projectId, projectId))
    .limit(1);
  if (!flag) return;
  await tableDeleteHooks.afterLock?.();
  const blocked = await tableDeleteBlock(tx, projectId);
  if (blocked) {
    console.warn("[operon] tables.project_delete_refused", {
      projectId,
      reason: blocked,
    });
    tableError(409, blocked, TABLE_DELETE_MESSAGE);
  }
}
