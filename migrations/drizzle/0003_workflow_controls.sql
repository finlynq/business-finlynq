CREATE UNIQUE INDEX organization_memberships_org_id_unique
  ON organization_memberships (organization_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX journal_approvals_org_ledger_id_unique
  ON journal_approvals (organization_id, ledger_id, id);
--> statement-breakpoint

ALTER TABLE membership_roles
  ADD CONSTRAINT membership_roles_tenant_membership_fk
  FOREIGN KEY (organization_id, membership_id)
  REFERENCES organization_memberships (organization_id, id),
  ADD CONSTRAINT membership_roles_tenant_role_fk
  FOREIGN KEY (organization_id, role_id)
  REFERENCES roles (organization_id, id);
--> statement-breakpoint
ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_tenant_role_fk
  FOREIGN KEY (organization_id, role_id)
  REFERENCES roles (organization_id, id);
--> statement-breakpoint
ALTER TABLE journal_approvals
  ADD CONSTRAINT journal_approvals_tenant_journal_fk
  FOREIGN KEY (organization_id, ledger_id, journal_entry_id)
  REFERENCES journal_entries (organization_id, ledger_id, id);
--> statement-breakpoint
ALTER TABLE ledger_number_sequences
  ADD CONSTRAINT ledger_number_sequences_tenant_ledger_fk
  FOREIGN KEY (organization_id, ledger_id)
  REFERENCES ledgers (organization_id, id);
--> statement-breakpoint
ALTER TABLE period_events
  ADD CONSTRAINT period_events_tenant_period_fk
  FOREIGN KEY (organization_id, ledger_id, period_id)
  REFERENCES fiscal_periods (organization_id, ledger_id, id);
--> statement-breakpoint

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'roles', 'role_permissions', 'membership_roles', 'journal_approvals',
    'ledger_number_sequences', 'period_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app.current_organization_id()) WITH CHECK (organization_id = app.current_organization_id())',
      tenant_table
    );
  END LOOP;
END
$$;
--> statement-breakpoint

INSERT INTO permissions (key, description) VALUES
  ('ledger.journal.draft', 'Create and edit general-ledger drafts'),
  ('ledger.journal.submit', 'Submit a journal for approval'),
  ('ledger.journal.approve', 'Approve an exact journal version and content hash'),
  ('ledger.journal.post', 'Post an authorized journal'),
  ('ledger.journal.reverse', 'Create a linked full reversal'),
  ('ledger.period.close', 'Move a period toward hard close'),
  ('ledger.period.reopen', 'Reopen a hard-closed period with step-up controls'),
  ('organization.roles.manage', 'Manage organization role assignments'),
  ('mcp.ledger.read', 'Read scoped ledger and open-item data through MCP'),
  ('mcp.journal-draft.create', 'Create idempotent journal drafts through MCP'),
  ('organization.recovery.manage', 'Manage organization recovery factors')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.allocate_journal_number(
  selected_organization_id uuid,
  selected_ledger_id uuid,
  selected_sequence_key text DEFAULT 'JOURNAL'
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  allocated bigint;
BEGIN
  IF selected_organization_id <> app.current_organization_id() THEN
    RAISE EXCEPTION 'Tenant context does not match journal sequence request'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO ledger_number_sequences (
    organization_id, ledger_id, key, next_value, updated_at
  ) VALUES (
    selected_organization_id, selected_ledger_id, selected_sequence_key, 2, now()
  )
  ON CONFLICT (ledger_id, key) DO UPDATE
    SET next_value = ledger_number_sequences.next_value + 1,
        updated_at = now()
    WHERE ledger_number_sequences.organization_id = EXCLUDED.organization_id
  RETURNING next_value - 1 INTO allocated;

  IF allocated IS NULL THEN
    RAISE EXCEPTION 'Sequence belongs to a different tenant'
      USING ERRCODE = '42501';
  END IF;

  RETURN allocated;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.validate_posting_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'POSTED' OR OLD.status = 'POSTED' OR NEW.approval_version IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM journal_approvals approval
    WHERE approval.organization_id = NEW.organization_id
      AND approval.ledger_id = NEW.ledger_id
      AND approval.journal_entry_id = NEW.id
      AND approval.journal_version = NEW.approval_version
      AND approval.content_hash = NEW.content_hash
      AND approval.decision = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'The exact journal version and content hash have not been approved'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_validate_approval
  BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.validate_posting_approval();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.audit_period_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor uuid;
  reason text;
  request_key text;
  previous_hash text;
  next_hash text;
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  actor := nullif(current_setting('app.actor_id', true), '')::uuid;
  reason := nullif(current_setting('app.reason', true), '');
  request_key := nullif(current_setting('app.request_id', true), '');

  IF actor IS NULL OR reason IS NULL OR request_key IS NULL THEN
    RAISE EXCEPTION 'Period transitions require actor, reason, and request context'
      USING ERRCODE = '28000';
  END IF;

  INSERT INTO period_events (
    organization_id, ledger_id, period_id, from_state, to_state,
    reason, actor_id, request_id
  ) VALUES (
    NEW.organization_id, NEW.ledger_id, NEW.id, OLD.state, NEW.state,
    reason, actor, request_key
  );

  SELECT event_hash INTO previous_hash
  FROM audit_events
  WHERE organization_id = NEW.organization_id
  ORDER BY occurred_at DESC, id DESC
  LIMIT 1;

  next_hash := encode(digest(
    coalesce(previous_hash, '') || NEW.organization_id::text || NEW.id::text || request_key || 'period.transition',
    'sha256'
  ), 'hex');

  INSERT INTO audit_events (
    organization_id, actor_type, actor_id, auth_method, source_surface,
    action, entity_type, entity_id, request_id, reason, safe_metadata,
    previous_event_hash, event_hash
  ) VALUES (
    NEW.organization_id, 'USER', actor::text,
    coalesce(nullif(current_setting('app.auth_method', true), ''), 'application'),
    coalesce(nullif(current_setting('app.source_surface', true), ''), 'UI'),
    'period.transition', 'fiscal_period', NEW.id::text, request_key, reason,
    jsonb_build_object('from', OLD.state, 'to', NEW.state, 'version', NEW.version),
    previous_hash, next_hash
  );

  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER fiscal_periods_audit_transition
  AFTER UPDATE OF state ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION app.audit_period_transition();
--> statement-breakpoint

CREATE TRIGGER journal_approvals_append_only
  BEFORE UPDATE OR DELETE ON journal_approvals
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();
--> statement-breakpoint
CREATE TRIGGER period_events_append_only
  BEFORE UPDATE OR DELETE ON period_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();
--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE ON permissions FROM PUBLIC;
REVOKE UPDATE, DELETE ON journal_approvals, period_events FROM PUBLIC;
--> statement-breakpoint

-- Hosted/Compose deployments create this non-owner role before migration.
-- Development and CI may omit it, so grants are conditional.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT USAGE ON SCHEMA public, app TO business_finlynq_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO business_finlynq_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO business_finlynq_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO business_finlynq_app;

    REVOKE INSERT, UPDATE, DELETE ON permissions FROM business_finlynq_app;
    REVOKE INSERT, UPDATE, DELETE ON journal_type_definitions, tax_pack_versions
      FROM business_finlynq_app;
    REVOKE UPDATE, DELETE ON audit_events, journal_approvals, period_events,
      tax_determination_snapshots FROM business_finlynq_app;
    REVOKE DELETE ON journal_entries, journal_lines FROM business_finlynq_app;
  END IF;
END
$$;
