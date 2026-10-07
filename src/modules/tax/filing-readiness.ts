import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { exact } from "@/kernel/money";

export const taxFilingReadinessSchema = z.object({
  legalEntityId: z.uuid(), ledgerId: z.uuid(), templateId: z.uuid(),
  configurationId: z.uuid().optional(), periodStart: z.iso.date(), periodEnd: z.iso.date(),
}).strict().refine((value) => value.periodStart <= value.periodEnd, { message: "The reporting period is invalid" });
export type TaxFilingReadinessInput = z.infer<typeof taxFilingReadinessSchema>;
export type TaxFilingBlocker = Readonly<{ code: string; message: string; remediationUrl: string }>;
export type TaxMappingCoverage = Readonly<{
  required: boolean;
  currentBookNetIncome: string;
  omittedNetIncome: string;
  unmappedAccounts: readonly Readonly<{
    id: string; code: string; name: string; accountClass: string;
    debits: string; credits: string; netIncome: string; hasActivity: boolean;
  }>[];
}>;
export type TaxFilingReadiness = Readonly<{
  ready: boolean;
  checkedAt: string;
  ledgerFingerprint: string;
  configuration: Readonly<{ id: string; version: number; templateId: string; mappingSetId: string; mappingVersion: number }> | null;
  blockers: readonly TaxFilingBlocker[];
  coverage: TaxMappingCoverage;
}>;

