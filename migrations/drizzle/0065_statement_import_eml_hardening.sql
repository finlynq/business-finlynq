-- Statement-import callers intentionally have read-only access to the chart of
-- accounts. The trigger remains the authoritative race-safe mapping guard, so
-- it owns the row locks under a narrowly authorized SECURITY DEFINER boundary.
CREATE OR REPLACE FUNCTION app.guard_bank_external_account_mapping()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_id() IS NULL
    OR NOT app.current_actor_has_permission('banking.reconcile.prepare') THEN
    RAISE EXCEPTION 'Bank-account mapping authorization is required'
      USING ERRCODE = '42501';
  END IF;

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
  FROM public.account_combinations combination
  JOIN public.gl_accounts account
    ON account.organization_id = combination.organization_id
   AND account.ledger_id = combination.ledger_id
   AND account.id = combination.account_id
  JOIN public.ledgers ledger
    ON ledger.organization_id = combination.organization_id
   AND ledger.id = combination.ledger_id
   AND ledger.legal_entity_id = combination.entity_id
  JOIN public.legal_entities entity
    ON entity.organization_id = combination.organization_id
   AND entity.id = combination.entity_id
  JOIN public.organization_currencies enabled_currency
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
    END)::public.account_class
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

-- Preserve raw EML messages as immutable cloud evidence after their sanitized
-- preview and extracted attachment items have been reviewed. The prior
-- constraint remains active until the expanded allowlist validates.
ALTER TABLE document_evidence_assets
  ADD CONSTRAINT document_evidence_assets_metadata_check_v3 CHECK (
    owner_module IN ('receivables','payables')
    AND mime_type IN (
      'application/pdf',
      'image/png',
      'image/jpeg',
      'text/csv',
      'text/tab-separated-values',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'message/rfc822'
    )
    AND byte_size BETWEEN 1 AND 2097152
    AND key_version > 0 AND sha256 ~ '^[a-f0-9]{64}$'
    AND command_hash ~ '^[a-f0-9]{64}$'
    AND length(scanner_version) BETWEEN 1 AND 200
    AND length(filename_ciphertext) BETWEEN 1 AND 4096
    AND length(content_ciphertext) BETWEEN 1 AND 4000000
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE document_evidence_assets
  VALIDATE CONSTRAINT document_evidence_assets_metadata_check_v3;
--> statement-breakpoint
ALTER TABLE document_evidence_assets
  DROP CONSTRAINT document_evidence_assets_metadata_check_v2;
