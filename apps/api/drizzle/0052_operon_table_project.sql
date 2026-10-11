CREATE TABLE "operon_table_project" (
	"project_id" text PRIMARY KEY NOT NULL,
	"group_field_id" text,
	"date_field_id" text,
	"status_field_id" text,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"announced_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "operon_table_project" ADD CONSTRAINT "operon_table_project_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "operon_table_project" ADD CONSTRAINT "operon_table_project_group_field_id_custom_field_definition_id_fk" FOREIGN KEY ("group_field_id") REFERENCES "public"."custom_field_definition"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "operon_table_project" ADD CONSTRAINT "operon_table_project_date_field_id_custom_field_definition_id_fk" FOREIGN KEY ("date_field_id") REFERENCES "public"."custom_field_definition"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "operon_table_project" ADD CONSTRAINT "operon_table_project_status_field_id_custom_field_definition_id_fk" FOREIGN KEY ("status_field_id") REFERENCES "public"."custom_field_definition"("id") ON DELETE set null ON UPDATE cascade;