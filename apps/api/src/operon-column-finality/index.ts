import { and, eq } from "drizzle-orm";
import db from "../database";
import { columnTable } from "../database/schema";

/**
 * Operon fork addition — the terminal-status fact, resolved by the producer.
 *
 * Kaneo keeps finality on the COLUMN (`column.is_final`), per project and configurable, while
 * the outbound webhook payload carries status SLUGS. A workspace may have a final column named
 * "Shipped" and a non-final one named "Done", so a consumer matching on the word is wrong in
 * both directions — which is why the fact is resolved here, at write time, by the only party
 * that can read the column configuration.
 *
 * `status` IS the column's slug: the lookup is `(projectId, slug)`, exactly as
 * `apps/api/src/task/controllers/update-task-status.ts` resolves the column it stamps onto the
 * task.
 *
 * Returns `undefined` — never `false` — when the column cannot be read: an unknown project, a
 * slug no column carries, or a failed query. Absence is what a consumer must degrade on, and it
 * is deliberately NOT defaulted with `?? false`, because `false` would assert that the status is
 * non-final when the truth is that we do not know.
 */
export async function resolveColumnFinality(
  projectId: string | null | undefined,
  statusSlug: string | null | undefined,
): Promise<boolean | undefined> {
  if (!projectId || !statusSlug) return undefined;

  try {
    const column = await db.query.columnTable.findFirst({
      columns: { isFinal: true },
      where: and(
        eq(columnTable.projectId, projectId),
        eq(columnTable.slug, statusSlug),
      ),
    });

    if (!column) return undefined;

    return column.isFinal;
  } catch (error) {
    // Logged rather than thrown: a webhook delivery must not fail because one optional fact
    // could not be read, and a silent omission with no log line would be invisible state loss.
    console.error("resolveColumnFinality failed", {
      error,
      projectId,
      statusSlug,
    });
    return undefined;
  }
}
