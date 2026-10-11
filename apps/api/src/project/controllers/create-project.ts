import { eq, max, sql } from "drizzle-orm";
import db from "../../database";
import { columnTable, projectTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  deliverOperonProjectCreatedBounded,
  OPERON_PROJECT_CREATED_EVENT,
  type OperonProjectCreatedDelivery,
  startOperonProjectCreatedDelivery,
} from "../../operon-project-created";

export const DEFAULT_PROJECT_COLUMNS = [
  { name: "To Do", slug: "to-do", position: 0, isFinal: false },
  { name: "In Progress", slug: "in-progress", position: 1, isFinal: false },
  { name: "In Review", slug: "in-review", position: 2, isFinal: false },
  { name: "Done", slug: "done", position: 3, isFinal: true },
] as const;

/**
 * Operon fork addition (Tables, docs/fork-discipline.md row 18, spec RF-4): the body of
 * row 12's transaction, moved here VERBATIM so a table can insert its project, flag and
 * template in ONE transaction and announce only after it commits. `createProject` below
 * calls it exactly as before, so an ordinary project is created and announced unchanged.
 */
export async function insertProject(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  {
    workspaceId,
    name,
    icon,
    slug,
  }: { workspaceId: string; name: string; icon: string; slug: string },
) {
  // Serialize ordering writes per workspace: without this, two concurrent
  // creates can read the same max(position) and land on the same slot, and a
  // create can interleave with a reorder's renumber. `reorderProjects` takes
  // the same lock with the same key.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(1524, hashtext(${workspaceId}))`,
  );

  // New projects go to the bottom of the workspace's ordering.
  const [{ maxPosition } = { maxPosition: null }] = await tx
    .select({ maxPosition: max(projectTable.position) })
    .from(projectTable)
    .where(eq(projectTable.workspaceId, workspaceId));

  const [createdProject] = await tx
    .insert(projectTable)
    .values({
      workspaceId,
      name,
      icon,
      slug,
      position: maxPosition === null ? 0 : maxPosition + 1,
    })
    .returning();

  if (createdProject) {
    for (const col of DEFAULT_PROJECT_COLUMNS) {
      await tx.insert(columnTable).values({
        projectId: createdProject.id,
        name: col.name,
        slug: col.slug,
        position: col.position,
        isFinal: col.isFinal,
      });
    }
  }

  return createdProject;
}

export type ProjectCreatedAnnouncement = {
  projectId: string;
  workspaceId: string;
  name: string;
  slug: string;
  icon: string | null;
  currentUserId: string | null;
  // Tables (row 18): the table marker and its stable timestamp, absent for a project.
  operonTable?: boolean;
  timestamp?: string;
};

/**
 * Operon fork addition (Tables, row 18): row 12's announcement lines, moved VERBATIM. It
 * returns the existing 4 s bounded result (all `createProject` waits for) and the original
 * delivery ladder's own completion promise, which `createTable` observes to set
 * `announced_at` without starting a second attempt after a fast success.
 */
export async function announceProjectCreated(
  created: ProjectCreatedAnnouncement,
): Promise<{
  bounded: OperonProjectCreatedDelivery;
  completion: Promise<OperonProjectCreatedDelivery>;
}> {
  // Operon fork addition: a project created here announced itself to NOBODY at the fork
  // point — this was the only lifecycle event in the codebase with no `publishEvent` — so a
  // consumer could not know a project existed until something happened inside it. It is
  // published AFTER the transaction commits, never inside it, because a subscriber that
  // called back into the API would be reading a project the open transaction still hides.
  //
  // The DELIVERY is awaited separately and not through the bus: `publishEvent` is
  // `EventEmitter.emit`, which does not await an async listener, so publishing alone let this
  // function answer while the delivery and Operon's provisioning were still in flight — and a
  // task created a moment later could still find a project with no integration row, which is
  // the exact window the event exists to close. The wait is bounded at four seconds and the
  // delivery keeps retrying in the background past it, so a slow or unreachable Operon costs
  // the person a short pause and never their project. The publish stays for any other
  // consumer; the two share one deduped delivery.
  // See `operon-project-created/index.ts` for why the delivery cannot be a plugin handler.
  await publishEvent(OPERON_PROJECT_CREATED_EVENT, created);
  // The bus subscriber started the one deduped ladder; this joins it rather than starting another.
  const completion = startOperonProjectCreatedDelivery(created);
  const bounded = await deliverOperonProjectCreatedBounded(created);
  return { bounded, completion };
}

async function createProject(
  workspaceId: string,
  name: string,
  icon: string,
  slug: string,
  // Operon fork addition: the creator, optional and TRAILING so every existing caller and
  // the `DEFAULT_PROJECT_COLUMNS` importers are unaffected. Same current-user rule as
  // `task.created` — the route reads `c.get("userId")`.
  currentUserId?: string | null,
) {
  const createdProject = await db.transaction((tx) =>
    insertProject(tx, { workspaceId, name, icon, slug }),
  );

  if (createdProject) {
    await announceProjectCreated({
      projectId: createdProject.id,
      workspaceId: createdProject.workspaceId,
      name: createdProject.name,
      slug: createdProject.slug,
      icon: createdProject.icon ?? null,
      currentUserId: currentUserId ?? null,
    });
  }

  return createdProject;
}

export default createProject;
