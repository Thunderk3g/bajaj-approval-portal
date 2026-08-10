CREATE TYPE "public"."chain_key" AS ENUM('AUTOPAY', 'MAPPING_WITHIN_TEAM', 'MAPPING_BETWEEN_TEAMS', 'MAPPING_DIY', 'ISSUANCE_DATE', 'BAU_TO_BFL', 'OTHERS', 'AGENT_ID');--> statement-breakpoint
CREATE TYPE "public"."stage_status" AS ENUM('PENDING', 'ACTIVE', 'PASSED', 'RETURNED', 'REJECTED', 'WITHDRAWN');--> statement-breakpoint
ALTER TYPE "public"."correction_category" ADD VALUE 'BAU_TO_BFL';--> statement-breakpoint
ALTER TYPE "public"."event_action" ADD VALUE 'ADVANCED';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'tl';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'acm';--> statement-breakpoint
CREATE TABLE "manpower_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sm_id" text NOT NULL,
	"tl_id" text,
	"ccm_id" text,
	"reason" text,
	"overridden_by" text NOT NULL,
	"overridden_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manpower_override_sm_id_unique" UNIQUE("sm_id"),
	CONSTRAINT "manpower_override_sm_id_uppercase" CHECK ("manpower_override"."sm_id" = upper("manpower_override"."sm_id")),
	CONSTRAINT "manpower_override_not_empty" CHECK ("manpower_override"."tl_id" IS NOT NULL OR "manpower_override"."ccm_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "approval_chain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_key" "chain_key" NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_chain_chain_key_unique" UNIQUE("chain_key")
);
--> statement-breakpoint
CREATE TABLE "approval_chain_stage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"stage_key" text NOT NULL,
	"resolver_key" text NOT NULL,
	"resolver_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"can_reject" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correction_request_stage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"stage_key" text NOT NULL,
	"resolver_key" text NOT NULL,
	"resolver_config" jsonb NOT NULL,
	"can_reject" boolean NOT NULL,
	"status" "stage_status" DEFAULT 'PENDING' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"remarks" text,
	"assigned_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "tl_code" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "acm_code" text;--> statement-breakpoint
ALTER TABLE "sales_record" ADD COLUMN "source_channel" text;--> statement-breakpoint
ALTER TABLE "correction_event" ADD COLUMN "stage_sequence" integer;--> statement-breakpoint
ALTER TABLE "correction_event" ADD COLUMN "stage_key" text;--> statement-breakpoint
ALTER TABLE "correction_request" ADD COLUMN "chain_key" "chain_key";--> statement-breakpoint
ALTER TABLE "correction_request" ADD COLUMN "current_stage_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "correction_request" ADD COLUMN "total_stages" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "correction_request" ADD COLUMN "counterparty_sm_id" text;--> statement-breakpoint
ALTER TABLE "manpower_override" ADD CONSTRAINT "manpower_override_overridden_by_user_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_chain" ADD CONSTRAINT "approval_chain_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_chain_stage" ADD CONSTRAINT "approval_chain_stage_chain_id_approval_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."approval_chain"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request_stage" ADD CONSTRAINT "correction_request_stage_request_id_correction_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."correction_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request_stage" ADD CONSTRAINT "correction_request_stage_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request_stage" ADD CONSTRAINT "correction_request_stage_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_chain_stage_unique" ON "approval_chain_stage" USING btree ("chain_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "correction_request_stage_unique" ON "correction_request_stage" USING btree ("request_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "correction_request_stage_one_active" ON "correction_request_stage" USING btree ("request_id") WHERE status = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "correction_request_stage_request_idx" ON "correction_request_stage" USING btree ("request_id","sequence");--> statement-breakpoint
CREATE INDEX "correction_request_stage_assignee_idx" ON "correction_request_stage" USING btree ("assigned_user_id","status");--> statement-breakpoint
CREATE INDEX "user_tl_code_idx" ON "user" USING btree ("tl_code");--> statement-breakpoint
CREATE INDEX "user_acm_code_idx" ON "user" USING btree ("acm_code");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_tl_requires_tl_code" CHECK ("user"."role"::text <> 'tl' OR "user"."tl_code" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_acm_requires_acm_code" CHECK ("user"."role"::text <> 'acm' OR "user"."acm_code" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_tl_code_uppercase" CHECK ("user"."tl_code" IS NULL OR "user"."tl_code" = upper("user"."tl_code"));--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_acm_code_uppercase" CHECK ("user"."acm_code" IS NULL OR "user"."acm_code" = upper("user"."acm_code"));