import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { integrationTable } from "../database/schema";
import type { BaseVariables } from "../openapi";
import {
  TELEGRAPH_INTEGRATION_TYPE,
  type TelegraphConfig,
  validateTelegraphConfig,
} from "../plugins/telegraph";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";

/**
 * `GET`/`POST /api/telegraph-integration/project/{projectId}` — an Operon fork route
 * (Operon spec R15, R16, decision 31, tasks B12 and C19).
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────────────
 *
 * B12 registered the `telegraph` integration TYPE (`../plugins/telegraph/`) but left no
 * way to create a `telegraph` ROW: it is not seeded by a migration — deliberately, because
 * `integrationTable` is keyed `UNIQUE (projectId, type)` and a migration cannot know which
 * projects will exist — and every other integration type gets its row from a
 * `*-integration` router. Without one, Operon's per-project provisioner (spec C19) had
 * nothing to call, and "create task from message" had no `integrationId` to attach an
 * external link to.
 *
 * ── WHY IT IS A PLAIN HONO ROUTER AND NOT AN `apiRouter().openapi(...)` ONE ───────────
 *
 * The same reason A8's `operon-account` and B12's `POST /api/external-link` are:
 * `.openapi()` regenerates `apps/docs/openapi.json`, and the whole of `apps/docs/` is off
 * this fork's declared touch list (`docs/fork-discipline.md` §3). It is mounted inside
 * `api`, after `api.use("*")`'s `authenticateApiRequest`, so it is authenticated exactly
 * like the `generic-webhook-integration` router whose shape it mirrors; what it loses is a
 * line in a document the fork may not edit.
 *
 * ── WHY `POST` IS CREATE-OR-GET AND NOT CREATE-OR-REPLACE ────────────────────────────
 *
 * `generic-webhook-integration`'s `POST` replaces, because its config carries a
 * destination and a secret an operator changes. A `telegraph` config carries neither: it
 * holds one OPTIONAL `apexUrl` recorded for operators reading the row, and the web client
 * deliberately ignores it in favour of its own runtime `OPERON_APEX_URL` (B12,
 * `external-links-accordion.tsx`). So there is nothing here worth overwriting — and the
 * caller is a provisioner that runs every five minutes, which under replace semantics
 * would rewrite `updated_at` on every project forever and bury any real change in noise.
 *
 * ── WHY THE IDEMPOTENCY IS `ON CONFLICT DO NOTHING` AND NOT A READ-BEFORE-INSERT ─────
 *
 * `unique("integration_project_type_unique")` on `(project_id, type)` already exists
 * (`../database/schema.ts`). Letting the index decide means two concurrent provisioning
 * sweeps — two Operon replicas, or a restart overlapping a running interval — converge on
 * ONE row instead of racing between a `findFirst` that saw nothing and an `insert` that
 * then raises. The read that follows is what shapes the response, not what guards the
 * write.
 */

const telegraphIntegration = new Hono<{
  Variables: BaseVariables & { workspaceId: string };
}>();

type TelegraphIntegrationResponse = {
  id: string;
  projectId: string;
  apexUrl: string | null;
  isActive: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Read the project's `telegraph` row, or `null`.
 *
 * The response mirrors the read route in `../external-link/index.ts`: identifiers and
 * timestamps only. `apexUrl` is safe to return in full — unlike every other integration
 * type here, a `telegraph` config holds no credential at all (see `../plugins/telegraph/config.ts`),
 * which is why there is no masking helper in this file.
 */
async function readTelegraphIntegration(
  projectId: string,
): Promise<TelegraphIntegrationResponse | null> {
  const row = await db.query.integrationTable.findFirst({
    where: and(
      eq(integrationTable.projectId, projectId),
      eq(integrationTable.type, TELEGRAPH_INTEGRATION_TYPE),
    ),
  });

  if (!row) {
    return null;
  }

  let apexUrl: string | null = null;
  try {
    const parsed = JSON.parse(row.config) as TelegraphConfig;
    apexUrl = parsed?.apexUrl ?? null;
  } catch {
    // `config` is a plain `text` column, so a hand-edited row can be unparseable. That is
    // an operator's problem to see, not a reason to 500 the provisioner that is trying to
    // converge the project: report the row exists and say its apex is unknown.
    apexUrl = null;
  }

  return {
    id: row.id,
    projectId: row.projectId,
    apexUrl,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The `:projectId` segment, narrowed.
 *
 * A plain Hono router loses the literal-path typing once middleware sits between the
 * pattern and the handler, so `c.req.param` widens to `string | undefined` even though the
 * route cannot match without one. `workspaceAccess.fromProject` has already refused a
 * request with no project by the time a handler runs; this is the type-level restatement of
 * that, not a second check with a different opinion.
 */
function projectIdOf(c: Context): string {
  const projectId = c.req.param("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "projectId is required" });
  }
  return projectId;
}

telegraphIntegration.get(
  "/project/:projectId",
  workspaceAccess.fromProject("projectId"),
  async (c) => {
    return c.json(await readTelegraphIntegration(projectIdOf(c)), 200);
  },
);

telegraphIntegration.post(
  "/project/:projectId",
  workspaceAccess.fromProject("projectId"),
  // The same permission `generic-webhook-integration`'s write routes require, and the
  // exact ceiling Operon's least-privilege API key is minted with (`../auth.ts`,
  // `mintOperonApiKey`). Anything stricter here would make the provisioner uncallable.
  requireWorkspacePermission({ workspace: ["manage_settings"] }),
  async (c) => {
    const projectId = projectIdOf(c);
    // Hono caches the parsed body, so re-reading what `workspaceAccess.fromProject`
    // already consumed is safe. A bodyless POST is legal — `apexUrl` is optional.
    const body = (await c.req.json().catch(() => ({}))) as {
      apexUrl?: unknown;
    };

    const config: TelegraphConfig = {};
    if (body?.apexUrl !== undefined) {
      if (typeof body.apexUrl !== "string") {
        throw new HTTPException(400, { message: "apexUrl must be a string" });
      }
      config.apexUrl = body.apexUrl.trim();
    }

    const validation = await validateTelegraphConfig(config);
    if (!validation.valid) {
      throw new HTTPException(400, {
        message: validation.errors?.join(", ") ?? "Invalid config",
      });
    }

    await db
      .insert(integrationTable)
      .values({
        projectId,
        type: TELEGRAPH_INTEGRATION_TYPE,
        config: JSON.stringify(config),
        isActive: true,
      })
      .onConflictDoNothing({
        target: [integrationTable.projectId, integrationTable.type],
      });

    return c.json(await readTelegraphIntegration(projectId), 200);
  },
);

export default telegraphIntegration;
