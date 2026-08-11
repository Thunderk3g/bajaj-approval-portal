-- audit_log stays append-only, with exactly one exception: an actor may be
-- DETACHED from a row so the account behind it can be deleted.
--
-- Why the exception exists. `audit_log.actor_id` is ON DELETE RESTRICT, so any
-- account that has ever done anything auditable cannot be deleted, and the
-- admin screen deactivates it instead. That is the right default and stays the
-- default. But "deactivate instead" is not always an acceptable answer: an
-- account created by mistake, a duplicate, a departed contractor whose row must
-- come off the list for real. Before this, the only way out was an UPDATE run by
-- hand against the database — which is strictly worse than a narrow, audited
-- path through the application.
--
-- Why nothing is lost. `actor_email` and `actor_role` are plain copies on every
-- row, written at the time of the action precisely so the entry stays readable
-- without the join. Nulling `actor_id` costs the foreign key, not the answer to
-- "who did this and what were they at the time".
--
-- How narrow it is. The UPDATE passes only when it moves actor_id from a value
-- to NULL and leaves every other column byte-identical. Re-attaching an actor,
-- changing one, or editing anything else is still refused, and DELETE is still
-- refused outright — history can be detached, never rewritten and never removed.
CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.actor_id IS NOT NULL
     AND NEW.actor_id IS NULL
     AND NEW.id = OLD.id
     AND NEW.actor_email  IS NOT DISTINCT FROM OLD.actor_email
     AND NEW.actor_role   IS NOT DISTINCT FROM OLD.actor_role
     AND NEW.action       IS NOT DISTINCT FROM OLD.action
     AND NEW.entity_type  IS NOT DISTINCT FROM OLD.entity_type
     AND NEW.entity_id    IS NOT DISTINCT FROM OLD.entity_id
     AND NEW.before       IS NOT DISTINCT FROM OLD.before
     AND NEW.after        IS NOT DISTINCT FROM OLD.after
     AND NEW.metadata     IS NOT DISTINCT FROM OLD.metadata
     AND NEW.ip_address   IS NOT DISTINCT FROM OLD.ip_address
     AND NEW.user_agent   IS NOT DISTINCT FROM OLD.user_agent
     AND NEW.created_at   IS NOT DISTINCT FROM OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- Recreated rather than assumed: 0003 built it, and a deployment that has only
-- ever run this file must still end up with the trigger attached.
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
