-- Two reps must not both hold an open claim on the same field of the same
-- record: approving both would produce a lost update. drizzle-kit cannot
-- express a partial unique index, so it lives here.
CREATE UNIQUE INDEX IF NOT EXISTS correction_one_open_per_field
  ON correction_request (record_id, field_name)
  WHERE status IN ('PENDING', 'RETURNED');
