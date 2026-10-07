-- The deferred guard sees the inserted revision at COMMIT. Exclude only that
-- row while retaining all scope, version, date, coverage, and rival checks.
CREATE OR REPLACE FUNCTION app.guard_tax_account_mapping_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor tax_account_mapping_sets%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM legal_entities entity
    JOIN ledgers ledger
      ON ledger.organization_id = entity.organization_id
     AND ledger.legal_entity_id = entity.id
     AND ledger.id = NEW.ledger_id
    JOIN tax_filing_templates template
      ON template.id = NEW.template_id
     AND template.currency_code = ledger.functional_currency
    WHERE entity.organization_id = NEW.organization_id
      AND entity.id = NEW.legal_entity_id
      AND entity.active AND ledger.active
  ) OR (NEW.version = 1 AND NEW.supersedes_mapping_set_id IS NOT NULL)
    OR (NEW.version > 1 AND NEW.supersedes_mapping_set_id IS NULL)
    OR (NEW.state = 'ACTIVE' AND EXISTS (
      SELECT 1
      FROM tax_filing_templates template
      CROSS JOIN LATERAL jsonb_array_elements(template.definition -> 'fields') field
      WHERE template.id = NEW.template_id
        AND field ->> 'kind' = 'ACCOUNT'
        AND (field ->> 'required')::boolean
        AND NOT EXISTS (
          SELECT 1 FROM tax_account_mapping_lines line
          WHERE line.organization_id = NEW.organization_id
            AND line.mapping_set_id = NEW.id
            AND line.field_key = field ->> 'key'
        )
    )) OR (NEW.state = 'INACTIVE' AND EXISTS (
      SELECT 1 FROM tax_account_mapping_lines line
      WHERE line.organization_id = NEW.organization_id
        AND line.mapping_set_id = NEW.id
    )) THEN
    RAISE EXCEPTION 'Tax mapping set scope, state, or required field coverage is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.version > 1 THEN
    SELECT * INTO predecessor FROM tax_account_mapping_sets mapping
    WHERE mapping.organization_id = NEW.organization_id
      AND mapping.id = NEW.supersedes_mapping_set_id
      AND NOT EXISTS (
        SELECT 1 FROM tax_account_mapping_sets successor
        WHERE successor.organization_id = mapping.organization_id
          AND successor.supersedes_mapping_set_id = mapping.id
          AND successor.id <> NEW.id
      );
    IF predecessor.id IS NULL
      OR predecessor.legal_entity_id <> NEW.legal_entity_id
      OR predecessor.ledger_id <> NEW.ledger_id
      OR predecessor.template_id <> NEW.template_id
      OR predecessor.version <> NEW.version - 1
      OR NEW.effective_from <= predecessor.effective_from THEN
      RAISE EXCEPTION 'Tax mapping version must supersede the exact current scope prospectively'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_account_mapping_set() FROM PUBLIC;

