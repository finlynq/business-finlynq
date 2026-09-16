ALTER TABLE "asset_register" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_register" ADD COLUMN "command_hash" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_register_org_idempotency_unique" ON "asset_register" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "asset_register" ADD CONSTRAINT "asset_register_command_hash_check" CHECK (command_hash ~ '^[a-f0-9]{64}$');
--> statement-breakpoint

ALTER TABLE asset_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_categories
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE asset_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_register FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_register
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE asset_schedule_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_schedule_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_schedule_entries
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE asset_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_lifecycle_events
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

CREATE FUNCTION app.guard_asset_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  required_permission text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% records cannot be deleted', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_id() IS NULL THEN
    RAISE EXCEPTION 'Asset mutation tenant and actor context are required' USING ERRCODE = '42501';
  END IF;
  required_permission := CASE WHEN TG_TABLE_NAME = 'asset_categories'
    THEN 'organization.settings.manage' ELSE 'ledger.journal.draft' END;
  IF NOT app.current_actor_has_permission(required_permission) THEN
    RAISE EXCEPTION 'Asset mutation permission is required' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN ('asset_categories', 'asset_register', 'asset_lifecycle_events')
    AND (to_jsonb(NEW)->>'created_by')::uuid IS DISTINCT FROM app.current_actor_id() THEN
    RAISE EXCEPTION 'Asset creator must match the current actor' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'asset_categories' THEN
      RAISE EXCEPTION 'Asset categories are versioned by replacement and cannot be edited' USING ERRCODE = '55000';
    ELSIF TG_TABLE_NAME = 'asset_register' THEN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.id IS DISTINCT FROM OLD.id
        OR NEW.category_id IS DISTINCT FROM OLD.category_id
        OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
        OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
        OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.asset_number IS DISTINCT FROM OLD.asset_number
        OR NEW.classification IS DISTINCT FROM OLD.classification
        OR NEW.acquisition_date IS DISTINCT FROM OLD.acquisition_date
        OR NEW.in_service_on IS DISTINCT FROM OLD.in_service_on
        OR NEW.schedule_end_on IS DISTINCT FROM OLD.schedule_end_on
        OR NEW.cost IS DISTINCT FROM OLD.cost
        OR NEW.residual_value IS DISTINCT FROM OLD.residual_value
        OR NEW.useful_life_months IS DISTINCT FROM OLD.useful_life_months
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.command_hash IS DISTINCT FROM OLD.command_hash
        OR NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Asset accounting identity and schedule basis are immutable' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'asset_schedule_entries' THEN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.id IS DISTINCT FROM OLD.id
        OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
        OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number
        OR NEW.period_start_on IS DISTINCT FROM OLD.period_start_on
        OR NEW.period_end_on IS DISTINCT FROM OLD.period_end_on
        OR NEW.due_on IS DISTINCT FROM OLD.due_on
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Asset schedule facts are immutable' USING ERRCODE = '55000';
      END IF;
    ELSIF TG_TABLE_NAME = 'asset_lifecycle_events' THEN
      RAISE EXCEPTION 'Asset lifecycle events are append-only' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_asset_write() FROM PUBLIC;
CREATE TRIGGER asset_categories_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON asset_categories
  FOR EACH ROW EXECUTE FUNCTION app.guard_asset_write();
CREATE TRIGGER asset_register_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON asset_register
  FOR EACH ROW EXECUTE FUNCTION app.guard_asset_write();
CREATE TRIGGER asset_schedule_entries_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON asset_schedule_entries
  FOR EACH ROW EXECUTE FUNCTION app.guard_asset_write();
CREATE TRIGGER asset_lifecycle_events_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON asset_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_asset_write();
--> statement-breakpoint

CREATE FUNCTION app.guard_asset_category_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ledgers ledger
    JOIN legal_entities entity
      ON entity.organization_id = ledger.organization_id
     AND entity.id = ledger.legal_entity_id AND entity.active
    WHERE ledger.organization_id = NEW.organization_id
      AND ledger.id = NEW.ledger_id
      AND ledger.legal_entity_id = NEW.legal_entity_id
      AND ledger.active
  ) OR EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      NEW.cost_account_combination_id,
      NEW.contra_account_combination_id,
      NEW.expense_account_combination_id,
      NEW.impairment_account_combination_id,
      NEW.disposal_account_combination_id
    ]::uuid[]) selected(id)
    WHERE selected.id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM account_combinations combination
      JOIN gl_accounts account
        ON account.organization_id = combination.organization_id
       AND account.ledger_id = combination.ledger_id
       AND account.id = combination.account_id
      WHERE combination.organization_id = NEW.organization_id
        AND combination.id = selected.id
        AND combination.entity_id = NEW.legal_entity_id
        AND combination.ledger_id = NEW.ledger_id
        AND combination.active AND account.active AND account.postable
        AND account.control_kind = 'NONE'
    )
  ) THEN
    RAISE EXCEPTION 'Asset category account and ledger mappings are invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_asset_category_integrity() FROM PUBLIC;
CREATE TRIGGER asset_category_integrity_guard
  BEFORE INSERT ON asset_categories
  FOR EACH ROW EXECUTE FUNCTION app.guard_asset_category_integrity();
--> statement-breakpoint

CREATE FUNCTION app.guard_asset_register_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM asset_categories category
    WHERE category.organization_id = NEW.organization_id
      AND category.id = NEW.category_id AND category.active
      AND category.kind = NEW.kind
      AND category.legal_entity_id = NEW.legal_entity_id
      AND category.ledger_id = NEW.ledger_id
  ) THEN
    RAISE EXCEPTION 'Asset record does not match its active category' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_asset_register_integrity() FROM PUBLIC;
