import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable } from "../../database/schema";
import { assertTableProjectDeletable } from "../../operon-tables/guard";
import getProject from "./get-project";

async function deleteProject(id: string, workspaceId: string) {
  const existingProject = await getProject(id, workspaceId);

  // Operon fork addition (Tables, docs/fork-discipline.md row 18, spec 7.5 / RF-5): a table
  // with entries or pending signals is not deleted — the cascade would erase its rows
  // without their signals. The check and the delete share one transaction under the
  // project lock every row write also takes. An ordinary project is deleted as before.
  const [deletedProject] = await db.transaction(async (tx) => {
    await assertTableProjectDeletable(tx, id);
    return tx.delete(projectTable).where(eq(projectTable.id, id)).returning();
  });

  if (!deletedProject) {
    throw new HTTPException(500, {
      message: "Failed to delete project",
    });
  }

  return existingProject;
}

export default deleteProject;
