-- Supplier credits retain signed purchase/tax facts and positive open-item magnitudes.
CREATE OR REPLACE FUNCTION app.guard_subledger_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_source source_documents%ROWTYPE;
  required_permission text;
  selected_is_demo boolean;
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO selected_source FROM source_documents
  WHERE organization_id = NEW.organization_id AND id = NEW.source_document_id
  FOR SHARE;
  IF selected_source.id IS NULL OR selected_source.status <> 'POSTED'
    OR selected_source.legal_entity_id IS DISTINCT FROM (
      SELECT legal_entity_id FROM party_accounts
      WHERE organization_id = NEW.organization_id AND id = NEW.party_account_id
    ) THEN
    RAISE EXCEPTION 'Subledger event requires a posted source for the same party account entity'
      USING ERRCODE = '23514';
  END IF;
  required_permission := CASE
    WHEN selected_source.source_type = 'receivables.sales-invoice' THEN 'receivables.post'
    WHEN selected_source.source_type = 'receivables.customer-receipt' THEN 'receivables.settle'
    WHEN selected_source.source_type IN ('payables.supplier-bill','payables.supplier-credit-note') THEN 'payables.post'
    WHEN selected_source.source_type IN ('payables.supplier-payment','payables.supplier-credit-application') THEN 'payables.settle'
    ELSE NULL END;
  IF required_permission IS NULL OR NOT app.current_actor_has_permission(required_permission) THEN
    RAISE EXCEPTION 'Subledger posting permission is required' USING ERRCODE = '42501';
  END IF;
  SELECT is_demo INTO selected_is_demo FROM organizations WHERE id = NEW.organization_id;
  IF selected_is_demo AND NOT app.current_demo_session_is_valid() THEN
    RAISE EXCEPTION 'Demo subledger events require a live isolated sandbox session'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_source_document_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  prior source_documents%ROWTYPE;
  required_permission text;
  selected_is_demo boolean;
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NULL THEN RETURN NEW; END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_actor_id() THEN
    RAISE EXCEPTION 'Source-document actor does not match transaction context' USING ERRCODE = '42501';
  END IF;
  IF NEW.status NOT IN ('DRAFT', 'POSTED', 'VOIDED')
    OR NEW.owner_module NOT IN ('receivables', 'payables') THEN
    RAISE EXCEPTION 'Unsupported source-document state' USING ERRCODE = '22023';
  END IF;
  IF NEW.owner_module = 'receivables' THEN
    required_permission := CASE
      WHEN NEW.source_type = 'receivables.customer-receipt' THEN
        CASE WHEN NEW.status = 'VOIDED' THEN 'receivables.void' ELSE 'receivables.settle' END
      WHEN NEW.status = 'DRAFT' THEN 'receivables.manage'
      WHEN NEW.status = 'POSTED' THEN 'receivables.post'
      ELSE 'receivables.void' END;
  ELSE
    required_permission := CASE
      WHEN NEW.source_type IN ('payables.supplier-payment','payables.supplier-credit-application') THEN
        CASE WHEN NEW.status = 'VOIDED' THEN 'payables.void' ELSE 'payables.settle' END
      WHEN NEW.status = 'DRAFT' THEN 'payables.manage'
      WHEN NEW.status = 'POSTED' THEN 'payables.post'
      ELSE 'payables.void' END;
  END IF;
  IF NOT app.current_actor_has_permission(required_permission) THEN
    RAISE EXCEPTION 'Source-document permission is required' USING ERRCODE = '42501';
  END IF;
  SELECT is_demo INTO selected_is_demo FROM organizations WHERE id = NEW.organization_id;
  IF selected_is_demo AND NOT app.current_demo_session_is_valid() THEN
    RAISE EXCEPTION 'Demo source documents require a live isolated sandbox session'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.version = 1 THEN
    IF NEW.supersedes_source_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'Initial source-document version cannot supersede another version'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT * INTO prior FROM source_documents
    WHERE organization_id = NEW.organization_id
      AND id = NEW.supersedes_source_document_id
    FOR SHARE;
    IF prior.id IS NULL OR prior.source_type <> NEW.source_type
      OR prior.source_number <> NEW.source_number OR NEW.version <> prior.version + 1
      OR EXISTS (
        SELECT 1 FROM source_documents newer
        WHERE newer.organization_id = NEW.organization_id
          AND newer.source_type = NEW.source_type
          AND newer.source_number = NEW.source_number
          AND newer.version > prior.version
      ) THEN
      RAISE EXCEPTION 'Source-document version must supersede the current matching version'
        USING ERRCODE = '40001';
    END IF;
  END IF;
  IF NEW.status = 'VOIDED' AND length(coalesce(NEW.void_reason, '')) < 5 THEN
    RAISE EXCEPTION 'Voiding a source document requires a reason' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_settlement_allocation_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_item open_items%ROWTYPE;
  selected_party_role party_role_kind;
  selected_functional_currency text;
  selected_functional_minor_units integer;
  selected_payment source_documents%ROWTYPE;
  selected_original document_settlement_allocations%ROWTYPE;
  applied_amount numeric(38,9);
  allocated_carrying numeric(38,9);
  remaining_transaction numeric(38,9);
  remaining_carrying numeric(38,9);
  expected_carrying numeric(38,9);
  required_permission text;
  expected_settlement numeric(38,9);
  expected_realized numeric(38,9);
  selected_is_demo boolean;