CREATE TRIGGER asset_register_integrity_guard
  BEFORE INSERT ON asset_register
  FOR EACH ROW EXECUTE FUNCTION app.guard_asset_register_integrity();
--> statement-breakpoint

CREATE FUNCTION app.guard_asset_schedule_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_asset asset_register%ROWTYPE;
  scheduled_total numeric(38,9);
  scheduled_count integer;
BEGIN
  SELECT * INTO selected_asset FROM asset_register
  WHERE organization_id = NEW.organization_id AND id = NEW.asset_id;
  SELECT coalesce(sum(amount), 0), count(*)::integer
  INTO scheduled_total, scheduled_count
  FROM asset_schedule_entries
  WHERE organization_id = NEW.organization_id AND asset_id = NEW.asset_id;
  IF selected_asset.classification = 'FINITE_LIFE' AND (
    scheduled_total <> selected_asset.cost - selected_asset.residual_value
    OR scheduled_count <> selected_asset.useful_life_months
    OR EXISTS (
      SELECT 1 FROM generate_series(1, scheduled_count) expected(sequence_number)
      WHERE NOT EXISTS (
        SELECT 1 FROM asset_schedule_entries schedule
        WHERE schedule.organization_id = NEW.organization_id
          AND schedule.asset_id = NEW.asset_id
          AND schedule.sequence_number = expected.sequence_number
      )
    )
  ) THEN
    RAISE EXCEPTION 'Finite asset schedule must be complete, contiguous, and equal its recognized basis'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_asset_schedule_integrity() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER asset_schedule_integrity_guard
  AFTER INSERT OR UPDATE ON asset_schedule_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.guard_asset_schedule_integrity();
--> statement-breakpoint

CREATE FUNCTION app.audit_asset_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_action text;
  selected_type text;
BEGIN
  selected_action := CASE TG_TABLE_NAME
    WHEN 'asset_categories' THEN 'assets.category.created'
    WHEN 'asset_register' THEN CASE WHEN TG_OP = 'INSERT' THEN 'assets.register.created' ELSE 'assets.register.status-changed' END
    WHEN 'asset_schedule_entries' THEN 'assets.schedule.journal-linked'
    ELSE 'assets.lifecycle.recorded'
  END;
  selected_type := CASE TG_TABLE_NAME
    WHEN 'asset_categories' THEN 'asset_category'
    WHEN 'asset_register' THEN 'asset_register'
    WHEN 'asset_schedule_entries' THEN 'asset_schedule_entry'
    ELSE 'asset_lifecycle_event'
  END;
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id, selected_action, selected_type, NEW.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'assetId', to_jsonb(NEW)->>'asset_id',
      'kind', to_jsonb(NEW)->>'kind',
      'status', to_jsonb(NEW)->>'status',
      'eventType', to_jsonb(NEW)->>'event_type',
      'journalEntryId', to_jsonb(NEW)->>'journal_entry_id',
      'version', to_jsonb(NEW)->>'version'
    )), NULL
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.audit_asset_event() FROM PUBLIC;
CREATE TRIGGER asset_category_business_audit
  AFTER INSERT ON asset_categories FOR EACH ROW EXECUTE FUNCTION app.audit_asset_event();
CREATE TRIGGER asset_register_business_audit
  AFTER INSERT OR UPDATE OF status ON asset_register FOR EACH ROW EXECUTE FUNCTION app.audit_asset_event();
CREATE TRIGGER asset_schedule_business_audit
  AFTER UPDATE OF journal_entry_id ON asset_schedule_entries
  FOR EACH ROW WHEN (NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id)
  EXECUTE FUNCTION app.audit_asset_event();
CREATE TRIGGER asset_lifecycle_business_audit
  AFTER INSERT ON asset_lifecycle_events FOR EACH ROW EXECUTE FUNCTION app.audit_asset_event();
--> statement-breakpoint

REVOKE ALL ON asset_categories, asset_register, asset_schedule_entries,
  asset_lifecycle_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT SELECT ON asset_categories, asset_register, asset_schedule_entries,
      asset_lifecycle_events TO business_finlynq_app;
    GRANT INSERT ON asset_categories, asset_lifecycle_events TO business_finlynq_app;
    GRANT INSERT, UPDATE ON asset_register, asset_schedule_entries TO business_finlynq_app;
    REVOKE UPDATE, DELETE ON asset_categories, asset_lifecycle_events FROM business_finlynq_app;
    REVOKE DELETE ON asset_register, asset_schedule_entries FROM business_finlynq_app;
  END IF;
END
$$;
--> statement-breakpoint

-- The isolated public-demo accountant can create representative categories;
-- ordinary tenants retain their existing organization-admin permission model.
INSERT INTO role_permissions (organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, 'organization.settings.manage'
FROM roles role
WHERE role.key = 'demo_accountant'
  AND EXISTS (
    SELECT 1 FROM demo_sandbox_slots slot
    WHERE slot.organization_id = role.organization_id
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO demo_sandbox_reset_tables(table_name, purge_order)
SELECT reset_table.table_name, reset_state.maximum_order + reset_table.ordinal::integer
FROM (SELECT coalesce(max(purge_order), 0) AS maximum_order FROM demo_sandbox_reset_tables) reset_state
CROSS JOIN unnest(ARRAY[
  'asset_lifecycle_events',
  'asset_schedule_entries',
  'asset_register',
  'asset_categories'
]::text[]) WITH ORDINALITY AS reset_table(table_name, ordinal);
