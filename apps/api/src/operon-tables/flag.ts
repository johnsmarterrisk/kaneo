import { sql } from "drizzle-orm";
import db from "../database";

/**
 * Operon fork addition (Tables task 5, docs/fork-discipline.md row 18, spec 7.4): whether
 * the generic-webhook plugin must skip a project because it is a table — a table row is
 * delivered only by the durable Tables outbox, and a best-effort delivery beside it would
 * double its signal.
 *
 * Deliberately a light module (only the database handle) so the plugin does not pull the
 * Tables routes into its import graph. A failed lookup answers false and is logged: the
 * plugin's own next query reads the same database and fails the same way, so a database
 * outage still delivers nothing.
 */
export async function skipForTableProject(projectId: string): Promise<boolean> {
  try {
    const result = await db.execute(
      sql`SELECT 1 FROM operon_table_project WHERE project_id = ${projectId} LIMIT 1`,
    );
    return (result.rows?.length ?? 0) > 0;
  } catch (error) {
    console.error("[operon] tables.webhook_table_check_failed", {
      projectId,
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}