BEGIN
  IF nullif(current_setting('app.organization_id', true), '') IS NULL THEN RETURN NEW; END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_actor_id() THEN
    RAISE EXCEPTION 'Settlement actor does not match transaction context' USING ERRCODE = '42501';
  END IF;
  SELECT item.*
    INTO selected_item
  FROM open_items item
  WHERE item.organization_id = NEW.organization_id AND item.id = NEW.open_item_id
  FOR UPDATE OF item;
  SELECT account.role, ledger.functional_currency
    INTO selected_party_role, selected_functional_currency
  FROM party_accounts account
  JOIN ledgers ledger
    ON ledger.organization_id = account.organization_id AND ledger.id = account.ledger_id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = selected_item.party_account_id;
  IF selected_item.id IS NULL OR selected_item.ledger_id <> NEW.ledger_id
    OR selected_item.transaction_currency <> NEW.transaction_currency THEN
    RAISE EXCEPTION 'Allocation does not match the open item ledger and currency'
      USING ERRCODE = '23514';
  END IF;
  selected_functional_minor_units := app.currency_minor_units(selected_functional_currency);
  IF selected_party_role IS NULL OR selected_functional_minor_units IS NULL THEN
    RAISE EXCEPTION 'Allocation requires an active party account and functional currency'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO selected_payment FROM source_documents
  WHERE organization_id = NEW.organization_id AND id = NEW.payment_source_document_id
  FOR SHARE;
  IF selected_payment.id IS NULL
    OR selected_payment.snapshot->>'partyAccountId' <> selected_item.party_account_id::text
    OR selected_payment.snapshot->>'ledgerId' <> selected_item.ledger_id::text THEN
    RAISE EXCEPTION 'Allocation payment source does not match the open item'
      USING ERRCODE = '23514';
  END IF;
  required_permission := CASE selected_party_role
    WHEN 'CUSTOMER' THEN CASE WHEN NEW.allocation_type = 'REVERSAL' THEN 'receivables.void' ELSE 'receivables.settle' END
    WHEN 'SUPPLIER' THEN CASE WHEN NEW.allocation_type = 'REVERSAL' THEN 'payables.void' ELSE 'payables.settle' END
  END;
  IF NOT app.current_actor_has_permission(required_permission) THEN
    RAISE EXCEPTION 'Settlement permission is required' USING ERRCODE = '42501';
  END IF;
  IF (selected_party_role = 'CUSTOMER' AND selected_payment.source_type <> 'receivables.customer-receipt')
    OR (selected_party_role = 'SUPPLIER' AND selected_payment.source_type NOT IN ('payables.supplier-payment','payables.supplier-credit-application'))
    OR (NEW.allocation_type = 'APPLY' AND selected_payment.status <> 'POSTED')
    OR (NEW.allocation_type = 'REVERSAL' AND selected_payment.status <> 'VOIDED') THEN
    RAISE EXCEPTION 'Payment source type or state is not valid for this allocation'
      USING ERRCODE = '23514';
  END IF;
  IF selected_payment.source_type = 'payables.supplier-credit-application' THEN
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(selected_payment.snapshot->'allocations') element
      JOIN subledger_events event ON event.organization_id=NEW.organization_id AND event.id=selected_item.source_event_id
      JOIN source_documents origin ON origin.organization_id=event.organization_id AND origin.id=event.source_document_id
      WHERE element->>'openItemId'=NEW.open_item_id::text
        AND (element->>'transactionAmount')::numeric=NEW.transaction_amount
        AND (element->>'carryingFunctionalAmount')::numeric=NEW.carrying_functional_amount
        AND (element->>'carryingFxRate')::numeric=NEW.settlement_fx_rate
        AND origin.source_type IN ('payables.supplier-bill','payables.supplier-credit-note')
        AND origin.snapshot->>'controlAccountCombinationId'=selected_payment.snapshot->>'controlAccountCombinationId'
        AND (origin.snapshot->>'accountingDate')::date <= NEW.effective_on
    ) THEN
      RAISE EXCEPTION 'Credit application allocation must match its immutable bill/credit snapshot' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT
    coalesce(sum(CASE allocation_type
      WHEN 'APPLY' THEN transaction_amount ELSE -transaction_amount END), 0),
    coalesce(sum(CASE allocation_type
      WHEN 'APPLY' THEN carrying_functional_amount ELSE -carrying_functional_amount END), 0)
    INTO applied_amount, allocated_carrying
  FROM document_settlement_allocations
  WHERE organization_id = NEW.organization_id AND open_item_id = NEW.open_item_id;
  remaining_transaction := selected_item.original_transaction_amount - applied_amount;
  remaining_carrying := selected_item.original_functional_amount - allocated_carrying;

  IF NEW.allocation_type = 'APPLY' THEN
    IF remaining_transaction <= 0 OR remaining_carrying <= 0
      OR NEW.transaction_amount > remaining_transaction THEN
      RAISE EXCEPTION 'Settlement would over-allocate the open item' USING ERRCODE = '23514';
    END IF;
    expected_carrying := CASE
      WHEN NEW.transaction_amount = remaining_transaction THEN remaining_carrying
      ELSE round(
        NEW.transaction_amount * selected_item.original_functional_amount
          / selected_item.original_transaction_amount,
        selected_functional_minor_units
      )
    END;
    IF expected_carrying <= 0 OR NEW.carrying_functional_amount <> expected_carrying THEN
      RAISE EXCEPTION 'Settlement carrying amount is inconsistent with the open item balance'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO selected_original FROM document_settlement_allocations
    WHERE organization_id = NEW.organization_id AND id = NEW.reverses_allocation_id
      AND open_item_id = NEW.open_item_id AND allocation_type = 'APPLY'
    FOR SHARE;
    IF selected_original.id IS NULL
      OR NEW.transaction_amount <> selected_original.transaction_amount
      OR NEW.carrying_functional_amount <> selected_original.carrying_functional_amount
      OR NEW.settlement_functional_amount <> selected_original.settlement_functional_amount
      OR NEW.realized_fx_functional <> selected_original.realized_fx_functional
      OR NEW.transaction_currency <> selected_original.transaction_currency
      OR NEW.ledger_id <> selected_original.ledger_id
      OR NEW.settlement_fx_rate <> selected_original.settlement_fx_rate
      OR NEW.fx_rate_source <> selected_original.fx_rate_source
      OR NEW.fx_rate_effective_at <> selected_original.fx_rate_effective_at THEN
      RAISE EXCEPTION 'Settlement reversal must exactly reference the original allocation'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  expected_settlement := round(
    NEW.transaction_amount * NEW.settlement_fx_rate,
    selected_functional_minor_units
  );
  expected_realized := CASE selected_party_role
    WHEN 'CUSTOMER' THEN expected_settlement - NEW.carrying_functional_amount
    ELSE NEW.carrying_functional_amount - expected_settlement END;
  IF NEW.settlement_functional_amount <> expected_settlement
    OR NEW.realized_fx_functional <> expected_realized THEN
    RAISE EXCEPTION 'Settlement FX snapshot is inconsistent' USING ERRCODE = '23514';
  END IF;
  SELECT is_demo INTO selected_is_demo FROM organizations WHERE id = NEW.organization_id;
  IF selected_is_demo AND NOT app.current_demo_session_is_valid() THEN
    RAISE EXCEPTION 'Demo allocations require a live isolated sandbox session'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_source_document_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  refs jsonb := coalesce(NEW.snapshot->'evidence', '[]'::jsonb);
  prior_refs jsonb := '[]'::jsonb;
  prior_status text;
  ref jsonb;
