-- Operon fork addition (social agent S18, docs/fork-discipline.md row 17).
--
-- Optional per-project labels for the description and due-date fields, at most 40
-- characters each. A project with no row, or with both labels NULL, renders exactly as
-- upstream. Additive: no existing table changes.
CREATE TABLE "operon_project_field_labels" (
	"project_id" text PRIMARY KEY NOT NULL,
	"description_label" text,
	"due_date_label" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operon_project_field_labels_length" CHECK (char_length("operon_project_field_labels"."description_label") <= 40 AND char_length("operon_project_field_labels"."due_date_label") <= 40)
);
--> statement-breakpoint
ALTER TABLE "operon_project_field_labels" ADD CONSTRAINT "operon_project_field_labels_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE cascade;