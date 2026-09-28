import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable } from "../../database/schema";

async function updateProject(
  id: string,
  name: string | undefined,
  icon: string | undefined,
  slug: string | undefined,
  description: string | undefined,
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
      // Every field is optional and only written when the caller sent it: the
      // general-settings save omits isPublic (visibility.tsx owns it), and the
      // visibility toggle omits name/icon/slug/description (general.tsx owns
      // those) — each save must leave the fields it doesn't own untouched, not
      // default or overwrite them, so the two pages can never revert each
      // other's concurrent edit.
      ...(name === undefined ? {} : { name }),
      ...(icon === undefined ? {} : { icon }),
      ...(slug === undefined ? {} : { slug }),
      ...(description === undefined ? {} : { description }),
      ...(isPublic === undefined ? {} : { isPublic }),
    })
    .where(eq(projectTable.id, id))
    .returning();

  return updatedWorkspace;
}

export default updateProject;
