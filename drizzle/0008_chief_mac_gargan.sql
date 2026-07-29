CREATE TYPE "public"."mapping_direction" AS ENUM('CLAIM_IN', 'TRANSFER_OUT');--> statement-breakpoint
ALTER TABLE "correction_request" ADD COLUMN "direction" "mapping_direction";--> statement-breakpoint
--
-- Backfill, hand-added between the generated ADD COLUMN and ADD CONSTRAINT.
--
-- Every MAPPING row that exists before this migration is a claim by
-- construction: the pull was the only path that could produce one, since
-- submitCorrection pinned proposed_value to the claimant's own SM_ID.
--
-- This MUST stay ahead of the CHECK below. The constraint is validated against
-- existing rows at ADD time, so on any database that has ever taken a mapping
-- correction the generated order alone aborts the migration.
--
UPDATE "correction_request" SET "direction" = 'CLAIM_IN'
 WHERE "category" = 'MAPPING' AND "direction" IS NULL;--> statement-breakpoint
ALTER TABLE "correction_request" ADD CONSTRAINT "correction_direction_iff_mapping" CHECK (("correction_request"."category" = 'MAPPING') = ("correction_request"."direction" IS NOT NULL));