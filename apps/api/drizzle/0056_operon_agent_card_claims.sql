CREATE TABLE "agent_card_claims" (
	"task_id" text PRIMARY KEY NOT NULL,
	"claimer" text NOT NULL,
	"generation" integer NOT NULL,
	"state" text NOT NULL,
	"request_id" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_card_claims_state" CHECK ("agent_card_claims"."state" IN ('active', 'released', 'revoked', 'done'))
);
--> statement-breakpoint
ALTER TABLE "agent_card_claims" ADD CONSTRAINT "agent_card_claims_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_card_claims" ADD CONSTRAINT "agent_card_claims_claimer_user_id_fk" FOREIGN KEY ("claimer") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;