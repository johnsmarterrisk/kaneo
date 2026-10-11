CREATE TABLE "operon_table_row_meta" (
	"task_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_writer_user_id" text NOT NULL,
	"last_write_id" uuid NOT NULL,
	"last_changed_at" timestamp DEFAULT now() NOT NULL,
	"last_change" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operon_table_row_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"event" text NOT NULL,
	"write_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_status" integer,
	"last_error_class" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operon_table_row_outbox_event_write_task_unique" UNIQUE("event","write_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "operon_table_value_history" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"field_id" text NOT NULL,
	"write_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operon_table_row_meta" ADD CONSTRAINT "operon_table_row_meta_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "operon_table_value_history" ADD CONSTRAINT "operon_table_value_history_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "operon_table_row_outbox_project_idx" ON "operon_table_row_outbox" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "operon_table_row_outbox_task_idx" ON "operon_table_row_outbox" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "operon_table_value_history_project_field_idx" ON "operon_table_value_history" USING btree ("project_id","field_id","created_at");