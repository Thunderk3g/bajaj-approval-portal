-- Two reps must not both hold an open claim on the same field of the same
-- record: approving both would produce a lost update. drizzle-kit cannot
-- express a partial unique index, so it lives here.
--
-- 2026-07-28: VERIFIED joined the predicate when the verifier gate landed.
-- Without it, the window between "a verifier passed this request" and "an
-- approver decided it" is a window in which the field looks free, and the rep
-- can open a second competing request against it. Two approvals would then race
-- for the same column and one would be lost -- the exact failure this index
-- exists to prevent, reintroduced by the new status.
--
-- Note that this is a WIDER set than the statuses a submitter may withdraw from
-- (PENDING, RETURNED). A verified request locks the field but cannot be
-- withdrawn: someone has already spent review effort on it, and discarding that
-- silently would leave no record of why a signed-off review went nowhere.
--
-- Dropped before it is created, rather than CREATE ... IF NOT EXISTS, because
-- this file re-runs on every `npm run db:custom` and an index that already
-- exists under the OLD predicate would otherwise survive untouched -- leaving a
-- database that reports the index present while it silently fails to cover
-- VERIFIED.
DROP INDEX IF EXISTS correction_one_open_per_field;

CREATE UNIQUE INDEX correction_one_open_per_field
  ON correction_request (record_id, field_name)
  WHERE status IN ('PENDING', 'VERIFIED', 'RETURNED');
