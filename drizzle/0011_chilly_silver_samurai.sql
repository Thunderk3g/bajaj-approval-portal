ALTER TABLE "upload_batch" ADD COLUMN "roster_committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_batch" ADD COLUMN "roster_committed_by" text;--> statement-breakpoint
ALTER TABLE "upload_batch" ADD COLUMN "roster_row_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_batch" ADD CONSTRAINT "upload_batch_roster_committed_by_user_id_fk" FOREIGN KEY ("roster_committed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;