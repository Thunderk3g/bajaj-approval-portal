CREATE TABLE "manpower" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sm_id" text NOT NULL,
	"sm_name" text,
	"tl_id" text,
	"tl_name" text,
	"ccm_id" text,
	"ccm_name" text,
	"location" text,
	"is_orphan" boolean DEFAULT false NOT NULL,
	"source_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manpower_sm_id_unique" UNIQUE("sm_id"),
	CONSTRAINT "manpower_sm_id_uppercase" CHECK ("manpower"."sm_id" = upper("manpower"."sm_id"))
);
--> statement-breakpoint
ALTER TABLE "manpower" ADD CONSTRAINT "manpower_source_batch_id_upload_batch_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."upload_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manpower_orphan_idx" ON "manpower" USING btree ("is_orphan");