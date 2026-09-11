import { eq, max, sql } from "drizzle-orm";
import db from "../../database";
import { columnTable, projectTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  deliverOperonProjectCreatedBounded,
  OPERON_PROJECT_CREATED_EVENT,
} from "../../operon-project-created";

export const DEFAULT_PROJECT_COLUMNS = [
  { name: "To Do", slug: "to-do", position: 0, isFinal: false },
  { name: "In Progress", slug: "in-progress", position: 1, isFinal: false },
  { name: "In Review", slug: "in-review", position: 2, isFinal: false },
  { name: "Done", slug: "done", position: 3, isFinal: true },
] as const;

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
  const createdProject = await db.transaction(async (tx) => {
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
  });

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
  if (createdProject) {
    const created = {
      projectId: createdProject.id,
      workspaceId: createdProject.workspaceId,
      name: createdProject.name,
      slug: createdProject.slug,
      icon: createdProject.icon ?? null,
      currentUserId: currentUserId ?? null,
    };

    await publishEvent(OPERON_PROJECT_CREATED_EVENT, created);
    await deliverOperonProjectCreatedBounded(created);
  }

  return createdProject;
}

export default createProject;
