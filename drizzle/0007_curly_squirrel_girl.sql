CREATE TYPE "public"."ingest_job_kind" AS ENUM('PARSE', 'LEADS', 'PROOF');--> statement-breakpoint
CREATE TYPE "public"."ingest_job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TABLE "ingest_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ingest_job_kind" NOT NULL,
	"status" "ingest_job_status" DEFAULT 'QUEUED' NOT NULL,
	"batch_id" uuid,
	"stage" text,
	"done" integer DEFAULT 0 NOT NULL,
	"total" integer,
	"result" jsonb,
	"error" text,
	"requested_by" text,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_no" text NOT NULL,
	"sm_code" text,
	"sm_name" text,
	"tl_name" text,
	"ccm_name" text,
	"ccm_code" text,
	"location" text,
	"location_alt" text,
	"register_date" date,
	"source" text,
	"product_type" text,
	"product_mix" text,
	"prod_id" text,
	"saving_flag" text,
	"is_unassigned" boolean DEFAULT false NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_batch_id" uuid,
	"period_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_lead_no_unique" UNIQUE("lead_no"),
	CONSTRAINT "lead_sm_code_uppercase" CHECK ("lead"."sm_code" IS NULL OR "lead"."sm_code" = upper("lead"."sm_code"))
);
--> statement-breakpoint
ALTER TABLE "ingest_job" ADD CONSTRAINT "ingest_job_batch_id_upload_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."upload_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_job" ADD CONSTRAINT "ingest_job_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_source_batch_id_upload_batch_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."upload_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_period_id_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_job_batch_idx" ON "ingest_job" USING btree ("batch_id","created_at");--> statement-breakpoint
CREATE INDEX "ingest_job_status_idx" ON "ingest_job" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "lead_sm_code_idx" ON "lead" USING btree ("sm_code");--> statement-breakpoint
CREATE INDEX "lead_batch_idx" ON "lead" USING btree ("source_batch_id");--> statement-breakpoint
CREATE INDEX "lead_register_date_idx" ON "lead" USING btree ("register_date");--> statement-breakpoint
CREATE INDEX "lead_unassigned_idx" ON "lead" USING btree ("is_unassigned");