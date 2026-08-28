-- Defer banking template permission assignment until transaction commit so
-- organization signup can finish creating its role and permission graph first.
-- The existing trigger function remains the single idempotent assignment path.

DROP TRIGGER IF EXISTS assign_banking_template_permissions ON roles;
CREATE CONSTRAINT TRIGGER assign_banking_template_permissions
  AFTER INSERT OR UPDATE OF key, system_template ON roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assign_banking_template_permissions();
--> statement-breakpoint
