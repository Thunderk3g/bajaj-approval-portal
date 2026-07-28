-- Monthly cycle constraints -- 2026-07-28 spec section 4.
-- Neither of these is expressible in drizzle-kit.

-- ── Exactly one open period ────────────────────────────────────────────────
--
-- Every OPEN row holds the same value in the indexed column, so a unique index
-- restricted to OPEN admits exactly one. "Which period are we in?" then has one
-- answer enforced by the database, rather than by every caller remembering to
-- check -- and two admins closing and opening concurrently cannot produce two
-- current months.
DROP INDEX IF EXISTS period_one_open;

CREATE UNIQUE INDEX period_one_open
  ON period (status)
  WHERE status = 'OPEN';

-- ── A closed period accepts no NEW claims ──────────────────────────────────
--
-- BEFORE INSERT only. An UPDATE trigger would also block resubmission of a
-- RETURNED request and the verify/approve transitions, which must keep working
-- after the close -- otherwise closing a month strands exactly the requests that
-- were mid-review when it turned, which is the moment the queue is fullest.
--
-- The application checks this too, in submitCorrection, and that check is what
-- produces a message a rep can act on. This trigger is the guarantee: it closes
-- the race where a period is closed between the application's check and its
-- insert, which is precisely the moment a monthly upload is running.
--
-- A NULL period_id passes. Null means "raised before the portal tracked
-- periods", not "in some period that might be closed", so a pre-period record
-- stays correctable.
CREATE OR REPLACE FUNCTION correction_period_must_be_open()
RETURNS TRIGGER AS $$
DECLARE
  target_status text;
  target_label  text;
BEGIN
  IF NEW.period_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.status::text, p.label
    INTO target_status, target_label
    FROM period p
   WHERE p.id = NEW.period_id;

  IF target_status = 'CLOSED' THEN
    RAISE EXCEPTION
      'Period % is closed and cannot accept new correction requests.',
      COALESCE(target_label, NEW.period_id::text)
      USING ERRCODE = '23514',
            CONSTRAINT = 'correction_period_must_be_open';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS correction_request_period_open ON correction_request;
CREATE TRIGGER correction_request_period_open
  BEFORE INSERT ON correction_request
  FOR EACH ROW EXECUTE FUNCTION correction_period_must_be_open();
