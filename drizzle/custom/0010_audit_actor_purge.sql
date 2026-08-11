-- audit_log stays append-only, with exactly one exception: the rows an account
-- is the ACTOR of may be DELETED, as part of deleting that account.
--
-- This supersedes the detach exception 0009 opened. That one nulled `actor_id`
-- and kept the row; this one removes the row. A forced removal is now asked to
-- take the account's trail with it, so the narrower write is no longer used and
-- is closed again — UPDATE is refused outright, in every shape.
--
-- What this costs, stated plainly. Entries deleted here are gone: who did what,
-- when, and to which record. `actor_email` and `actor_role` were copies that
-- made a detached row still readable, and they go with the row. The remaining
-- evidence of the whole event is the USER_DELETE_FORCED entry the application
-- writes first — the admin who did it, the account's snapshot, and how many
-- entries the purge removed.
--
-- How narrow it is. The DELETE passes only for rows whose `actor_id` matches
-- `app.purge_actor`, a setting the application sets transaction-locally around
-- the delete and nothing else sets. So: one account per transaction, never a
-- row already detached (`actor_id IS NULL`), never a row belonging to anybody
-- else, and never anything at all through a connection that has not opted in.
-- Rows about the deleted account that somebody ELSE is the actor of — the admin
-- who created it, the approver who acted on its work — are not touched; they
-- are that person's history, not this one's.
CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.actor_id IS NOT NULL
     AND current_setting('app.purge_actor', true) = OLD.actor_id::text
  THEN
    RETURN OLD;
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
