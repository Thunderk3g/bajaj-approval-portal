CREATE TYPE "public"."batch_status" AS ENUM('DRAFT', 'MAPPED', 'VALIDATED', 'COMMITTED', 'FAILED', 'ABORTED');--> statement-breakpoint
CREATE TYPE "public"."change_type" AS ENUM('IMPORT', 'CORRECTION', 'REIMPORT', 'ADMIN_EDIT');--> statement-breakpoint
CREATE TYPE "public"."correction_category" AS ENUM('AUTOPAY', 'MAPPING', 'ISSUANCE_DATE', 'OTHERS');--> statement-breakpoint
CREATE TYPE "public"."correction_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'RETURNED');--> statement-breakpoint
CREATE TYPE "public"."event_action" AS ENUM('SUBMITTED', 'RESUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'sales', 'approver');--> statement-breakpoint
CREATE TYPE "public"."row_status" AS ENUM('VALID', 'INVALID', 'DUPLICATE', 'COMMITTED', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" "role" DEFAULT 'sales' NOT NULL,
	"sm_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_sales_requires_sm_id" CHECK ("user"."role" <> 'sales' OR "user"."sm_id" IS NOT NULL),
	CONSTRAINT "user_sm_id_uppercase" CHECK ("user"."sm_id" IS NULL OR "user"."sm_id" = upper("user"."sm_id"))
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apps_no" text NOT NULL,
	"policy_no" text,
	"client_name" text,
	"lead_id" text,
	"sm_id" text NOT NULL,
	"sm_name" text,
	"tl_id" text,
	"tl_name" text,
	"ccm_id" text,
	"ccm_name" text,
	"location" text,
	"login_date" date,
	"issued_date" date,
	"fp" numeric(18, 2),
	"anp" numeric(18, 2),
	"product_name" text,
	"product_type" text,
	"product_variant" text,
	"booking_frequency" text,
	"pay_mode" text,
	"status" text,
	"status_2" text,
	"autopay" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_batch_id" uuid,
	"source_row_number" integer,
	"current_version" integer DEFAULT 1 NOT NULL,
	"has_corrections" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_record_apps_no_unique" UNIQUE("apps_no"),
	CONSTRAINT "sales_record_sm_id_uppercase" CHECK ("sales_record"."sm_id" = upper("sales_record"."sm_id"))
);
--> statement-breakpoint
CREATE TABLE "sales_record_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"change_type" "change_type" NOT NULL,
	"changed_fields" text[],
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correction_request_id" uuid,
	"batch_id" uuid,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "upload_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_file_name" text NOT NULL,
	"stored_path" text NOT NULL,
	"file_hash" text NOT NULL,
	"sheet_name" text,
	"header_row" integer DEFAULT 1 NOT NULL,
	"date_format" text DEFAULT 'dd/MM/yyyy' NOT NULL,
	"column_mapping" jsonb,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"invalid_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"status" "batch_status" DEFAULT 'DRAFT' NOT NULL,
	"validation_report" jsonb,
	"notes" text,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_by" text,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "upload_batch_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"normalized" jsonb,
	"issues" jsonb,
	"is_duplicate" boolean DEFAULT false NOT NULL,
	"duplicate_of_row" integer,
	"status" "row_status" DEFAULT 'VALID' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correction_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"stored_path" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correction_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"action" "event_action" NOT NULL,
	"actor_id" text,
	"from_status" text,
	"to_status" text,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correction_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"apps_no" text NOT NULL,
	"category" "correction_category" NOT NULL,
	"field_name" text NOT NULL,
	"field_label" text NOT NULL,
	"original_value" text,
	"proposed_value" text NOT NULL,
	"description" text,
	"submitted_by" text NOT NULL,
	"sm_id" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "correction_status" DEFAULT 'PENDING' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"approver_remarks" text,
	"applied_at" timestamp with time zone,
	"applied_version" integer,
	"resubmission_count" integer DEFAULT 0 NOT NULL,
	"last_resubmitted_at" timestamp with time zone,
	CONSTRAINT "correction_others_requires_description" CHECK ("correction_request"."category" <> 'OTHERS' OR ("correction_request"."description" IS NOT NULL AND length(trim("correction_request"."description")) > 0))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"actor_role" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "excel_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by" text NOT NULL,
	"file_name" text NOT NULL,
	"stored_path" text NOT NULL,
	"sha256" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"correction_count" integer DEFAULT 0 NOT NULL,
	"filters" jsonb,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_record" ADD CONSTRAINT "sales_record_source_batch_id_upload_batch_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."upload_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_record_version" ADD CONSTRAINT "sales_record_version_record_id_sales_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."sales_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_record_version" ADD CONSTRAINT "sales_record_version_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_record_version" ADD CONSTRAINT "sales_record_version_batch_id_upload_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."upload_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_batch" ADD CONSTRAINT "upload_batch_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_batch" ADD CONSTRAINT "upload_batch_committed_by_user_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_batch_row" ADD CONSTRAINT "upload_batch_row_batch_id_upload_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."upload_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_attachment" ADD CONSTRAINT "correction_attachment_request_id_correction_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."correction_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_attachment" ADD CONSTRAINT "correction_attachment_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_event" ADD CONSTRAINT "correction_event_request_id_correction_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."correction_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_event" ADD CONSTRAINT "correction_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request" ADD CONSTRAINT "correction_request_record_id_sales_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."sales_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request" ADD CONSTRAINT "correction_request_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request" ADD CONSTRAINT "correction_request_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excel_export" ADD CONSTRAINT "excel_export_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sm_id_idx" ON "user" USING btree ("sm_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "sales_record_sm_id_idx" ON "sales_record" USING btree ("sm_id");--> statement-breakpoint
CREATE INDEX "sales_record_status_idx" ON "sales_record" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sales_record_issued_date_idx" ON "sales_record" USING btree ("issued_date");--> statement-breakpoint
CREATE INDEX "sales_record_policy_no_idx" ON "sales_record" USING btree ("policy_no");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_record_version_unique" ON "sales_record_version" USING btree ("record_id","version");--> statement-breakpoint
CREATE INDEX "upload_batch_status_idx" ON "upload_batch" USING btree ("status");--> statement-breakpoint
CREATE INDEX "upload_batch_hash_idx" ON "upload_batch" USING btree ("file_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_batch_row_unique" ON "upload_batch_row" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "upload_batch_row_status_idx" ON "upload_batch_row" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "correction_attachment_request_idx" ON "correction_attachment" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "correction_event_request_idx" ON "correction_event" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "correction_request_status_idx" ON "correction_request" USING btree ("status");--> statement-breakpoint
CREATE INDEX "correction_request_sm_id_idx" ON "correction_request" USING btree ("sm_id");--> statement-breakpoint
CREATE INDEX "correction_request_record_idx" ON "correction_request" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("user_id","is_read","created_at");