import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TenantTransactionContext } from "@/db/transaction";
import {
  actorHasActivePermission,
  assertActorHasActivePermission,
} from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import { principalCanWrite } from "@/modules/workspace/write-policy";
import {
  taxFilingTemplateDefinitionSchema,
  type TaxFieldReconciliation,
  type TaxFilingTemplateDefinition,
  type TaxFilingValidationResult,
  type TaxMappingBalanceBasis,
} from "./filing-template";

export type TaxFilingTemplateDto = Readonly<{
  id: string;
  templateKey: string;
  version: number;
  name: string;
  authority: string;
  jurisdiction: string;
  formCode: string;
  currencyCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceUri: string;
  definition: TaxFilingTemplateDefinition;
}>;

export type TaxLedgerDto = Readonly<{
  legalEntityId: string;
  entityCode: string;
  entityName: string;
  countryCode: string;
  ledgerId: string;
  ledgerCode: string;
  currencyCode: string;
}>;

export type TaxAccountDto = Readonly<{
  id: string;
  ledgerId: string;
  code: string;
  displayName: string;
  accountClass: string;
}>;

export type TaxAccountMappingDto = Readonly<{
  mappingSetId: string;
  mappingVersion: number;
  legalEntityId: string;
  ledgerId: string;
  templateId: string;
  fieldKey: string;
  glAccountId: string;
  accountCode: string;
  accountName: string;
  balanceBasis: TaxMappingBalanceBasis;
  multiplier: string;
  reason: string;
  createdAt: string;
}>;

export type TaxFilingSummaryDto = Readonly<{
  id: string;
  legalEntityId: string;
  entityCode: string;
  ledgerCode: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  filingType: "PREPARED" | "HISTORICAL_IMPORT";
  status: "READY" | "MATCHED" | "REVIEW_REQUIRED";
  periodStart: string;
  periodEnd: string;
  externalReference: string | null;
  sourceFileName: string | null;
  reconciliation: readonly TaxFieldReconciliation[];
  validations: readonly TaxFilingValidationResult[];
  createdAt: string;
}>;

export type TaxFilingWorkspaceDto = Readonly<{
  templates: readonly TaxFilingTemplateDto[];
  ledgers: readonly TaxLedgerDto[];
  accounts: readonly TaxAccountDto[];
  mappings: readonly TaxAccountMappingDto[];
  filings: readonly TaxFilingSummaryDto[];
  canManageMappings: boolean;
  canPrepareFilings: boolean;
}>;

const reconciliationArraySchema = z.array(z.object({
  fieldKey: z.string(),
  code: z.string(),
  label: z.string(),
  calculatedValue: z.string(),
  reportedValue: z.string().nullable(),
  difference: z.string().nullable(),
  status: z.enum(["MATCHED", "VARIANCE", "NOT_REPORTED"]),
  source: z.enum(["MAPPED_ACCOUNTS", "MANUAL_INPUT", "FORMULA"]),
}).strict());

const validationArraySchema = z.array(z.object({
  ruleKey: z.string(),
  label: z.string(),
  description: z.string(),
  severity: z.enum(["WARNING", "ERROR"]),
  status: z.enum(["PASS", "FAIL", "SKIPPED"]),
  actual: z.string().nullable(),
  expected: z.string(),
  source: z.string(),
}).strict());

