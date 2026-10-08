import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { operonProjectFieldLabelsTable } from "../database/schema";
import type { BaseVariables } from "../openapi";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";

/**
 * Operon fork addition (social agent S18, docs/fork-discipline.md row 17) — optional
 * per-project labels for the description and due-date fields.
 *
 * `GET  /api/operon/project-field-labels/{projectId}` — anyone with workspace access,
 * Operon's service key included (Operon reads the words for its bot message and comment).
 * `PUT  /api/operon/project-field-labels/{projectId}` — a signed-in project admin only:
 * `project: ["update"]`, and never an API key, so Operon's key can read and cannot write.
 *
 * Empty or whitespace = NULL; both NULL removes the row, so a cleared project is exactly a
 * project that never had labels and renders as upstream. Each label is at most 40
 * characters (400 above that; the table's CHECK is the backstop).
 *
 * A plain Hono router, not `apiRouter().openapi(...)`, for the reason row 3's
 * telegraph-integration router gives: nothing here belongs in the public API document.
 */

export const OPERON_FIELD_LABEL_MAX = 40;

type FieldLabels = {
  projectId: string;
  descriptionLabel: string | null;
  dueDateLabel: string | null;
};

const operonFieldLabels = new Hono<{
  Variables: BaseVariables & { workspaceId: string };
}>();

function projectIdOf(c: Context): string {
  const projectId = c.req.param("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "projectId is required" });
  }
  return projectId;
}

export async function readFieldLabels(projectId: string): Promise<FieldLabels> {
  const [row] = await db
    .select({
      descriptionLabel: operonProjectFieldLabelsTable.descriptionLabel,
      dueDateLabel: operonProjectFieldLabelsTable.dueDateLabel,
    })
    .from(operonProjectFieldLabelsTable)
    .where(eq(operonProjectFieldLabelsTable.projectId, projectId))
    .limit(1);
  return {
    projectId,
    descriptionLabel: row?.descriptionLabel ?? null,
    dueDateLabel: row?.dueDateLabel ?? null,
  };
}

function normalizeLabel(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: `${field} must be a string` });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > OPERON_FIELD_LABEL_MAX) {
    throw new HTTPException(400, {
      message: `${field} must be at most ${OPERON_FIELD_LABEL_MAX} characters`,
    });
  }
  return trimmed;
}

operonFieldLabels.get(
  "/project-field-labels/:projectId",
  workspaceAccess.fromProject("projectId"),
  async (c) => c.json(await readFieldLabels(projectIdOf(c)), 200),
);

operonFieldLabels.put(
  "/project-field-labels/:projectId",
  workspaceAccess.fromProject("projectId"),
  async (c, next) => {
    // A project setting is a person's decision; no API key may make it, whatever its
    // permissions say.
    if (c.get("apiKey")) {
      throw new HTTPException(403, {
        message: "Project field labels are set from a signed-in session",
      });
    }
    await next();
  },
  requireWorkspacePermission({ project: ["update"] }),
  async (c) => {
    const projectId = projectIdOf(c);
    const body = (await c.req.json().catch(() => null)) as {
      descriptionLabel?: unknown;
      dueDateLabel?: unknown;
    } | null;
    if (!body || typeof body !== "object") {
      throw new HTTPException(400, { message: "A JSON body is required" });
    }
    const descriptionLabel = normalizeLabel(
      "descriptionLabel",
      body.descriptionLabel,
    );
    const dueDateLabel = normalizeLabel("dueDateLabel", body.dueDateLabel);

    if (descriptionLabel === null && dueDateLabel === null) {
      await db
        .delete(operonProjectFieldLabelsTable)
        .where(eq(operonProjectFieldLabelsTable.projectId, projectId));
    } else {
      await db
        .insert(operonProjectFieldLabelsTable)
        .values({ projectId, descriptionLabel, dueDateLabel })
        .onConflictDoUpdate({
          target: operonProjectFieldLabelsTable.projectId,
          set: { descriptionLabel, dueDateLabel, updatedAt: new Date() },
        });
    }
    console.log(
      `[operon] operon.field_labels_set: project ${projectId} description=${descriptionLabel !== null} due_date=${dueDateLabel !== null}`,
    );
    return c.json(await readFieldLabels(projectId), 200);
  },
);

export default operonFieldLabels;