BEGIN
  IF jsonb_typeof(refs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Evidence references must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(refs) > 20 THEN
    RAISE EXCEPTION 'Too many evidence references' USING ERRCODE = '22023';
  END IF;
  IF NEW.supersedes_source_document_id IS NOT NULL THEN
    SELECT coalesce(snapshot->'evidence','[]'::jsonb), status INTO prior_refs, prior_status
      FROM source_documents WHERE organization_id = NEW.organization_id AND id = NEW.supersedes_source_document_id;
    IF (NEW.status <> 'DRAFT' OR prior_status <> 'DRAFT') AND refs IS DISTINCT FROM prior_refs THEN
      RAISE EXCEPTION 'Posted evidence lineage is immutable' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.status <> 'DRAFT' AND refs <> '[]'::jsonb THEN
    RAISE EXCEPTION 'Evidence must originate from a draft' USING ERRCODE = '42501';
  END IF;
  IF jsonb_array_length(refs) <> (SELECT count(DISTINCT value->>'assetId') FROM jsonb_array_elements(refs)) THEN
    RAISE EXCEPTION 'Duplicate evidence reference' USING ERRCODE = '22023';
  END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
    IF NEW.source_type NOT IN ('receivables.sales-invoice','payables.supplier-bill','payables.supplier-credit-note')
      OR jsonb_typeof(ref) IS DISTINCT FROM 'object'
      OR ref - 'assetId' - 'purpose' <> '{}'::jsonb
      OR coalesce(ref->>'purpose','') NOT IN ('INVOICE','RECEIPT','SUPPORTING')
      OR NOT EXISTS (SELECT 1 FROM document_evidence_assets
        WHERE organization_id = NEW.organization_id AND owner_module = NEW.owner_module
          AND id::text = ref->>'assetId') THEN
      RAISE EXCEPTION 'Evidence reference is unavailable for this document' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- A credit application is indivisible: exactly one bill and one credit must be
-- consumed (or reversed) in the same transaction. Existing allocation guards
-- enforce tenant, permission, carrying precision, currency and balance limits.
CREATE FUNCTION app.guard_credit_application_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  selected_source source_documents%ROWTYPE;
  allocations_count integer;
  credit_count integer;
  bill_count integer;
  correct_amounts boolean;
BEGIN
  IF TG_TABLE_NAME='source_documents' THEN selected_source := NEW;
  ELSE
    SELECT * INTO selected_source FROM source_documents
    WHERE organization_id=NEW.organization_id AND id=NEW.payment_source_document_id;
  END IF;
  IF selected_source.source_type <> 'payables.supplier-credit-application' THEN RETURN NULL; END IF;
  SELECT count(*), count(*) FILTER(WHERE origin.source_type='payables.supplier-credit-note'
      AND item.id::text=selected_source.snapshot->>'creditOpenItemId'),
    count(*) FILTER(WHERE origin.source_type='payables.supplier-bill'),
    bool_and(allocation.transaction_amount=(selected_source.snapshot->>'amount')::numeric)
  INTO allocations_count,credit_count,bill_count,correct_amounts
  FROM document_settlement_allocations allocation
  JOIN open_items item ON item.organization_id=allocation.organization_id AND item.id=allocation.open_item_id
  JOIN subledger_events event ON event.organization_id=item.organization_id AND event.id=item.source_event_id
  JOIN source_documents origin ON origin.organization_id=event.organization_id AND origin.id=event.source_document_id
  WHERE allocation.organization_id=selected_source.organization_id AND allocation.payment_source_document_id=selected_source.id
    AND allocation.allocation_type=CASE WHEN selected_source.status='VOIDED' THEN 'REVERSAL' ELSE 'APPLY' END;
  IF allocations_count<>2 OR credit_count<>1 OR bill_count<>1 OR correct_amounts IS NOT TRUE THEN
    RAISE EXCEPTION 'Credit application requires exactly one matching bill and credit allocation' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER credit_application_complete
  AFTER INSERT ON source_documents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.guard_credit_application_complete();
CREATE CONSTRAINT TRIGGER credit_application_allocations_complete
  AFTER INSERT ON document_settlement_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.guard_credit_application_complete();
REVOKE ALL ON FUNCTION app.guard_credit_application_complete() FROM PUBLIC;

--> statement-breakpoint
-- GENERATED by `npm run journal-types:generate-seed` from the enabled module manifests.
-- Copy the reviewed statement into a forward migration when adding a journal type.
-- Do not edit this artifact by hand.
INSERT INTO journal_type_definitions (id, key, version, owner_module, display_name, correction_route)
VALUES
  ('88888888-8888-4888-8888-888888888888', 'ledger.manual', 1, 'ledger', 'Manual journal', '/app/journals'),
  ('88888888-8888-4888-8888-888888888889', 'ledger.reversal', 1, 'ledger', 'Full journal reversal', '/app/journals'),
  ('88888888-8888-4888-8888-888888888886', 'payables.bill-void', 1, 'payables', 'Supplier bill void', '/app/payables/bills'),
  ('88888888-8888-4888-8888-888888888882', 'payables.supplier-bill', 1, 'payables', 'Supplier bill', '/app/payables/bills'),
  ('82828282-8282-4282-8282-828282828202', 'payables.supplier-credit-application', 1, 'payables', 'Supplier credit application', '/app/payables/bills'),
  ('82828282-8282-4282-8282-828282828201', 'payables.supplier-credit-note', 1, 'payables', 'Supplier credit note', '/app/payables/bills'),
  ('88888888-8888-4888-8888-888888888885', 'payables.supplier-payment', 1, 'payables', 'Supplier payment', '/app/payables/bills'),
  ('88888888-8888-4888-8888-888888888883', 'receivables.customer-receipt', 1, 'receivables', 'Customer receipt', '/app/receivables/invoices'),
  ('88888888-8888-4888-8888-888888888884', 'receivables.invoice-void', 1, 'receivables', 'Sales invoice void', '/app/receivables/invoices'),
  ('88888888-8888-4888-8888-888888888881', 'receivables.sales-invoice', 1, 'receivables', 'Sales invoice', '/app/receivables/invoices')
ON CONFLICT (key, version) DO UPDATE SET
  owner_module = EXCLUDED.owner_module,
  display_name = EXCLUDED.display_name,
  correction_route = EXCLUDED.correction_route;
