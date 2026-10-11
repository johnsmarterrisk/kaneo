import { eq } from "drizzle-orm";
import db from "../database";
import {
  customFieldDefinitionTable,
  operonTableProjectTable,
  projectTable,
} from "../database/schema";
import type { OperonProjectCreatedDelivery } from "../operon-project-created";
import {
  announceProjectCreated,
  insertProject,
  type ProjectCreatedAnnouncement,
} from "../project/controllers/create-project";
import { TABLE_TEMPLATE_COLUMNS } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Test seam: a failure injected after the template insert must roll back everything (RF-4). */
export const createTableHooks: {
  afterTemplateInsert?: (tx: Tx) => Promise<void>;
} = {};

/**
 * The table's `project.created`, rebuilt from committed rows. The timestamp is the project's
 * own `created_at`, so the create path, its retry ladder and the outbox drain (after a
 * restart) all send byte-identical announcements (spec 7.2, RF-7).
 */
export async function tableAnnouncement(
  projectId: string,
): Promise<ProjectCreatedAnnouncement | null> {
  const [row] = await db
    .select({
      project: projectTable,
      createdBy: operonTableProjectTable.createdByUserId,
    })
    .from(operonTableProjectTable)
    .innerJoin(
      projectTable,
      eq(projectTable.id, operonTableProjectTable.projectId),
    )
    .where(eq(operonTableProjectTable.projectId, projectId))
    .limit(1);
  if (!row) return null;
  return {
    projectId: row.project.id,
    workspaceId: row.project.workspaceId,
    name: row.project.name,
    slug: row.project.slug,
    icon: row.project.icon ?? null,
    currentUserId: row.createdBy,
    operonTable: true,
    timestamp: row.project.createdAt.toISOString(),
  };
}

export async function markTableAnnounced(projectId: string) {
  await db
    .update(operonTableProjectTable)
    .set({ announcedAt: new Date() })
    .where(eq(operonTableProjectTable.projectId, projectId));
  console.log("[operon] tables.table_announced", { projectId });
}

function observeAnnouncement(
  projectId: string,
  delivery: Promise<OperonProjectCreatedDelivery>,
) {
  return delivery
    .then(async (result) => {
      if (result.delivered) await markTableAnnounced(projectId);
      return result;
    })
    .catch((error) => {
      // Never thrown to the caller: the drain recovers an unannounced table (spec 7.4).
      console.error("[operon] tables.table_announce_failed", {
        projectId,
        errorClass: error instanceof Error ? error.name : typeof error,
      });
      return { delivered: false, skipped: "delivery_failed" };
    });
}

/**
 * "New table" (spec 7.2, RF-4): project, flag and template in ONE transaction; the
 * announcement only after it commits, so a failure leaves nothing and announces nothing.
 */
export async function createTable({
  workspaceId,
  name,
  slug,
  icon,
  userId,
}: {
  workspaceId: string;
  name: string;
  slug: string;
  icon: string;
  userId: string;
}) {
  const created = await db.transaction(async (tx) => {
    const project = await insertProject(tx, { workspaceId, name, icon, slug });
    if (!project) throw new Error("project insert returned no row");

    await tx.insert(operonTableProjectTable).values({
      projectId: project.id,
      createdByUserId: userId,
    });

    const ids: Record<string, string> = {};
    for (const [index, column] of TABLE_TEMPLATE_COLUMNS.entries()) {
      const [definition] = await tx
        .insert(customFieldDefinitionTable)
        .values({
          projectId: project.id,
          name: column.name,
          type: column.type,
          required: false,
          defaultValue: null,
          options: column.options === null ? null : [...column.options],
          position: index + 1,
        })
        .returning({ id: customFieldDefinitionTable.id });
      if (!definition) throw new Error(`template column ${column.key} failed`);
      ids[column.key] = definition.id;
    }

    await tx
      .update(operonTableProjectTable)
      .set({
        groupFieldId: ids.topic,
        statusFieldId: ids.status,
        dateFieldId: ids.posted,
      })
      .where(eq(operonTableProjectTable.projectId, project.id));

    await createTableHooks.afterTemplateInsert?.(tx);
    return project;
  });

  console.log("[operon] tables.table_created", {
    projectId: created.id,
    workspaceId,
    userId,
  });

  const announcement = await tableAnnouncement(created.id);
  if (announcement) {
    const { bounded, completion } = await announceProjectCreated(announcement);
    const observed = observeAnnouncement(created.id, completion);
    // Inside the 4 s bound the flag is set before the answer; past it, in the background.
    if (bounded.delivered) await observed;
  }

  return created;
}
