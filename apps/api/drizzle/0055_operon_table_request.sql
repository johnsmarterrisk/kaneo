CREATE TABLE "operon_table_request" (
	"key" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"task_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operon_table_request" ADD CONSTRAINT "operon_table_request_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE cascade;