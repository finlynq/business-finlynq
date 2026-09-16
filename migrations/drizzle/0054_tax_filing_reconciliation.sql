CREATE TABLE "tax_account_mapping_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"mapping_set_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"gl_account_id" uuid NOT NULL,
	"balance_basis" text NOT NULL,
	"multiplier" numeric(12, 6) DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_account_mapping_lines_basis_check" CHECK ("tax_account_mapping_lines"."balance_basis" IN ('DEBITS', 'CREDITS', 'NET_DEBIT', 'NET_CREDIT', 'ABSOLUTE_NET')),
	CONSTRAINT "tax_account_mapping_lines_multiplier_check" CHECK (abs("tax_account_mapping_lines"."multiplier") <= 1000 AND "tax_account_mapping_lines"."multiplier" <> 0)
);
--> statement-breakpoint
CREATE TABLE "tax_account_mapping_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_account_mapping_sets_version_check" CHECK ("tax_account_mapping_sets"."version" > 0),
	CONSTRAINT "tax_account_mapping_sets_reason_check" CHECK (char_length(btrim("tax_account_mapping_sets"."reason")) BETWEEN 8 AND 500),
	CONSTRAINT "tax_account_mapping_sets_hash_check" CHECK ("tax_account_mapping_sets"."command_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tax_filing_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"authority" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"form_code" text NOT NULL,
	"currency_code" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"definition" jsonb NOT NULL,
	"source_uri" text NOT NULL,
	"source_digest" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tax_filing_templates_version_check" CHECK ("tax_filing_templates"."version" > 0),
	CONSTRAINT "tax_filing_templates_effective_period_check" CHECK ("tax_filing_templates"."effective_to" IS NULL OR "tax_filing_templates"."effective_to" >= "tax_filing_templates"."effective_from"),
	CONSTRAINT "tax_filing_templates_definition_check" CHECK (jsonb_typeof("tax_filing_templates"."definition") = 'object' AND "tax_filing_templates"."definition" ->> 'schemaVersion' = '1'),
	CONSTRAINT "tax_filing_templates_source_digest_check" CHECK ("tax_filing_templates"."source_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tax_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"mapping_set_id" uuid NOT NULL,
	"filing_type" text NOT NULL,
	"status" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"external_reference" text,
	"source_file_name" text,
	"reported_values" jsonb NOT NULL,
	"calculated_values" jsonb NOT NULL,
	"reconciliation_snapshot" jsonb NOT NULL,
	"validation_snapshot" jsonb NOT NULL,
	"template_snapshot" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_filings_type_check" CHECK ("tax_filings"."filing_type" IN ('PREPARED', 'HISTORICAL_IMPORT')),
	CONSTRAINT "tax_filings_status_check" CHECK ("tax_filings"."status" IN ('READY', 'MATCHED', 'REVIEW_REQUIRED')),
	CONSTRAINT "tax_filings_period_check" CHECK ("tax_filings"."period_start" <= "tax_filings"."period_end"),
	CONSTRAINT "tax_filings_payload_check" CHECK (jsonb_typeof("tax_filings"."reported_values") = 'object'
        AND jsonb_typeof("tax_filings"."calculated_values") = 'object'
        AND jsonb_typeof("tax_filings"."reconciliation_snapshot") = 'array'
        AND jsonb_typeof("tax_filings"."validation_snapshot") = 'array'
        AND jsonb_typeof("tax_filings"."template_snapshot") = 'object'),
	CONSTRAINT "tax_filings_import_evidence_check" CHECK ("tax_filings"."filing_type" <> 'HISTORICAL_IMPORT'
        OR ("tax_filings"."external_reference" IS NOT NULL
          AND char_length(btrim("tax_filings"."external_reference")) BETWEEN 1 AND 200
          AND "tax_filings"."reported_values" <> '{}')),
	CONSTRAINT "tax_filings_hash_check" CHECK ("tax_filings"."command_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tax_account_mapping_sets_org_id_unique" ON "tax_account_mapping_sets" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "tax_account_mapping_lines" ADD CONSTRAINT "tax_account_mapping_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_lines" ADD CONSTRAINT "tax_account_mapping_lines_org_set_fk" FOREIGN KEY ("organization_id","mapping_set_id") REFERENCES "public"."tax_account_mapping_sets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_lines" ADD CONSTRAINT "tax_account_mapping_lines_org_account_fk" FOREIGN KEY ("organization_id","gl_account_id") REFERENCES "public"."gl_accounts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD CONSTRAINT "tax_account_mapping_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD CONSTRAINT "tax_account_mapping_sets_template_id_tax_filing_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."tax_filing_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD CONSTRAINT "tax_account_mapping_sets_org_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_account_mapping_sets" ADD CONSTRAINT "tax_account_mapping_sets_org_ledger_fk" FOREIGN KEY ("organization_id","ledger_id") REFERENCES "public"."ledgers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filing_templates" ADD CONSTRAINT "tax_filing_templates_currency_code_currency_definitions_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currency_definitions"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filings" ADD CONSTRAINT "tax_filings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filings" ADD CONSTRAINT "tax_filings_template_id_tax_filing_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."tax_filing_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filings" ADD CONSTRAINT "tax_filings_org_entity_fk" FOREIGN KEY ("organization_id","legal_entity_id") REFERENCES "public"."legal_entities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filings" ADD CONSTRAINT "tax_filings_org_ledger_fk" FOREIGN KEY ("organization_id","ledger_id") REFERENCES "public"."ledgers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_filings" ADD CONSTRAINT "tax_filings_org_mapping_set_fk" FOREIGN KEY ("organization_id","mapping_set_id") REFERENCES "public"."tax_account_mapping_sets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_account_mapping_lines_org_id_unique" ON "tax_account_mapping_lines" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_account_mapping_lines_identity_unique" ON "tax_account_mapping_lines" USING btree ("mapping_set_id","field_key","gl_account_id");--> statement-breakpoint
CREATE INDEX "tax_account_mapping_lines_set_field_idx" ON "tax_account_mapping_lines" USING btree ("mapping_set_id","field_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_account_mapping_sets_scope_version_unique" ON "tax_account_mapping_sets" USING btree ("organization_id","ledger_id","template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_account_mapping_sets_org_idempotency_unique" ON "tax_account_mapping_sets" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "tax_account_mapping_sets_active_lookup" ON "tax_account_mapping_sets" USING btree ("organization_id","ledger_id","template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filing_templates_key_version_unique" ON "tax_filing_templates" USING btree ("template_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filings_org_id_unique" ON "tax_filings" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_filings_org_idempotency_unique" ON "tax_filings" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "tax_filings_scope_period_idx" ON "tax_filings" USING btree ("organization_id","ledger_id","template_id","period_end");
--> statement-breakpoint

-- The first shared return definition follows the CRA GST/HST working-copy
-- lines and keeps formulas, percentage checks, thresholds, and sources inside
-- the versioned template. Client account choices never modify this row.
INSERT INTO tax_filing_templates (
  id, template_key, version, name, authority, jurisdiction, form_code,
  currency_code, effective_from, effective_to, definition, source_uri,
  source_digest, published_at
) VALUES (
  'f1000000-0000-4000-8000-000000000001'::uuid,
  'ca.gst-hst.return', 1, 'Canada GST/HST Return',
  'Canada Revenue Agency', 'CA-FEDERAL', 'GST34', 'CAD',
  '2025-04-01'::date, NULL,
  $template${"schemaVersion":1,"instructions":"Prepare or reconcile a GST/HST return workpaper. Account mappings are organization- and ledger-specific. Review CRA instructions and supporting evidence before filing; this template does not submit a return to CRA.","reconciliationTolerance":"0.01","fields":[{"key":"line_101","code":"101","label":"Sales and other revenue","description":"Total revenue for the reporting period, excluding GST/HST.","kind":"ACCOUNT","valueType":"MONEY","allowAccountMapping":true,"required":true,"reconcile":true,"defaultBalanceBasis":"NET_CREDIT"},{"key":"line_103","code":"103","label":"GST/HST collected or collectible","description":"GST/HST collected or collectible for the reporting period.","kind":"ACCOUNT","valueType":"MONEY","allowAccountMapping":true,"required":true,"reconcile":true,"defaultBalanceBasis":"NET_CREDIT"},{"key":"line_104","code":"104","label":"Adjustments added to net tax","description":"Adjustments that increase net tax for the reporting period.","kind":"MANUAL","valueType":"MONEY","allowAccountMapping":false,"required":false,"reconcile":true},{"key":"line_105","code":"105","label":"Total GST/HST and adjustments","description":"Line 103 plus line 104.","kind":"CALCULATED","valueType":"MONEY","allowAccountMapping":false,"required":true,"reconcile":true,"formula":{"operation":"ADD","operands":["line_103","line_104"]}},{"key":"line_106","code":"106","label":"Input tax credits","description":"Eligible GST/HST paid or payable on qualifying expenses.","kind":"ACCOUNT","valueType":"MONEY","allowAccountMapping":true,"required":true,"reconcile":true,"defaultBalanceBasis":"NET_DEBIT"},{"key":"line_107","code":"107","label":"Adjustments deducted from net tax","description":"Adjustments deducted when determining net tax.","kind":"MANUAL","valueType":"MONEY","allowAccountMapping":false,"required":false,"reconcile":true},{"key":"line_108","code":"108","label":"Total ITCs and adjustments","description":"Line 106 plus line 107.","kind":"CALCULATED","valueType":"MONEY","allowAccountMapping":false,"required":true,"reconcile":true,"formula":{"operation":"ADD","operands":["line_106","line_107"]}},{"key":"line_109","code":"109","label":"Net tax","description":"Line 105 less line 108.","kind":"CALCULATED","valueType":"MONEY","allowAccountMapping":false,"required":true,"reconcile":true,"formula":{"operation":"SUBTRACT","operands":["line_105","line_108"]}},{"key":"line_110","code":"110","label":"Instalments and other annual filer payments","description":"Instalments and other annual filer payments made for the reporting period.","kind":"MANUAL","valueType":"MONEY","allowAccountMapping":false,"required":false,"reconcile":true},{"key":"line_111","code":"111","label":"Rebates","description":"Eligible GST/HST rebates supported by the applicable rebate form.","kind":"MANUAL","valueType":"MONEY","allowAccountMapping":false,"required":false,"reconcile":true},{"key":"line_112","code":"112","label":"Total other credits","description":"Line 110 plus line 111.","kind":"CALCULATED","valueType":"MONEY","allowAccountMapping":false,"required":true,"reconcile":true,"formula":{"operation":"ADD","operands":["line_110","line_111"]}},{"key":"line_113a","code":"113 A","label":"Balance before other debits","description":"Line 109 less line 112.","kind":"CALCULATED","valueType":"MONEY","allowAccountMapping":false,"required":true,"reconcile":true,"formula":{"operation":"SUBTRACT","operands":["line_109","line_112"]}},{"key":"line_205","code":"205","label":"Tax due on real property or emission allowances","description":"GST/HST due on qualifying purchases of real property or emission allowances.","kind":"MANUAL","valueType":"MONEY","allowAccountMapping":false,"required":false,"reconcile":true},{"key":"line_405","code":"405","label":"Other GST/HST to self-assess","description":"Other GST/HST that must be self-assessed.","kind":"MANUAL","valueType":"MONEY","allowAccountMapping":false,"required":false,"reconcile":true},{"key":"line_113b","code":"113 B","label":"Total other debits","description":"Line 205 plus line 405.","kind":"CALCULATED","valueType":"MONEY","allowAccountMapping":false,"required":true,"reconcile":true,"formula":{"operation":"ADD","operands":["line_205","line_405"]}},{"key":"line_113c","code":"113 C","label":"Final balance","description":"Line 113 A plus line 113 B.","kind":"CALCULATED","valueType":"MONEY","allowAccountMapping":false,"required":true,"reconcile":true,"formula":{"operation":"ADD","operands":["line_113a","line_113b"]}},{"key":"line_114","code":"114","label":"Refund claimed","description":"Absolute value of a negative line 113 C balance.","kind":"CALCULATED","valueType":"MONEY","allowAccountMapping":false,"required":true,"reconcile":true,"formula":{"operation":"NEGATIVE_PART","operands":["line_113c"]}},{"key":"line_115","code":"115","label":"Payment due","description":"Positive line 113 C balance.","kind":"CALCULATED","valueType":"MONEY","allowAccountMapping":false,"required":true,"reconcile":true,"formula":{"operation":"POSITIVE_PART","operands":["line_113c"]}}],"validations":[{"key":"collected_rate_range","type":"PERCENTAGE_RANGE","label":"Collected tax percentage","description":"Collected tax should not be negative or exceed the current highest general GST/HST rate. Mixed, zero-rated, exempt, and place-of-supply transactions can make the effective rate lower.","severity":"WARNING","numeratorField":"line_103","denominatorField":"line_101","minimumRate":"0","maximumRate":"0.15","source":"https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html"},{"key":"small_supplier_review","type":"THRESHOLD","label":"Small-supplier threshold review","description":"Review registration status when mapped taxable revenue exceeds CAD 30,000. The legal test considers a single quarter and up to four consecutive calendar quarters, associated persons, and exclusions; this warning is not the legal determination.","severity":"WARNING","field":"line_101","operator":"LTE","threshold":"30000","source":"https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge.html"},{"key":"refund_or_payment","type":"ONE_OF_ZERO","label":"Refund/payment exclusivity","description":"A return cannot have both a refund claimed and a payment due.","severity":"ERROR","fields":["line_114","line_115"],"source":"https://www.canada.ca/content/dam/cra-arc/migration/cra-arc/tx/bsnss/tpcs/gst-tps/bspsbch/rtrns/wrkngcp-eng.pdf"}]}$template$::jsonb,
  'https://www.canada.ca/content/dam/cra-arc/migration/cra-arc/tx/bsnss/tpcs/gst-tps/bspsbch/rtrns/wrkngcp-eng.pdf',
  'a18fe2bf40e810141c972bfdcba87e5ff181ed125cc5740e00574195398a4bf5',
  '2026-09-16T00:00:00Z'::timestamptz
);
--> statement-breakpoint

INSERT INTO permissions(key, description) VALUES
  ('tax.mappings.manage', 'Create client-specific, versioned tax-template account mappings'),
  ('tax.filings.prepare', 'Prepare and reconcile immutable tax filing workpapers')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions(organization_id, role_id, permission_key)
SELECT role.organization_id, role.id, permission.key
FROM roles role
CROSS JOIN permissions permission
WHERE permission.key IN ('tax.mappings.manage', 'tax.filings.prepare')
  AND (
    role.key IN ('OWNER', 'ACCOUNTANT_APPROVER', 'BOOKKEEPER_MAKER', 'demo_accountant')
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint

CREATE FUNCTION app.assign_tax_filing_template_permissions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT NEW.system_template THEN RETURN NEW; END IF;
  INSERT INTO role_permissions(organization_id, role_id, permission_key)
  SELECT NEW.organization_id, NEW.id, permission.key
  FROM permissions permission
  WHERE permission.key IN ('tax.mappings.manage', 'tax.filings.prepare')
    AND NEW.key IN ('OWNER', 'ACCOUNTANT_APPROVER', 'BOOKKEEPER_MAKER', 'demo_accountant')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.assign_tax_filing_template_permissions() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER assign_tax_filing_template_permissions
  AFTER INSERT OR UPDATE OF key, system_template ON roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assign_tax_filing_template_permissions();
--> statement-breakpoint

ALTER TABLE tax_account_mapping_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_account_mapping_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_account_mapping_sets
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE tax_account_mapping_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_account_mapping_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_account_mapping_lines
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
ALTER TABLE tax_filings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_filings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_filings
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
--> statement-breakpoint

-- Every tenant record is append-only. The web role has no UPDATE or DELETE,
-- and this trigger preserves that contract even if privileges drift.
CREATE FUNCTION app.guard_tax_filing_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  required_permission text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  required_permission := CASE
    WHEN TG_TABLE_NAME IN ('tax_account_mapping_sets', 'tax_account_mapping_lines')
      THEN 'tax.mappings.manage'
    WHEN TG_TABLE_NAME = 'tax_filings' THEN 'tax.filings.prepare'
  END;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_id() IS NULL
    OR required_permission IS NULL
    OR NOT app.current_actor_has_permission(required_permission)
    OR (TG_TABLE_NAME IN ('tax_account_mapping_sets', 'tax_filings')
      AND (to_jsonb(NEW)->>'created_by')::uuid IS DISTINCT FROM app.current_actor_id()) THEN
    RAISE EXCEPTION 'Tax filing permission or actor context is invalid'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_filing_mutation() FROM PUBLIC;

CREATE TRIGGER tax_account_mapping_sets_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tax_account_mapping_sets
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_mutation();
CREATE TRIGGER tax_account_mapping_lines_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tax_account_mapping_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_mutation();
CREATE TRIGGER tax_filings_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tax_filings
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_mutation();
--> statement-breakpoint

CREATE FUNCTION app.guard_tax_account_mapping_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM tax_account_mapping_sets mapping_set
    JOIN tax_filing_templates template ON template.id = mapping_set.template_id
    JOIN gl_accounts account
      ON account.organization_id = mapping_set.organization_id
     AND account.ledger_id = mapping_set.ledger_id
     AND account.id = NEW.gl_account_id
    CROSS JOIN LATERAL jsonb_array_elements(template.definition -> 'fields') field
    WHERE mapping_set.organization_id = NEW.organization_id
      AND mapping_set.id = NEW.mapping_set_id
      AND account.active AND account.postable AND account.control_kind = 'NONE'
      AND field ->> 'key' = NEW.field_key
      AND (field ->> 'allowAccountMapping')::boolean
  ) THEN
    RAISE EXCEPTION 'Tax mapping field, account, or ledger is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_account_mapping_line() FROM PUBLIC;
CREATE TRIGGER tax_account_mapping_line_integrity_guard
  BEFORE INSERT ON tax_account_mapping_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_account_mapping_line();
--> statement-breakpoint

CREATE FUNCTION app.guard_tax_account_mapping_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
  ) OR EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'Tax mapping set does not cover its active ledger and required fields'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_account_mapping_set() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER tax_account_mapping_set_integrity_guard
  AFTER INSERT ON tax_account_mapping_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_account_mapping_set();
--> statement-breakpoint

CREATE FUNCTION app.guard_tax_filing_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_exception boolean;
  expected_status text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.reconciliation_snapshot) field
    WHERE field ->> 'status' <> 'MATCHED'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.validation_snapshot) rule
    WHERE rule ->> 'status' = 'FAIL'
  ) INTO has_exception;
  expected_status := CASE
    WHEN has_exception THEN 'REVIEW_REQUIRED'
    WHEN NEW.filing_type = 'PREPARED' THEN 'READY'
    ELSE 'MATCHED'
  END;

  IF NEW.status <> expected_status OR NOT EXISTS (
    SELECT 1
    FROM tax_account_mapping_sets mapping_set
    JOIN tax_filing_templates template ON template.id = mapping_set.template_id
    JOIN ledgers ledger
      ON ledger.organization_id = mapping_set.organization_id
     AND ledger.id = mapping_set.ledger_id
     AND ledger.legal_entity_id = mapping_set.legal_entity_id
     AND ledger.functional_currency = template.currency_code
    WHERE mapping_set.organization_id = NEW.organization_id
      AND mapping_set.id = NEW.mapping_set_id
      AND mapping_set.legal_entity_id = NEW.legal_entity_id
      AND mapping_set.ledger_id = NEW.ledger_id
      AND mapping_set.template_id = NEW.template_id
      AND (NEW.template_snapshot ->> 'id')::uuid = template.id
      AND (NEW.template_snapshot ->> 'mappingSetId')::uuid = mapping_set.id
      AND (NEW.template_snapshot ->> 'mappingVersion')::integer = mapping_set.version
      AND NEW.template_snapshot ->> 'sourceDigest' = template.source_digest
      AND NEW.template_snapshot -> 'definition' = template.definition
  ) THEN
    RAISE EXCEPTION 'Tax filing status, template, ledger, or mapping lineage is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.guard_tax_filing_integrity() FROM PUBLIC;
CREATE TRIGGER tax_filing_integrity_guard
  BEFORE INSERT ON tax_filings
  FOR EACH ROW EXECUTE FUNCTION app.guard_tax_filing_integrity();
--> statement-breakpoint

CREATE FUNCTION app.audit_tax_filing_event()
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
    WHEN 'tax_account_mapping_sets' THEN 'tax.mapping.version-created'
    ELSE CASE to_jsonb(NEW) ->> 'filing_type'
      WHEN 'HISTORICAL_IMPORT' THEN 'tax.filing.historical-reconciled'
      ELSE 'tax.filing.prepared'
    END
  END;
  selected_type := CASE TG_TABLE_NAME
    WHEN 'tax_account_mapping_sets' THEN 'tax_account_mapping_set'
    ELSE 'tax_filing'
  END;
  PERFORM app.append_tenant_business_audit(
    NEW.organization_id, selected_action, selected_type, NEW.id::text,
    jsonb_strip_nulls(CASE TG_TABLE_NAME
      WHEN 'tax_account_mapping_sets' THEN jsonb_build_object(
        'legalEntityId', NEW.legal_entity_id, 'ledgerId', NEW.ledger_id,
        'templateId', NEW.template_id, 'version', NEW.version,
        'commandHash', NEW.command_hash
      )
      ELSE jsonb_build_object(
        'legalEntityId', NEW.legal_entity_id, 'ledgerId', NEW.ledger_id,
        'templateId', NEW.template_id,
        'mappingSetId', to_jsonb(NEW) ->> 'mapping_set_id',
        'filingType', to_jsonb(NEW) ->> 'filing_type',
        'status', to_jsonb(NEW) ->> 'status',
        'periodStart', to_jsonb(NEW) ->> 'period_start',
        'periodEnd', to_jsonb(NEW) ->> 'period_end',
        'externalReferencePresent', to_jsonb(NEW) ->> 'external_reference' IS NOT NULL,
        'sourceFileNamePresent', to_jsonb(NEW) ->> 'source_file_name' IS NOT NULL,
        'commandHash', NEW.command_hash
      )
    END),
    NULL
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.audit_tax_filing_event() FROM PUBLIC;
CREATE TRIGGER tax_account_mapping_set_business_audit
  AFTER INSERT ON tax_account_mapping_sets
  FOR EACH ROW EXECUTE FUNCTION app.audit_tax_filing_event();
CREATE TRIGGER tax_filing_business_audit
  AFTER INSERT ON tax_filings
  FOR EACH ROW EXECUTE FUNCTION app.audit_tax_filing_event();
--> statement-breakpoint

REVOKE ALL ON tax_filing_templates, tax_account_mapping_sets,
  tax_account_mapping_lines, tax_filings FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_app') THEN
    GRANT SELECT ON tax_filing_templates, tax_account_mapping_sets,
      tax_account_mapping_lines, tax_filings TO business_finlynq_app;
    GRANT INSERT ON tax_account_mapping_sets, tax_account_mapping_lines,
      tax_filings TO business_finlynq_app;
    REVOKE UPDATE, DELETE ON tax_filing_templates, tax_account_mapping_sets,
      tax_account_mapping_lines, tax_filings FROM business_finlynq_app;
  END IF;
END
$$;
--> statement-breakpoint

-- New tenant evidence participates in the nightly shared-demo reconstruction.
INSERT INTO demo_sandbox_reset_tables(table_name, purge_order)
SELECT reset_table.table_name, reset_state.maximum_order + reset_table.ordinal::integer
FROM (SELECT coalesce(max(purge_order), 0) AS maximum_order FROM demo_sandbox_reset_tables) reset_state
CROSS JOIN unnest(ARRAY[
  'tax_account_mapping_lines',
  'tax_filings',
  'tax_account_mapping_sets'
]::text[]) WITH ORDINALITY AS reset_table(table_name, ordinal);
