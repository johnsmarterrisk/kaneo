import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  apikeyTable,
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
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
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
// route above.
//
// TWO MIDDLEWARES, NOT ONE, AND THE SECOND IS THE POINT
// `workspaceAccess.fromTaskId("taskId")` reads `taskId` off the raw JSON body (its
// `lookup` source accepts a path param or a body key and deliberately refuses the
// query string), resolves the task's workspace and calls `validateWorkspaceAccess`.
// That answers "are you IN this workspace" and nothing else — which is how the first
// revision let a VIEWER, and an API key with no `task` scope at all, insert and
// overwrite links. Reading a task and writing to one are not the same right.
//
// `requireWorkspacePermission({ task: ["update"] })` is therefore chained after it:
// the exact permission every upstream task-mutating route already demands
// (`apps/api/src/task/index.ts`), so a viewer gets the same 403 here that they get
// there, and an API key whose `permissions` omit `task: ["update"]` is refused by the
// key-ceiling branch of that middleware before the workspace role is even consulted.
// The Operon service key carries the scope deliberately
// (`OPERON_SERVICE_KEY_PERMISSIONS` in `auth.ts`).
//
// TELEGRAPH ONLY
// A project may legitimately carry a `github` or `gitea` integration beside its
// `telegraph` one, and upstream's `plugins/*/services/link-manager.ts` treats the
// rows under those integrations as its own synchronisation state. This fork route
// exists for Telegraph message links; pointing it at a GitHub integration would let a
// workspace member rewrite records upstream's synchroniser trusts. Any other
// integration type is a 409 — the request names a resource that is not there for THIS
// route to write.
//
// IDEMPOTENCY IS THE DATABASE'S JOB, NOT A READ-BEFORE-INSERT
// Migration 0045 adds `UNIQUE (task_id, integration_id, resource_type, external_id)`.
// `resource_type` is part of the key: branch "5" and issue #5 are two legitimate
// links from one task through one integration. Two concurrent retries of the same
// attach both reach the INSERT; the second blocks on the index and is turned into
// an UPDATE by `ON CONFLICT ... DO UPDATE`, so they converge on ONE row and neither
// errors. A `SELECT` then `INSERT` would interleave and write two rows. The
// integration id is IN the key rather than merely written by it — see the note on
// the constraint in `../database/schema.ts` for the upstream behaviour the narrower
// `(task_id, external_id)` pair would have broken.
// ---------------------------------------------------------------------------
const OPERON_SERVICE_MARKER = "operonService";
const OPERON_ON_BEHALF_OF_HEADER = "X-Operon-On-Behalf-Of";

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    // The api-key plugin has shipped double-stringified metadata in the past; a
    // second parse costs nothing and means a legacy row is read rather than
    // silently failing the marker check.
    if (typeof value === "string") {
      const inner: unknown = JSON.parse(value);
      return inner && typeof inner === "object" && !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : null;
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Operon fork addition (spec S11): the on-behalf-of gate.
 *
 * Operon's service key is minted against ONE user id — the workspace owner — so a
 * naive server-side call would perform every user's link write AS THE OWNER,
 * silently granting a Kaneo viewer a write a viewer is refused. A request carrying
 * `X-Operon-On-Behalf-Of: <kaneo user id>` AND authenticated by a key whose ROW
 * carries the unforgeable `{ operonService: true }` marker therefore rebinds
 * `c.set("userId", …)` BEFORE `requireWorkspacePermission` runs, so BOTH the API
 * key ceiling and the initiating user's role must pass.
 *
 * THE MARKER IS NOT IN THE REQUEST CONTEXT, and that is the trap this gate exists
 * to avoid. `authenticateApiRequest` projects only `{id, userId, enabled,
 * permissions}` into `c.get("apiKey")`, so reading `c.get("apiKey").metadata`
 * would evaluate falsy and silently ignore the header on the genuine service key —
 * collapsing every on-behalf-of call back to the owner's authority. The row is
 * re-read by id instead, exactly as `resolveOperonServiceKeyHolder`
 * (`apps/api/src/operon-account/index.ts`) does. The marker escapes client control
 * because `hooks.before` refuses client-supplied metadata, so no caller can mint
 * themselves a marked key; the header is IGNORED, never trusted, on any credential
 * whose row does not carry it.
 */
async function rebindOnBehalfOf(c: Context, next: Next) {
  const requested = c.req.header(OPERON_ON_BEHALF_OF_HEADER)?.trim();
  if (!requested) return next();

  const apiKey = c.get("apiKey") as { id?: string } | undefined;
  // A browser session has no context key id and gets no rebinding.
  if (!apiKey?.id) return next();

  const [row] = await db
    .select({ metadata: apikeyTable.metadata })
    .from(apikeyTable)
    .where(eq(apikeyTable.id, apiKey.id))
    .limit(1);

  const metadata = parseJsonObject(row?.metadata ?? null);
  if (metadata?.[OPERON_SERVICE_MARKER] !== true) return next();

  c.set("userId", requested);
  return next();
}

externalLink.post(
  "/",
  workspaceAccess.fromTaskId("taskId"),
  rebindOnBehalfOf,
  requireWorkspacePermission({ task: ["update"] }),
  async (c) => {
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

    if (pairing.integrationType !== TELEGRAPH_INTEGRATION_TYPE) {
      throw new HTTPException(409, {
        message: "This route writes telegraph links only",
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
          // The same four columns migration 0045 makes unique. `resource_type` is
          // in the key because upstream's `{number}` branch pattern means branch "5"
          // and issue #5 are two legitimate links from one task through one
          // integration; a three-column key rejected the second, or refused to
          // migrate an instance that already held both.
          target: [
            externalLinkTable.taskId,
            externalLinkTable.integrationId,
            externalLinkTable.resourceType,
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
  },
);

/**
 * The integration type this write route is for. Declared here rather than imported
 * from `plugins/telegraph/config.ts` so the route carries no plugin dependency.
 */
const TELEGRAPH_INTEGRATION_TYPE = "telegraph";

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