/** All reads share the caller's repeatable-read snapshot. No ledger writes. */
export async function loadTaxFilingReadiness(client: PoolClient, organizationId: string, input: TaxFilingReadinessInput): Promise<TaxFilingReadiness> {
  const blockers: TaxFilingBlocker[] = [];
  const block = (code: string, message: string, section = "tax-configuration") => blockers.push({ code, message, remediationUrl: `/app/tax#${section}` });
  const scope = (await client.query<{ template_key: string; has_book_income: boolean }>(
    `SELECT template.template_key,
       EXISTS (SELECT 1 FROM jsonb_array_elements(template.definition->'fields') field
         WHERE field->>'key'='wp_book_net_income' AND (field->>'allowAccountMapping')::boolean) AS has_book_income
     FROM tax_filing_templates template
     JOIN ledgers ledger ON ledger.organization_id=$1 AND ledger.id=$2
       AND ledger.legal_entity_id=$3 AND ledger.active AND ledger.functional_currency=template.currency_code
     JOIN legal_entities entity ON entity.organization_id=$1 AND entity.id=$3 AND entity.active
     WHERE template.id=$4 AND template.effective_from<=$5::date
       AND (template.effective_to IS NULL OR template.effective_to >= $5::date)`,
    [organizationId, input.ledgerId, input.legalEntityId, input.templateId, input.periodEnd],
  )).rows[0];
  if (!scope) block("INVALID_FILING_SCOPE", "Choose an active company ledger and a template effective for the reporting period.");
  const configurations = scope ? (await client.query<{
    id: string; version: number; state: string; template_id: string; mapping_set_id: string; mapping_version: number;
    mapping_state: string; mapping_effective_from: string; mapping_effective_to: string | null;
    later_mapping: boolean;
  }>(
    `SELECT configuration.id,configuration.version,configuration.state,configuration.template_id,
       configuration.mapping_set_id,mapping.version AS mapping_version,mapping.state AS mapping_state,
       mapping.effective_from::text AS mapping_effective_from,mapping.effective_to::text AS mapping_effective_to,
       EXISTS (SELECT 1 FROM tax_account_mapping_sets later
         WHERE later.organization_id=$1 AND later.ledger_id=mapping.ledger_id
           AND later.template_id=mapping.template_id AND later.version>mapping.version
           AND later.effective_from <= $5::date) AS later_mapping
     FROM tax_filing_configurations configuration
     JOIN tax_account_mapping_sets mapping ON mapping.organization_id=$1 AND mapping.id=configuration.mapping_set_id
       AND mapping.ledger_id=$3 AND mapping.legal_entity_id=$2 AND mapping.template_id=configuration.template_id
     WHERE configuration.organization_id=$1 AND configuration.legal_entity_id=$2
       AND configuration.ledger_id=$3 AND configuration.filing_type_key=$4
       AND configuration.effective_from <= $5::date
       AND (configuration.effective_to IS NULL OR configuration.effective_to >= $5::date)
       AND ($6::uuid IS NULL OR configuration.id=$6)
       AND NOT EXISTS (SELECT 1 FROM tax_filing_configurations successor
         WHERE successor.organization_id=$1 AND successor.supersedes_configuration_id=configuration.id
           AND successor.effective_from <= $5::date)
     ORDER BY configuration.effective_from DESC,configuration.version DESC LIMIT 2`,
    [organizationId, input.legalEntityId, input.ledgerId, scope.template_key, input.periodEnd, input.configurationId ?? null],
  )).rows : [];
  const configuration = configurations.length === 1 ? configurations[0]! : null;
  if (scope && !configuration) block(configurations.length ? "CONFIGURATION_OVERLAP" : "CONFIGURATION_REQUIRED",
    configurations.length ? "More than one filing configuration applies. Choose the exact reviewed configuration for this scope."
      : "Activate a filing configuration for this reporting period. This requires tax.filing.configuration.manage; ask an authorized owner to review the exact template and mapping.");
  if (configuration) {
    if (configuration.state !== "ACTIVE") block("CONFIGURATION_INACTIVE", "The effective filing configuration is inactive. An authorized owner must review and activate a configuration.");
    if (configuration.template_id !== input.templateId) block("CONFIGURED_TEMPLATE_REQUIRED", "Select the template version pinned by the effective filing configuration.");
    if (configuration.later_mapping) block("CONFIGURATION_MAPPING_OUTDATED", `Configuration v${configuration.version} still pins mapping v${configuration.mapping_version}, but a newer mapping is effective for this period. Review and activate a configuration revision using that mapping; saving mappings alone does not activate them.`);
    if (configuration.mapping_state !== "ACTIVE" || configuration.mapping_effective_from > input.periodEnd
      || (configuration.mapping_effective_to && configuration.mapping_effective_to < input.periodEnd)) {
      block("CONFIGURATION_MAPPING_NOT_EFFECTIVE", "The pinned mapping is not active for this reporting period. Review its effective dates and activate the correct filing configuration.");
    }
  }
  const snapshot = (await client.query<{ checked_at: string; fingerprint: string }>(
    `SELECT statement_timestamp()::text AS checked_at,
       md5(coalesce(string_agg(entry.id::text || ':' || entry.content_hash, ',' ORDER BY entry.id),'')) AS fingerprint
     FROM journal_entries entry WHERE entry.organization_id=$1 AND entry.legal_entity_id=$2
       AND entry.ledger_id=$3 AND entry.status='POSTED'
       AND entry.accounting_date BETWEEN $4::date AND $5::date`,
    [organizationId, input.legalEntityId, input.ledgerId, input.periodStart, input.periodEnd],
  )).rows[0]!;
  const accounts = scope?.has_book_income ? (await client.query<{
    id: string; code: string; name: string; account_class: string; debits: string; credits: string; net_income: string; mapped: boolean;
  }>(
    `WITH activity AS (
       SELECT combination.account_id, sum(line.debit_functional) AS debits, sum(line.credit_functional) AS credits
       FROM journal_entries entry
       JOIN journal_lines line ON line.organization_id=$1 AND line.journal_entry_id=entry.id
       JOIN account_combinations combination ON combination.organization_id=$1 AND combination.id=line.account_combination_id
       WHERE entry.organization_id=$1 AND entry.legal_entity_id=$2 AND entry.ledger_id=$3
         AND entry.status='POSTED' AND entry.accounting_date BETWEEN $4::date AND $5::date
       GROUP BY combination.account_id
     ) SELECT account.id,account.code,account.display_name AS name,account.class::text AS account_class,
       coalesce(activity.debits,0)::text AS debits,coalesce(activity.credits,0)::text AS credits,
       (coalesce(activity.credits,0)-coalesce(activity.debits,0))::text AS net_income,
       EXISTS (SELECT 1 FROM tax_account_mapping_lines mapping
         WHERE mapping.organization_id=$1 AND mapping.mapping_set_id=$6
           AND mapping.field_key='wp_book_net_income' AND mapping.gl_account_id=account.id) AS mapped
     FROM gl_accounts account LEFT JOIN activity ON activity.account_id=account.id
     WHERE account.organization_id=$1 AND account.ledger_id=$3 AND account.class IN ('REVENUE','EXPENSE')
       AND ((account.active AND account.postable) OR activity.account_id IS NOT NULL)
     ORDER BY account.code,account.id`,
    [organizationId, input.legalEntityId, input.ledgerId, input.periodStart, input.periodEnd, configuration?.mapping_set_id ?? null],
  )).rows : [];
  const unmappedAccounts = accounts.filter((account) => !account.mapped).map((account) => ({
    id: account.id, code: account.code, name: account.name, accountClass: account.account_class,
    debits: account.debits, credits: account.credits, netIncome: account.net_income,
    hasActivity: !exact(account.debits).isZero() || !exact(account.credits).isZero(),
  }));
  const coverage: TaxMappingCoverage = {
    required: scope?.has_book_income ?? false,
    currentBookNetIncome: accounts.reduce((sum, account) => sum.plus(account.net_income), exact(0)).toFixed(9),
    omittedNetIncome: unmappedAccounts.reduce((sum, account) => sum.plus(account.netIncome), exact(0)).toFixed(9),
    unmappedAccounts,
  };
  if (configuration && unmappedAccounts.some((account) => account.hasActivity)) {
    block("MAPPING_COVERAGE_INCOMPLETE", `Book net income omits posted activity from ${unmappedAccounts.filter((account) => account.hasActivity).map((account) => account.code).join(', ')} (net income effect ${coverage.omittedNetIncome}). Add these accounts to wp_book_net_income and activate the reviewed configuration before reconciliation. Do not replace missing ledger expenses with manual tax adjustments.`, "tax-mappings");
  }
  return {
    ready: blockers.length === 0, checkedAt: snapshot.checked_at, ledgerFingerprint: snapshot.fingerprint,
    configuration: configuration ? { id: configuration.id, version: configuration.version, templateId: configuration.template_id,
      mappingSetId: configuration.mapping_set_id, mappingVersion: configuration.mapping_version } : null,
    blockers, coverage,
  };
}
