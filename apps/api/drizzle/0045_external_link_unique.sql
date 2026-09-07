-- Operon fork addition (spec R15, R35, decision 31, task B12).
--
-- `resource_type` IS IN THE KEY. Upstream supports the `{number}` branch pattern,
-- so branch "5" and issue #5 are two legitimate links from one task through one
-- integration; a `(task_id, integration_id, external_id)` key rejected the second
-- write, and refused to apply at all on an instance that already held both.
--
-- DROP IF EXISTS FIRST, because this file was corrected in place: the only
-- database that ever applied the three-column form is the local volume, and
-- drizzle re-runs a migration whose journal `when` moved. Re-running the ADD
-- alone would fail on the constraint name that is already there.
ALTER TABLE "external_link" DROP CONSTRAINT IF EXISTS "external_link_task_integration_external_unique";
--> statement-breakpoint
ALTER TABLE "external_link" ADD CONSTRAINT "external_link_task_integration_external_unique" UNIQUE("task_id","integration_id","resource_type","external_id");