function readContext(principal: SessionPrincipal): TenantTransactionContext {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `tax-filing-workspace:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI",
  };
}

export async function loadTaxFilingWorkspace(
  principal: SessionPrincipal,
): Promise<TaxFilingWorkspaceDto> {
  return withWorkspaceTenantRead(readContext(principal), "/app/tax", async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readTax,
    });
    const writable = principalCanWrite(principal);
    const [canManageMappings, canPrepareFilings] = writable
      ? await Promise.all([
          actorHasActivePermission(client, {
            organizationId: principal.organizationId,
            actorId: principal.userId,
            permission: PERMISSIONS.manageTaxMappings,
          }),
          actorHasActivePermission(client, {
            organizationId: principal.organizationId,
            actorId: principal.userId,
            permission: PERMISSIONS.prepareTaxFilings,
          }),
        ])
      : [false, false];

    const templatesResult = await client.query<{
      id: string;
      template_key: string;
      version: number;
      name: string;
      authority: string;
      jurisdiction: string;
      form_code: string;
      currency_code: string;
      effective_from: string;
      effective_to: string | null;
      source_uri: string;
      definition: unknown;
    }>(
      `SELECT id, template_key, version, name, authority, jurisdiction,
         form_code, currency_code, effective_from::text, effective_to::text,
         source_uri, definition
       FROM tax_filing_templates
       ORDER BY jurisdiction, name, version DESC`,
    );
    const templates = templatesResult.rows.map<TaxFilingTemplateDto>((row) => ({
      id: row.id,
      templateKey: row.template_key,
      version: row.version,
      name: row.name,
      authority: row.authority,
      jurisdiction: row.jurisdiction,
      formCode: row.form_code,
      currencyCode: row.currency_code,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      sourceUri: row.source_uri,
      definition: taxFilingTemplateDefinitionSchema.parse(row.definition),
    }));

    const ledgerResult = await client.query<{
      legal_entity_id: string;
      entity_code: string;
      entity_name: string;
      country_code: string;
      ledger_id: string;
      ledger_code: string;
      currency_code: string;
    }>(
      `SELECT entity.id AS legal_entity_id, entity.code AS entity_code,
         entity.display_name AS entity_name, entity.country_code,
         ledger.id AS ledger_id, ledger.code AS ledger_code,
         ledger.functional_currency AS currency_code
       FROM legal_entities entity
       JOIN ledgers ledger
         ON ledger.organization_id = entity.organization_id
        AND ledger.legal_entity_id = entity.id
        AND ledger.active
       WHERE entity.organization_id = $1
         AND entity.active
       ORDER BY entity.code, ledger.code`,
      [principal.organizationId],
    );
    const ledgers = ledgerResult.rows.map<TaxLedgerDto>((row) => ({
      legalEntityId: row.legal_entity_id,
      entityCode: row.entity_code,
      entityName: row.entity_name,
      countryCode: row.country_code,
      ledgerId: row.ledger_id,
      ledgerCode: row.ledger_code,
      currencyCode: row.currency_code,
    }));

    const accountResult = await client.query<{
      id: string;
      ledger_id: string;
      code: string;
      display_name: string;
      account_class: string;
    }>(
      `SELECT id, ledger_id, code, display_name, class::text AS account_class
       FROM gl_accounts
       WHERE organization_id = $1
         AND active
         AND postable
         AND control_kind = 'NONE'
       ORDER BY ledger_id, code`,
      [principal.organizationId],
    );
    const accounts = accountResult.rows.map<TaxAccountDto>((row) => ({
      id: row.id,
      ledgerId: row.ledger_id,
      code: row.code,
      displayName: row.display_name,
      accountClass: row.account_class,
    }));

    const mappingResult = await client.query<{
      mapping_set_id: string;
      mapping_version: number;
      legal_entity_id: string;
      ledger_id: string;
      template_id: string;
      field_key: string;
      gl_account_id: string;
      account_code: string;
      account_name: string;
      balance_basis: TaxMappingBalanceBasis;
      multiplier: string;
      reason: string;
      created_at: string;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (ledger_id, template_id)
           id, legal_entity_id, ledger_id, template_id, version, reason, created_at
         FROM tax_account_mapping_sets
         WHERE organization_id = $1
         ORDER BY ledger_id, template_id, version DESC
       )
       SELECT latest.id AS mapping_set_id, latest.version AS mapping_version,
         latest.legal_entity_id, latest.ledger_id, latest.template_id,
         line.field_key, line.gl_account_id, account.code AS account_code,
         account.display_name AS account_name, line.balance_basis,
         line.multiplier::text, latest.reason, latest.created_at::text
       FROM latest
       JOIN tax_account_mapping_lines line
         ON line.organization_id = $1 AND line.mapping_set_id = latest.id
       JOIN gl_accounts account
         ON account.organization_id = line.organization_id
        AND account.id = line.gl_account_id
       ORDER BY latest.ledger_id, latest.template_id, line.field_key, account.code`,
      [principal.organizationId],
    );
    const mappings = mappingResult.rows.map<TaxAccountMappingDto>((row) => ({
      mappingSetId: row.mapping_set_id,
      mappingVersion: row.mapping_version,
      legalEntityId: row.legal_entity_id,
      ledgerId: row.ledger_id,
      templateId: row.template_id,
      fieldKey: row.field_key,
      glAccountId: row.gl_account_id,
      accountCode: row.account_code,
      accountName: row.account_name,
      balanceBasis: row.balance_basis,
      multiplier: row.multiplier,
      reason: row.reason,
      createdAt: row.created_at,
    }));

    const filingResult = await client.query<{
      id: string;
      legal_entity_id: string;
      entity_code: string;
      ledger_code: string;
      template_id: string;
      template_name: string;
      template_version: number;
      filing_type: "PREPARED" | "HISTORICAL_IMPORT";
      status: "READY" | "MATCHED" | "REVIEW_REQUIRED";
      period_start: string;
      period_end: string;
      external_reference: string | null;
      source_file_name: string | null;
      reconciliation_snapshot: unknown;
      validation_snapshot: unknown;
      created_at: string;
    }>(
      `SELECT filing.id, filing.legal_entity_id, entity.code AS entity_code,
         ledger.code AS ledger_code, filing.template_id,
         template.name AS template_name, template.version AS template_version,
         filing.filing_type, filing.status, filing.period_start::text,
         filing.period_end::text, filing.external_reference,
         filing.source_file_name, filing.reconciliation_snapshot,
         filing.validation_snapshot, filing.created_at::text
       FROM tax_filings filing
       JOIN legal_entities entity
         ON entity.organization_id = filing.organization_id
        AND entity.id = filing.legal_entity_id
       JOIN ledgers ledger
         ON ledger.organization_id = filing.organization_id
        AND ledger.id = filing.ledger_id
       JOIN tax_filing_templates template ON template.id = filing.template_id
       WHERE filing.organization_id = $1
       ORDER BY filing.created_at DESC, filing.id DESC
       LIMIT 50`,
      [principal.organizationId],
    );
    const filings = filingResult.rows.map<TaxFilingSummaryDto>((row) => ({
      id: row.id,
      legalEntityId: row.legal_entity_id,
      entityCode: row.entity_code,
      ledgerCode: row.ledger_code,
      templateId: row.template_id,
      templateName: row.template_name,
      templateVersion: row.template_version,
      filingType: row.filing_type,
      status: row.status,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      externalReference: row.external_reference,
      sourceFileName: row.source_file_name,
      reconciliation: reconciliationArraySchema.parse(row.reconciliation_snapshot),
      validations: validationArraySchema.parse(row.validation_snapshot),
      createdAt: row.created_at,
    }));

    return {
      templates,
      ledgers,
      accounts,
      mappings,
      filings,
      canManageMappings,
      canPrepareFilings,
    };
  });
}
