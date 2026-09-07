import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  externalLinkTable,
  integrationTable,
  projectTable,
  taskTable,
} from "../database/schema";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import { externalLinkListSchema } from "./response";
import { createExternalLinkBody, taskIdParam } from "./schema";

const getExternalLinksByTaskRoute = createRoute({
  method: "get",
  operationId: "getExternalLinksByTask",
  path: "/task/{taskId}",
  tags: ["External Links"],
  summary: "Get task external links",
  description:
    "Get all links from a task to resources in connected integrations, such as GitHub or Gitea issues.",
  middleware: [workspaceAccess.fromTaskId("taskId")] as const,
  request: { params: taskIdParam },
  responses: {
    200: jsonResponse("External links for the task", externalLinkListSchema),
    400: errorResponse(
      "Unknown task, or its workspace could not be determined",
    ),
    403: errorResponse("No access to the task's workspace"),
  },
});

const externalLink = apiRouter<
  BaseVariables & { workspaceId: string }
>().openapi(getExternalLinksByTaskRoute, async (c) => {
  const { taskId } = c.req.valid("param");

  const links = await db.query.externalLinkTable.findMany({
    where: eq(externalLinkTable.taskId, taskId),
    with: {
      // Never widen this: integration.config holds plaintext provider
      // secrets and this route is reachable by any workspace member.
      integration: { columns: { id: true, type: true } },
    },
  });

  return c.json(
    links.map((link) => ({
      ...link,
      metadata: link.metadata ? JSON.parse(link.metadata) : null,
    })),
    200,
  );
});

// ---------------------------------------------------------------------------
// Operon fork addition (spec R15, R16, decision 31, task B12):
// POST /api/external-link — the write route Operon attaches a Telegraph message
// link to a task with.
//
// WHY IT IS A PLAIN HONO HANDLER AND NOT AN `.openapi()` ROUTE
// Registering it through `createRoute`/`.openapi()` regenerates
// `apps/docs/openapi.json`, and the whole of `apps/docs/` is off the fork's touch
// list in docs/fork-discipline.md — the same reason task A8 mounted
// `/api/internal/operon` as a plain handler. It is registered on this same router,
// so it sits behind `api.use("*")`'s `authenticateApiRequest` exactly like the read
// route above, and it declares the SAME authorization middleware the read route
// uses, `workspaceAccess.fromTaskId("taskId")`. That middleware reads `taskId` off
// the raw JSON body (its `lookup` source accepts a path param or a body key and
// deliberately refuses the query string), resolves the task's workspace and calls
// `validateWorkspaceAccess` — so an unauthorized caller is refused before this
// handler runs.
//
// IDEMPOTENCY IS THE DATABASE'S JOB, NOT A READ-BEFORE-INSERT
// Migration 0045 adds `UNIQUE (task_id, integration_id, external_id)`. Two
// concurrent retries of the same attach both reach the INSERT; the second blocks on
// the index and is turned into an UPDATE by `ON CONFLICT ... DO UPDATE`, so they
// converge on ONE row and neither errors. A `SELECT` then `INSERT` would interleave
// and write two rows. The integration id is IN the key rather than merely written
// by it — see the note on the constraint in `../database/schema.ts` for the
// upstream behaviour the narrower `(task_id, external_id)` pair would have broken.
// ---------------------------------------------------------------------------
externalLink.post("/", workspaceAccess.fromTaskId("taskId"), async (c) => {
  const parsed = createExternalLinkBody.safeParse(
    await c.req.json().catch(() => ({})),
  );

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw new HTTPException(400, {
      message: issue
        ? `${field || "request"}: ${issue.message}`
        : "Invalid request",
    });
  }

  const { taskId, integrationId, resourceType, externalId, url, title } =
    parsed.data;
  const metadata = parsed.data.metadata ?? null;

  // The integration must exist AND belong to the same project as the task.
  // The FK alone only proves existence, which would let a member of workspace A
  // hang a link off their own task pointing at workspace B's integration row.
  // A miss on either half is a 409: the request names a resource that is not
  // there to be referenced.
  const [pairing] = await db
    .select({
      integrationId: integrationTable.id,
      integrationType: integrationTable.type,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .innerJoin(
      integrationTable,
      and(
        eq(integrationTable.id, integrationId),
        eq(integrationTable.projectId, projectTable.id),
      ),
    )
    .where(eq(taskTable.id, taskId))
    .limit(1);

  if (!pairing) {
    throw new HTTPException(409, {
      message:
        "Unknown integrationId, or it does not belong to the task's project",
    });
  }

  let created: typeof externalLinkTable.$inferSelect | undefined;

  try {
    [created] = await db
      .insert(externalLinkTable)
      .values({
        taskId,
        integrationId,
        resourceType,
        externalId,
        url,
        title: title ?? null,
        metadata: metadata ? JSON.stringify(metadata) : null,
      })
      .onConflictDoUpdate({
        target: [
          externalLinkTable.taskId,
          externalLinkTable.integrationId,
          externalLinkTable.externalId,
        ],
        set: {
          resourceType,
          url,
          title: title ?? null,
          metadata: metadata ? JSON.stringify(metadata) : null,
          updatedAt: new Date(),
        },
      })
      .returning();
  } catch (error) {
    // 23503 = foreign_key_violation. Reachable when the task or the integration
    // is deleted between the check above and this write; drizzle re-throws the pg
    // error either bare or wrapped, so both shapes are inspected.
    if (isForeignKeyViolation(error)) {
      throw new HTTPException(409, {
        message: "Unknown taskId or integrationId",
      });
    }
    throw error;
  }

  if (!created) {
    throw new HTTPException(500, {
      message: "Failed to write the external link",
    });
  }

  return c.json(
    {
      ...created,
      metadata: created.metadata ? JSON.parse(created.metadata) : null,
      // Mirrors the read route's projection exactly: id and type only, never
      // `config`, which holds plaintext provider secrets.
      integration: {
        id: pairing.integrationId,
        type: pairing.integrationType,
      },
    },
    200,
  );
});

function isForeignKeyViolation(error: unknown): boolean {
  const codes: unknown[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current; depth += 1) {
    codes.push((current as { code?: unknown }).code);
    current = (current as { cause?: unknown }).cause;
  }

  return codes.includes("23503");
}

export default externalLink;
