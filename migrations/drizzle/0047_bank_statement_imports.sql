CREATE TABLE "bank_statement_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"statement_import_id" uuid NOT NULL,
	"source_row_number" integer NOT NULL,
	"row_fingerprint" text NOT NULL,
	"disposition" text NOT NULL,
	"observation_version_id" uuid,
	"row_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_import_rows_fingerprint_check" CHECK (row_fingerprint ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "bank_statement_import_rows_disposition_check" CHECK (disposition IN ('IMPORTED', 'DUPLICATE', 'EXCLUDED')),
	CONSTRAINT "bank_statement_import_rows_observation_check" CHECK ((disposition = 'EXCLUDED') = (observation_version_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "bank_statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inbox_item_id" uuid NOT NULL,
	"evidence_asset_id" uuid NOT NULL,
	"external_account_id" uuid NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"reconciliation_session_id" uuid,
	"source_sha256" text NOT NULL,
	"extraction_version" text NOT NULL,
	"extraction_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"preview_hash" text NOT NULL,
	"statement_start_on" date NOT NULL,
	"statement_end_on" date NOT NULL,
	"opening_balance" numeric(38, 9) NOT NULL,
	"closing_balance" numeric(38, 9) NOT NULL,
	"currency_code" text NOT NULL,
	"included_row_count" integer NOT NULL,
	"excluded_row_count" integer NOT NULL,
	"duplicate_row_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_imports_sha_check" CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "bank_statement_imports_preview_hash_check" CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "bank_statement_imports_period_check" CHECK (statement_start_on <= statement_end_on),
	CONSTRAINT "bank_statement_imports_row_counts_check" CHECK (included_row_count > 0 AND excluded_row_count >= 0 AND duplicate_row_count >= 0 AND duplicate_row_count <= included_row_count)
);
--> statement-breakpoint
ALTER TABLE "bank_external_accounts" ADD COLUMN "account_kind" text DEFAULT 'CASH' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_imports_org_id_unique" ON "bank_statement_imports" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "bank_statement_import_rows" ADD CONSTRAINT "bank_statement_import_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_import_rows" ADD CONSTRAINT "bank_statement_import_rows_org_import_fk" FOREIGN KEY ("organization_id","statement_import_id") REFERENCES "public"."bank_statement_imports"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_import_rows" ADD CONSTRAINT "bank_statement_import_rows_org_observation_version_fk" FOREIGN KEY ("organization_id","observation_version_id") REFERENCES "public"."bank_observation_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_currency_code_currency_definitions_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currency_definitions"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_org_inbox_fk" FOREIGN KEY ("organization_id","inbox_item_id") REFERENCES "public"."document_inbox_items"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_org_evidence_fk" FOREIGN KEY ("organization_id","evidence_asset_id") REFERENCES "public"."document_evidence_assets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_org_account_currency_fk" FOREIGN KEY ("organization_id","external_account_id","currency_code") REFERENCES "public"."bank_external_accounts"("organization_id","id","currency_code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_org_run_fk" FOREIGN KEY ("organization_id","sync_run_id") REFERENCES "public"."bank_sync_runs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_org_reconciliation_fk" FOREIGN KEY ("organization_id","reconciliation_session_id") REFERENCES "public"."bank_reconciliation_sessions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_import_rows_org_id_unique" ON "bank_statement_import_rows" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_import_rows_source_row_unique" ON "bank_statement_import_rows" USING btree ("statement_import_id","source_row_number");--> statement-breakpoint
CREATE INDEX "bank_statement_import_rows_fingerprint_idx" ON "bank_statement_import_rows" USING btree ("organization_id","row_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_imports_org_inbox_unique" ON "bank_statement_imports" USING btree ("organization_id","inbox_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_imports_account_source_unique" ON "bank_statement_imports" USING btree ("external_account_id","source_sha256");--> statement-breakpoint
CREATE INDEX "bank_statement_imports_org_period_idx" ON "bank_statement_imports" USING btree ("organization_id","statement_end_on" DESC NULLS LAST,"id");--> statement-breakpoint
ALTER TABLE "bank_external_accounts" ADD CONSTRAINT "bank_external_accounts_kind_check" CHECK (account_kind IN ('CASH', 'CREDIT_CARD'));
--> statement-breakpoint

-- File imports are represented by one non-routable, encrypted local connection
-- per organization. Existing SimpleFIN rows retain CASH as their backfilled
-- account kind and their provider identity remains immutable.
ALTER TABLE bank_connections DROP CONSTRAINT bank_connections_provider_check;
--> statement-breakpoint
ALTER TABLE bank_connections
  ADD CONSTRAINT bank_connections_provider_check
  CHECK (provider IN ('SIMPLEFIN', 'FILE_IMPORT'));
--> statement-breakpoint

ALTER TABLE bank_statement_imports
  DROP CONSTRAINT bank_statement_imports_row_counts_check;
--> statement-breakpoint
ALTER TABLE bank_statement_imports
  ADD CONSTRAINT bank_statement_imports_row_counts_check CHECK (
    included_row_count BETWEEN 1 AND 1000
    AND excluded_row_count BETWEEN 0 AND 999
    AND included_row_count + excluded_row_count <= 1000
    AND duplicate_row_count BETWEEN 0 AND included_row_count
  );
--> statement-breakpoint
ALTER TABLE bank_statement_imports
  ADD CONSTRAINT bank_statement_imports_encrypted_extraction_check CHECK (
    extraction_version = 'finlynq.statement.v1'
    AND length(extraction_ciphertext) BETWEEN 50 AND 8000000
    AND key_version > 0
  );
--> statement-breakpoint
ALTER TABLE bank_statement_imports
  ADD CONSTRAINT bank_statement_imports_reconciliation_required_check
  CHECK (reconciliation_session_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE bank_statement_import_rows
  ADD CONSTRAINT bank_statement_import_rows_metadata_check CHECK (
    source_row_number BETWEEN 1 AND 1000000
    AND length(row_ciphertext) BETWEEN 50 AND 100000
    AND key_version > 0
  );
--> statement-breakpoint

CREATE UNIQUE INDEX bank_statement_imports_org_evidence_unique
  ON bank_statement_imports(organization_id, evidence_asset_id);
--> statement-breakpoint
CREATE UNIQUE INDEX bank_statement_imports_org_run_unique
  ON bank_statement_imports(organization_id, sync_run_id);
--> statement-breakpoint

ALTER TABLE bank_statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_statement_imports
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint
ALTER TABLE bank_statement_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_statement_import_rows
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

-- Statement imports require both the ability to synchronize observations and
-- the ability to prepare a reconciliation. The aggregate records and their
-- extracted rows are immutable after insert.
CREATE FUNCTION app.guard_bank_statement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_id() IS NULL
    OR NOT app.current_actor_has_permission('banking.sync')
    OR NOT app.current_actor_has_permission('banking.reconcile.prepare')
    OR (TG_TABLE_NAME = 'bank_statement_imports'
      AND (to_jsonb(NEW)->>'created_by')::uuid IS DISTINCT FROM app.current_actor_id()) THEN
    RAISE EXCEPTION 'Statement import permissions or actor context are invalid'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_statement_mutation() FROM PUBLIC;
CREATE TRIGGER bank_statement_00_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_statement_mutation();
CREATE TRIGGER bank_statement_00_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_import_rows
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_statement_mutation();
--> statement-breakpoint

CREATE TRIGGER bank_immutable_record
  BEFORE UPDATE OR DELETE ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_immutable_record();
CREATE TRIGGER bank_immutable_record
  BEFORE UPDATE OR DELETE ON bank_statement_import_rows
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_immutable_record();
--> statement-breakpoint

-- An imported row can only be appended while its exact file-import sync run is
-- RUNNING. This closes later insert attempts after the parent import commits and
-- validates every observation-version edge without one deferred O(n^2) trigger
-- per extracted row.
CREATE FUNCTION app.guard_bank_statement_import_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_import bank_statement_imports%ROWTYPE;
BEGIN
  SELECT statement_import.*
    INTO selected_import
  FROM bank_statement_imports statement_import
  JOIN bank_sync_runs sync_run
    ON sync_run.organization_id = statement_import.organization_id
   AND sync_run.id = statement_import.sync_run_id
  WHERE statement_import.organization_id = NEW.organization_id
    AND statement_import.id = NEW.statement_import_id
    AND sync_run.status = 'RUNNING';

  IF NOT FOUND OR NEW.key_version <> selected_import.key_version THEN
    RAISE EXCEPTION 'Statement rows must be appended with their import key while its sync run is active'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.disposition <> 'EXCLUDED' AND NOT EXISTS (
    SELECT 1
    FROM bank_observation_versions observation_version
    JOIN bank_observations observation
      ON observation.organization_id = observation_version.organization_id
     AND observation.id = observation_version.observation_id
    WHERE observation_version.organization_id = NEW.organization_id
      AND observation_version.id = NEW.observation_version_id
      AND observation.external_account_id = selected_import.external_account_id
      AND observation_version.currency_code = selected_import.currency_code
      AND observation_version.posted_on BETWEEN selected_import.statement_start_on
        AND selected_import.statement_end_on
      AND (
        (NEW.disposition = 'IMPORTED'
          AND observation_version.sync_run_id = selected_import.sync_run_id)
        OR (NEW.disposition = 'DUPLICATE'
          AND observation_version.sync_run_id <> selected_import.sync_run_id)
      )
  ) THEN
    RAISE EXCEPTION 'Statement row disposition does not match its account, period, or observation lineage'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_statement_import_row() FROM PUBLIC;
CREATE TRIGGER bank_statement_import_row_guard
  BEFORE INSERT ON bank_statement_import_rows
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_statement_import_row();
--> statement-breakpoint

-- The parent check is deferred because inbox completion links the retained
-- evidence and marks the sync run successful after all extracted rows exist.
CREATE FUNCTION app.guard_bank_statement_import_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  imported_count integer;
  duplicate_count integer;
  excluded_count integer;
BEGIN
  SELECT
    count(*) FILTER (WHERE disposition = 'IMPORTED')::integer,
    count(*) FILTER (WHERE disposition = 'DUPLICATE')::integer,
    count(*) FILTER (WHERE disposition = 'EXCLUDED')::integer
  INTO imported_count, duplicate_count, excluded_count
  FROM bank_statement_import_rows
  WHERE organization_id = NEW.organization_id
    AND statement_import_id = NEW.id;

  IF imported_count + duplicate_count <> NEW.included_row_count
    OR duplicate_count <> NEW.duplicate_row_count
    OR excluded_count <> NEW.excluded_row_count THEN
    RAISE EXCEPTION 'Statement import row counts do not match its immutable extraction summary'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM bank_external_accounts external_account
    JOIN bank_sync_runs sync_run
      ON sync_run.organization_id = external_account.organization_id
     AND sync_run.connection_id = external_account.connection_id
     AND sync_run.id = NEW.sync_run_id
    JOIN bank_balance_anchors balance_anchor
      ON balance_anchor.organization_id = NEW.organization_id
     AND balance_anchor.external_account_id = NEW.external_account_id
     AND balance_anchor.sync_run_id = NEW.sync_run_id
     AND balance_anchor.currency_code = NEW.currency_code
    JOIN bank_reconciliation_sessions reconciliation
      ON reconciliation.organization_id = NEW.organization_id
     AND reconciliation.id = NEW.reconciliation_session_id
    JOIN document_inbox_items inbox_item
      ON inbox_item.organization_id = NEW.organization_id
     AND inbox_item.id = NEW.inbox_item_id
    JOIN document_evidence_assets evidence
      ON evidence.organization_id = NEW.organization_id
     AND evidence.id = NEW.evidence_asset_id
    JOIN organization_key_versions key_version
      ON key_version.organization_id = NEW.organization_id
     AND key_version.version = NEW.key_version
    WHERE external_account.organization_id = NEW.organization_id
      AND external_account.id = NEW.external_account_id
      AND external_account.active
      AND sync_run.status = 'SUCCEEDED'
      AND sync_run.requested_start_on = NEW.statement_start_on
      AND sync_run.requested_end_on = NEW.statement_end_on
      AND sync_run.account_count = 1
      AND sync_run.observation_count = NEW.included_row_count
      AND sync_run.version_count = imported_count
      AND balance_anchor.balance = NEW.closing_balance
      AND balance_anchor.balance_at::date = NEW.statement_end_on
      AND reconciliation.external_account_id = NEW.external_account_id
      AND reconciliation.statement_start_on = NEW.statement_start_on
      AND reconciliation.statement_end_on = NEW.statement_end_on
      AND reconciliation.opening_balance = NEW.opening_balance
      AND reconciliation.closing_balance = NEW.closing_balance
      AND reconciliation.currency_code = NEW.currency_code
      AND reconciliation.status = 'DRAFT'
      AND evidence.sha256 = NEW.source_sha256
      AND evidence.owner_module = inbox_item.owner_module
      AND inbox_item.asset_id = NEW.evidence_asset_id
      AND inbox_item.sha256 = NEW.source_sha256
      AND inbox_item.completion_hash IS NOT NULL
      AND inbox_item.status IN ('READY_TO_FILE', 'FILED')
      AND key_version.active
  ) THEN
    RAISE EXCEPTION 'Statement import is not linked to its exact account, sync, reconciliation, inbox, evidence, and key lineage'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_statement_import_integrity() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER bank_statement_import_integrity_guard
  AFTER INSERT ON bank_statement_imports
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.guard_bank_statement_import_integrity();
--> statement-breakpoint

-- Existing external accounts default to CASH. Future account kind is immutable,
-- and the mapped GL class is ASSET for CASH or LIABILITY for CREDIT_CARD.
CREATE OR REPLACE FUNCTION app.guard_bank_external_account_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  initial_simplefin_classification boolean := false;
BEGIN
  IF NEW.account_kind IS DISTINCT FROM OLD.account_kind THEN
    SELECT EXISTS (
      SELECT 1
      FROM bank_connections connection
      WHERE connection.organization_id = OLD.organization_id
        AND connection.id = OLD.connection_id
        AND connection.provider = 'SIMPLEFIN'
        AND OLD.legal_entity_id IS NULL
        AND OLD.ledger_id IS NULL
        AND OLD.cash_account_combination_id IS NULL
        AND NEW.legal_entity_id IS NOT NULL
        AND NEW.ledger_id IS NOT NULL
        AND NEW.cash_account_combination_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM bank_reconciliation_sessions reconciliation
          WHERE reconciliation.organization_id = OLD.organization_id
            AND reconciliation.external_account_id = OLD.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM bank_statement_imports statement_import
          WHERE statement_import.organization_id = OLD.organization_id
            AND statement_import.external_account_id = OLD.id
        )
    ) INTO initial_simplefin_classification;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.provider_account_id_hash IS DISTINCT FROM OLD.provider_account_id_hash
    OR NEW.provider_account_id_ciphertext IS DISTINCT FROM OLD.provider_account_id_ciphertext
    OR NEW.key_version IS DISTINCT FROM OLD.key_version
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR (NEW.account_kind IS DISTINCT FROM OLD.account_kind
      AND NOT initial_simplefin_classification)
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'External bank-account identity is immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_external_account_identity() FROM PUBLIC;
--> statement-breakpoint

-- Account classification happens atomically with the first SimpleFIN mapping.
-- Keep that classification in the same audit event as the mapping so reviewers
-- can prove which ledger class was authorized without consulting mutable state.
CREATE FUNCTION app.audit_bank_external_account_mapping_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR (
    NEW.legal_entity_id IS NOT DISTINCT FROM OLD.legal_entity_id
    AND NEW.ledger_id IS NOT DISTINCT FROM OLD.ledger_id
    AND NEW.cash_account_combination_id IS NOT DISTINCT FROM OLD.cash_account_combination_id
    AND NEW.account_kind IS NOT DISTINCT FROM OLD.account_kind
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM app.append_tenant_business_audit(
    NEW.organization_id,
    'bank.account.mapping-changed',
    'bank_external_account',
    NEW.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'fromEntityId', OLD.legal_entity_id,
      'toEntityId', NEW.legal_entity_id,
      'fromLedgerId', OLD.ledger_id,
      'toLedgerId', NEW.ledger_id,
      'fromAccountCombinationId', OLD.cash_account_combination_id,
      'toAccountCombinationId', NEW.cash_account_combination_id,
      'fromAccountKind', OLD.account_kind,
      'toAccountKind', NEW.account_kind,
      'currencyCode', NEW.currency_code
    )),
    NULL
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.audit_bank_external_account_mapping_event() FROM PUBLIC;
DROP TRIGGER bank_external_accounts_business_audit ON bank_external_accounts;
CREATE TRIGGER bank_external_accounts_business_audit
  AFTER UPDATE ON bank_external_accounts
  FOR EACH ROW EXECUTE FUNCTION app.audit_bank_external_account_mapping_event();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_external_account_mapping()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.legal_entity_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('bank-cash-mapping|' || NEW.organization_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.organization_id::text || '|organization-currency|' || upper(trim(NEW.currency_code)),
    0
  ));

  PERFORM 1
  FROM account_combinations combination
  JOIN gl_accounts account
    ON account.organization_id = combination.organization_id
   AND account.ledger_id = combination.ledger_id
   AND account.id = combination.account_id
  JOIN ledgers ledger
    ON ledger.organization_id = combination.organization_id
   AND ledger.id = combination.ledger_id
   AND ledger.legal_entity_id = combination.entity_id
  JOIN legal_entities entity
    ON entity.organization_id = combination.organization_id
   AND entity.id = combination.entity_id
  JOIN organization_currencies enabled_currency
    ON enabled_currency.organization_id = combination.organization_id
   AND enabled_currency.currency_code = NEW.currency_code
   AND enabled_currency.enabled
  WHERE combination.organization_id = NEW.organization_id
    AND combination.id = NEW.cash_account_combination_id
    AND combination.entity_id = NEW.legal_entity_id
    AND combination.ledger_id = NEW.ledger_id
    AND combination.active
    AND account.active
    AND account.postable
    AND account.class = (CASE NEW.account_kind
      WHEN 'CASH' THEN 'ASSET'
      WHEN 'CREDIT_CARD' THEN 'LIABILITY'
      ELSE NULL
    END)::account_class
    AND account.control_kind = 'NONE'
    AND ledger.active
    AND entity.active
  FOR SHARE OF combination, account, ledger, entity, enabled_currency;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank mapping requires enabled currency and an active postable non-control asset for cash or liability for a credit card'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_external_account_mapping() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_bank_gl_account_mapping_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('bank-cash-mapping|' || OLD.organization_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM account_combinations combination
    JOIN bank_external_accounts external_account
      ON external_account.organization_id = combination.organization_id
     AND external_account.cash_account_combination_id = combination.id
    WHERE combination.organization_id = OLD.organization_id
      AND combination.account_id = OLD.id
      AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id
        OR NOT NEW.active
        OR NOT NEW.postable
        OR NEW.control_kind <> 'NONE'
        OR (external_account.account_kind = 'CASH' AND NEW.class <> 'ASSET')
        OR (external_account.account_kind = 'CREDIT_CARD' AND NEW.class <> 'LIABILITY')
      )
  ) THEN
    RAISE EXCEPTION 'A banking GL account must remain active, postable, non-control, and compatible with its cash or credit-card mapping'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_bank_gl_account_mapping_state() FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION app.guard_mapped_bank_account_insert_permission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.legal_entity_id IS NOT NULL
    AND NOT app.current_actor_has_permission('banking.reconcile.prepare') THEN
    RAISE EXCEPTION 'Mapped bank-account creation requires reconciliation permission'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_mapped_bank_account_insert_permission() FROM PUBLIC;
CREATE TRIGGER bank_mapped_account_insert_permission_guard
  BEFORE INSERT ON bank_external_accounts
  FOR EACH ROW EXECUTE FUNCTION app.guard_mapped_bank_account_insert_permission();
--> statement-breakpoint

CREATE FUNCTION app.audit_bank_statement_import()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id,
    'bank.statement.imported',
    'bank_statement_import',
    NEW.id::text,
    jsonb_build_object(
      'inboxItemId', NEW.inbox_item_id,
      'evidenceAssetId', NEW.evidence_asset_id,
      'externalAccountId', NEW.external_account_id,
      'syncRunId', NEW.sync_run_id,
      'reconciliationId', NEW.reconciliation_session_id,
      'sourceSha256', NEW.source_sha256,
      'previewHash', NEW.preview_hash,
      'extractionVersion', NEW.extraction_version,
      'keyVersion', NEW.key_version,
      'statementStartOn', NEW.statement_start_on,
      'statementEndOn', NEW.statement_end_on,
      'currencyCode', NEW.currency_code,
      'includedRowCount', NEW.included_row_count,
      'excludedRowCount', NEW.excluded_row_count,
      'duplicateRowCount', NEW.duplicate_row_count
    ),
    NULL
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.audit_bank_statement_import() FROM PUBLIC;
CREATE TRIGGER bank_statement_import_business_audit
  AFTER INSERT ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION app.audit_bank_statement_import();
--> statement-breakpoint

REVOKE ALL ON bank_statement_imports, bank_statement_import_rows FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT SELECT, INSERT ON bank_statement_imports, bank_statement_import_rows
      TO business_finlynq_app;
    REVOKE UPDATE, DELETE ON bank_statement_imports, bank_statement_import_rows
      FROM business_finlynq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_auth_worker') THEN
    REVOKE ALL ON bank_statement_imports, bank_statement_import_rows
      FROM business_finlynq_auth_worker;
  END IF;
END
$$;
--> statement-breakpoint

INSERT INTO demo_sandbox_reset_tables(table_name, purge_order)
SELECT reset_table.table_name, reset_state.maximum_order + reset_table.ordinal::integer
FROM (SELECT coalesce(max(purge_order), 0) AS maximum_order FROM demo_sandbox_reset_tables) reset_state
CROSS JOIN unnest(ARRAY[
  'bank_statement_import_rows',
  'bank_statement_imports'
]::text[]) WITH ORDINALITY AS reset_table(table_name, ordinal);
