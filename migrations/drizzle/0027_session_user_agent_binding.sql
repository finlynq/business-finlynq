-- New sessions are always bound to the request's deterministic user-agent
-- fingerprint. Application callers hash an absent User-Agent as the empty
-- string, while existing pre-0027 NULL rows retain their compatibility
-- wildcard until they expire or are revoked.
CREATE OR REPLACE FUNCTION app.guard_new_auth_session_user_agent_binding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.user_agent_hash IS NULL THEN
    RAISE EXCEPTION 'New authentication sessions require a user-agent fingerprint'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD.user_agent_hash IS NOT NULL
    AND NEW.user_agent_hash IS NULL THEN
    RAISE EXCEPTION 'Authentication session user-agent binding cannot be downgraded'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.guard_new_auth_session_user_agent_binding() FROM PUBLIC;
--> statement-breakpoint

DROP TRIGGER IF EXISTS auth_sessions_user_agent_binding_guard ON auth_sessions;
--> statement-breakpoint
CREATE TRIGGER auth_sessions_user_agent_binding_guard
BEFORE INSERT OR UPDATE OF user_agent_hash ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION app.guard_new_auth_session_user_agent_binding();
--> statement-breakpoint

COMMENT ON COLUMN auth_sessions.user_agent_hash IS
  'Deterministic request User-Agent fingerprint. NULL is permitted only on sessions issued before migration 0027 and remains a temporary legacy wildcard.';
