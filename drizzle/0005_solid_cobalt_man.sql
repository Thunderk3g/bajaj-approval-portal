ALTER TABLE "upload_batch" DROP CONSTRAINT "upload_batch_period_id_period_id_fk";
--> statement-breakpoint
ALTER TABLE "upload_batch" DROP COLUMN "period_id";