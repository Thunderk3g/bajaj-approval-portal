--
-- Agent ID: the new business-dashboard column, and the correction category that
-- lets a rep dispute it.
--
-- `ADD VALUE` runs inside the migration transaction, which is safe here only
-- because nothing in this file USES 'AGENT_ID'. Postgres refuses to read a
-- newly added enum value in the transaction that added it, so a backfill or a
-- CHECK naming the new category would have to be a separate migration.
--
-- Nothing is backfilled. Every existing row genuinely has no agent recorded —
-- the column did not exist when those workbooks were imported — and NULL says
-- exactly that, where any invented default would assert an agent nobody named.
--
ALTER TYPE "public"."correction_category" ADD VALUE 'AGENT_ID';--> statement-breakpoint
ALTER TABLE "sales_record" ADD COLUMN "agent_id" text;
