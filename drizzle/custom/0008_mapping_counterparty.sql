--
-- The counterparty lookup index — 2026-07-29 spec section 3.4.
--
-- The "involving my book" list asks a question no existing index answers:
-- which OPEN mapping requests name my SM_ID as the destination? The owning side
-- of that question is already covered — it joins through record_id to
-- sales_record, whose sm_id carries sales_record_sm_id_idx — but the gaining
-- side reads proposed_value, which is plain text on correction_request and
-- until now was only ever read one row at a time.
--
-- Partial on both axes. Restricting to MAPPING keeps out the AUTOPAY rows that
-- dominate the table by volume and whose proposed_value is 'Yes' or 'No' —
-- two values across thousands of rows, which is exactly the low-cardinality
-- shape that makes an index useless. Restricting to the open statuses keeps the
-- index from growing without bound as decided requests accumulate, since a
-- decided request can never appear in the list.
--
-- The status list is the same triple as correction_one_open_per_field in
-- 0002, and for the same reason: RETURNED is still open — it is back with the
-- submitter and will return to the queue — so the counterparty must keep seeing
-- it. If a status is ever added to the open set, BOTH files change together.
--
-- Not unique. Two different records may each have an open transfer to the same
-- rep; that is a rep receiving two policies, not a conflict. Uniqueness of the
-- ownership dispute is per record, and 0002 already enforces it.
--
-- DROP-then-CREATE rather than CREATE IF NOT EXISTS, matching 0002: this file
-- re-runs on every db:custom, and an index left over from an earlier predicate
-- would report as present while silently failing to cover the current one.
--
DROP INDEX IF EXISTS correction_mapping_proposed_open;

CREATE INDEX correction_mapping_proposed_open
  ON correction_request (proposed_value)
  WHERE category = 'MAPPING' AND status IN ('PENDING', 'VERIFIED', 'RETURNED');
