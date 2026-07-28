CREATE TYPE "public"."period_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
ALTER TYPE "public"."correction_status" ADD VALUE 'VERIFIED' BEFORE 'APPROVED';--> statement-breakpoint
ALTER TYPE "public"."event_action" ADD VALUE 'VERIFIED' BEFORE 'APPROVED';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'verifier';--> statement-breakpoint
CREATE TABLE "period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "period_status" DEFAULT 'OPEN' NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"opened_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "period_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "sales_record" ADD COLUMN "period_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_batch" ADD COLUMN "period_id" uuid;--> statement-breakpoint
ALTER TABLE "correction_request" ADD COLUMN "period_id" uuid;--> statement-breakpoint
ALTER TABLE "correction_request" ADD COLUMN "verified_by" text;--> statement-breakpoint
ALTER TABLE "correction_request" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "correction_request" ADD COLUMN "verifier_remarks" text;--> statement-breakpoint
ALTER TABLE "period" ADD CONSTRAINT "period_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period" ADD CONSTRAINT "period_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "period_status_idx" ON "period" USING btree ("status");--> statement-breakpoint
ALTER TABLE "sales_record" ADD CONSTRAINT "sales_record_period_id_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_batch" ADD CONSTRAINT "upload_batch_period_id_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request" ADD CONSTRAINT "correction_request_period_id_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_request" ADD CONSTRAINT "correction_request_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_record_period_idx" ON "sales_record" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "correction_request_period_idx" ON "correction_request" USING btree ("period_id");