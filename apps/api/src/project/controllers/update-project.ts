import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable } from "../../database/schema";

async function updateProject(
  id: string,
  name: string,
  icon: string,
  slug: string,
  description: string,
  isPublic: boolean | undefined,
  workspaceId: string,
) {
  const [existingProject] = await db
    .select()
    .from(projectTable)
    .where(
      and(eq(projectTable.id, id), eq(projectTable.workspaceId, workspaceId)),
    );

  const isProjectExisting = Boolean(existingProject);

  if (!isProjectExisting) {
    throw new HTTPException(404, {
      message:
        "Project doesn't exist or doesn't belong to the specified workspace",
    });
  }

  const [updatedWorkspace] = await db
    .update(projectTable)
    .set({
      name,
      icon,
      slug,
      description,
      // The general-settings save omits isPublic (visibility.tsx owns it via its
      // own call to this same route) — leave the stored value untouched rather
      // than defaulting it, so a rename can never silently flip visibility.
      ...(isPublic === undefined ? {} : { isPublic }),
    })
    .where(eq(projectTable.id, id))
    .returning();

  return updatedWorkspace;
}

export default updateProject;
