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
import { saveTaxAccountMappingsSchema } from "./filing-service";

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

export type TaxAccountMappingVersionDto = Readonly<{
  mappingSetId: string;
  ledgerId: string;
  templateId: string;
  mappingVersion: number;
  state: "ACTIVE" | "INACTIVE";
  effectiveFrom: string;
}>;

export type TaxFilingRegistrationDto = Readonly<{
  id: string;
  legalEntityId: string;
  regimeKey: string;
  validFrom: string;
  validTo: string | null;
}>;

export type TaxFilingConfigurationDto = Readonly<{
  id: string;
  legalEntityId: string;
  ledgerId: string;
  registrationId: string | null;
  filingTypeKey: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  mappingSetId: string;
  mappingVersion: number;
  version: number;
  state: "ACTIVE" | "INACTIVE" | "NEEDS_CONFIGURATION";
  effectiveFrom: string;
  effectiveTo: string | null;
  supersedesConfigurationId: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  current: boolean;
  dependencyCount: number;
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
  configurationId?: string | null;
  configurationVersion?: number | null;
  lifecycleState?: "CURRENT" | "HISTORICAL" | "SUPERSEDED" | "ARCHIVED";
  lifecycleVersion?: number;
  lifecycleReason?: string;
  replacementFilingId?: string | null;
  canonical?: boolean;
  canonicalVersion?: number;
  canonicalReason?: string | null;
  reconciliation: readonly TaxFieldReconciliation[];
  validations: readonly TaxFilingValidationResult[];
  createdAt: string;
}>;

export type TaxFilingWorkspaceDto = Readonly<{
  templates: readonly TaxFilingTemplateDto[];
  ledgers: readonly TaxLedgerDto[];
  accounts: readonly TaxAccountDto[];
  mappings: readonly TaxAccountMappingDto[];
  mappingVersions: readonly TaxAccountMappingVersionDto[];
  registrations?: readonly TaxFilingRegistrationDto[];
  configurations?: readonly TaxFilingConfigurationDto[];
  filings: readonly TaxFilingSummaryDto[];
  canManageMappings: boolean;
  canPrepareFilings: boolean;
  canManageConfigurations?: boolean;
  canManageCanonical?: boolean;
}>;

type TaxFilingSummaryRow = Readonly<{
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
  configuration_id: string | null;
  configuration_version: number | null;
  lifecycle_state: "CURRENT" | "HISTORICAL" | "SUPERSEDED" | "ARCHIVED";
  lifecycle_version: number;
  lifecycle_reason: string;
  replacement_filing_id: string | null;
  canonical: boolean;
  canonical_version: number;
  canonical_reason: string | null;
  reconciliation_snapshot: unknown;
  validation_snapshot: unknown;
  created_at: string;
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
  options: Readonly<{ includeFilings?: boolean }> = {},
): Promise<TaxFilingWorkspaceDto> {
  return withWorkspaceTenantRead(readContext(principal), "/app/tax", async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readTax,
    });
    const writable = principalCanWrite(principal);
    const [canManageMappings, canPrepareFilings, canManageConfigurations, canManageCanonical] = writable
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
          actorHasActivePermission(client, {
            organizationId: principal.organizationId,
            actorId: principal.userId,
            permission: PERMISSIONS.manageTaxFilingConfiguration,
          }),
          actorHasActivePermission(client, {
            organizationId: principal.organizationId,
            actorId: principal.userId,
            permission: PERMISSIONS.manageTaxFilingCanonical,
          }),
        ])
      : [false, false, false, false];

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
         WHERE organization_id = $1 AND state = 'ACTIVE'
           AND NOT EXISTS (SELECT 1 FROM tax_account_mapping_sets successor
             WHERE successor.organization_id=tax_account_mapping_sets.organization_id
               AND successor.supersedes_mapping_set_id=tax_account_mapping_sets.id)
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
    const mappingVersionResult = await client.query<{
      mapping_set_id: string; ledger_id: string; template_id: string;
      mapping_version: number; state: "ACTIVE" | "INACTIVE"; effective_from: string;
    }>(
      `SELECT mapping.id AS mapping_set_id, mapping.ledger_id, mapping.template_id,
         mapping.version AS mapping_version, mapping.state, mapping.effective_from::text
       FROM tax_account_mapping_sets mapping
       WHERE mapping.organization_id=$1
         AND NOT EXISTS (SELECT 1 FROM tax_account_mapping_sets successor
           WHERE successor.organization_id=mapping.organization_id
             AND successor.supersedes_mapping_set_id=mapping.id)
       ORDER BY mapping.ledger_id, mapping.template_id`,
      [principal.organizationId],
    );
    const mappingVersions = mappingVersionResult.rows.map<TaxAccountMappingVersionDto>((row) => ({
      mappingSetId: row.mapping_set_id,
      ledgerId: row.ledger_id,
      templateId: row.template_id,
      mappingVersion: row.mapping_version,
      state: row.state,
      effectiveFrom: row.effective_from,
    }));

    const registrationRows = (await client.query<{
      id: string; legal_entity_id: string; regime_key: string; valid_from: string; valid_to: string | null;
    }>(
      `SELECT id,legal_entity_id,regime_key,valid_from::text,valid_to::text
       FROM entity_tax_registrations WHERE organization_id=$1
       ORDER BY legal_entity_id,regime_key,valid_from,id`,
      [principal.organizationId],
    )).rows;
    const registrations = registrationRows.map<TaxFilingRegistrationDto>((row) => ({
      id: row.id,
      legalEntityId: row.legal_entity_id,
      regimeKey: row.regime_key,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    }));

    const configurationRows = (await client.query<{
      id: string; legal_entity_id: string; ledger_id: string; registration_id: string | null;
      filing_type_key: string; template_id: string; template_name: string; template_version: number;
      mapping_set_id: string; mapping_version: number; version: number;
      state: "ACTIVE" | "INACTIVE" | "NEEDS_CONFIGURATION"; effective_from: string;
      effective_to: string | null; supersedes_configuration_id: string | null;
      reason: string; created_by: string; created_at: string; current: boolean; dependency_count: number;
    }>(
      `SELECT configuration.id,configuration.legal_entity_id,configuration.ledger_id,
         configuration.registration_id,configuration.filing_type_key,configuration.template_id,
         template.name AS template_name,template.version AS template_version,
         configuration.mapping_set_id,mapping.version AS mapping_version,configuration.version,
         configuration.state,configuration.effective_from::text,configuration.effective_to::text,
         configuration.supersedes_configuration_id,configuration.reason,configuration.created_by,
         configuration.created_at::text,
         NOT EXISTS (SELECT 1 FROM tax_filing_configurations successor
           WHERE successor.organization_id=configuration.organization_id
             AND successor.supersedes_configuration_id=configuration.id) AS current,
         (SELECT count(*)::int FROM tax_filings filing
           WHERE filing.organization_id=configuration.organization_id
             AND filing.configuration_id=configuration.id) AS dependency_count
       FROM tax_filing_configurations configuration
       JOIN tax_filing_templates template ON template.id=configuration.template_id
       JOIN tax_account_mapping_sets mapping
         ON mapping.organization_id=configuration.organization_id AND mapping.id=configuration.mapping_set_id
       WHERE configuration.organization_id=$1
       ORDER BY configuration.legal_entity_id,configuration.filing_type_key,configuration.version DESC`,
      [principal.organizationId],
    )).rows;
    const configurations = configurationRows.map<TaxFilingConfigurationDto>((row) => ({
      id: row.id, legalEntityId: row.legal_entity_id, ledgerId: row.ledger_id,
      registrationId: row.registration_id, filingTypeKey: row.filing_type_key,
      templateId: row.template_id, templateName: row.template_name, templateVersion: row.template_version,
      mappingSetId: row.mapping_set_id, mappingVersion: row.mapping_version, version: row.version,
      state: row.state, effectiveFrom: row.effective_from, effectiveTo: row.effective_to,
      supersedesConfigurationId: row.supersedes_configuration_id,
      reason: row.reason, createdBy: row.created_by, createdAt: row.created_at, current: row.current,
      dependencyCount: row.dependency_count,
    }));

    const filingRows = options.includeFilings === false
      ? []
      : (await client.query<TaxFilingSummaryRow>(
        `SELECT filing.id, filing.legal_entity_id, entity.code AS entity_code,
         ledger.code AS ledger_code, filing.template_id,
         template.name AS template_name, template.version AS template_version,
         filing.filing_type, filing.status, filing.period_start::text,
         filing.period_end::text, filing.external_reference,
         filing.source_file_name, filing.configuration_id, filing.configuration_version,
         lifecycle.state AS lifecycle_state,lifecycle.version AS lifecycle_version,
         lifecycle.reason AS lifecycle_reason,lifecycle.replacement_filing_id,
         (canonical.filing_id=filing.id AND canonical.state='ACTIVE') AS canonical,
         coalesce(canonical.version,0)::int AS canonical_version,
         canonical.reason AS canonical_reason,
         filing.reconciliation_snapshot, filing.validation_snapshot, filing.created_at::text
       FROM tax_filings filing
       JOIN legal_entities entity
         ON entity.organization_id = filing.organization_id
        AND entity.id = filing.legal_entity_id
       JOIN ledgers ledger
         ON ledger.organization_id = filing.organization_id
        AND ledger.id = filing.ledger_id
       JOIN tax_filing_templates template ON template.id = filing.template_id
       JOIN LATERAL (
         SELECT event.state,event.version,event.reason,event.replacement_filing_id
         FROM tax_filing_lifecycle_events event
         WHERE event.organization_id=filing.organization_id AND event.filing_id=filing.id
           AND NOT EXISTS (SELECT 1 FROM tax_filing_lifecycle_events successor
             WHERE successor.organization_id=event.organization_id AND successor.supersedes_event_id=event.id)
         ORDER BY event.version DESC LIMIT 1
       ) lifecycle ON true
       LEFT JOIN LATERAL (
         SELECT selection.filing_id,selection.state,selection.version,selection.reason
         FROM tax_filing_canonical_selections selection
         JOIN tax_filing_configurations configuration
           ON configuration.organization_id=filing.organization_id AND configuration.id=filing.configuration_id
         WHERE selection.organization_id=filing.organization_id
           AND selection.legal_entity_id=filing.legal_entity_id
           AND selection.registration_id IS NOT DISTINCT FROM configuration.registration_id
           AND selection.filing_type_key=configuration.filing_type_key
           AND selection.period_start=filing.period_start AND selection.period_end=filing.period_end
           AND NOT EXISTS (SELECT 1 FROM tax_filing_canonical_selections successor
             WHERE successor.organization_id=selection.organization_id AND successor.supersedes_selection_id=selection.id)
         ORDER BY selection.version DESC LIMIT 1
       ) canonical ON true
       WHERE filing.organization_id = $1
       ORDER BY filing.created_at DESC, filing.id DESC
       LIMIT 50`,
        [principal.organizationId],
      )).rows;
    const filings = filingRows.map<TaxFilingSummaryDto>((row) => ({
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
      configurationId: row.configuration_id,
      configurationVersion: row.configuration_version,
      lifecycleState: row.lifecycle_state,
      lifecycleVersion: row.lifecycle_version,
      lifecycleReason: row.lifecycle_reason,
      replacementFilingId: row.replacement_filing_id,
      canonical: row.canonical,
      canonicalVersion: row.canonical_version,
      canonicalReason: row.canonical_reason,
      reconciliation: reconciliationArraySchema.parse(row.reconciliation_snapshot),
      validations: validationArraySchema.parse(row.validation_snapshot),
      createdAt: row.created_at,
    }));

    return {
      templates,
      ledgers,
      accounts,
      mappings,
      mappingVersions,
      registrations,
      configurations,
      filings,
      canManageMappings,
      canPrepareFilings,
      canManageConfigurations,
      canManageCanonical,
    };
  });
}

export async function previewTaxAccountMappings(
  principal: SessionPrincipal,
  raw: z.input<typeof saveTaxAccountMappingsSchema>,
) {
  const command = saveTaxAccountMappingsSchema.parse(raw);
  const workspace = await loadTaxFilingWorkspace(principal, { includeFilings: false });
  const template = workspace.templates.find((candidate) => candidate.id === command.templateId);
  const ledger = workspace.ledgers.find((candidate) => candidate.ledgerId === command.ledgerId && candidate.legalEntityId === command.legalEntityId);
  if (!template || template.version !== command.expectedTemplateVersion) throw new Error("The reviewed template version is unavailable or stale");
  if (!ledger || ledger.currencyCode !== template.currencyCode) throw new Error("Choose an exact active company ledger in the template currency");
  const currentVersion = workspace.mappingVersions.find((mapping) => mapping.ledgerId === command.ledgerId && mapping.templateId === command.templateId)?.mappingVersion ?? 0;
  if (currentVersion !== command.expectedMappingVersion) throw new Error("The mapping version is stale");
  const fields = new Map(template.definition.fields.map((field) => [field.key, field]));
  const accounts = new Map(workspace.accounts.filter((account) => account.ledgerId === command.ledgerId).map((account) => [account.id, account]));
  if (command.mappings.some((mapping) => !fields.get(mapping.fieldKey)?.allowAccountMapping || !accounts.has(mapping.glAccountId))) {
    throw new Error("A mapping field or account is outside the reviewed template and ledger");
  }
  const identities = new Set(command.mappings.map((mapping) => `${mapping.fieldKey}|${mapping.glAccountId}`));
  if (identities.size !== command.mappings.length) throw new Error("Each account can be mapped to a template field only once");
  const required = template.definition.fields.filter((field) => field.kind === "ACCOUNT" && field.required);
  if (required.some((field) => !command.mappings.some((mapping) => mapping.fieldKey === field.key))) throw new Error("Map every required account-backed field");
  if (template.templateKey === "ca.gst-hst.return") {
    const registrationAvailable = await withWorkspaceTenantRead(readContext(principal), "/app/tax", async (client) => {
      await assertActorHasActivePermission(client, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.manageTaxMappings,
      });
      return Boolean((await client.query(
        `SELECT 1 FROM entity_tax_registrations registration
         WHERE registration.organization_id=$1
           AND registration.legal_entity_id=$2
           AND registration.regime_key LIKE 'ca.%.hst'
           AND registration.valid_from <= $3::date
           AND (registration.valid_to IS NULL OR registration.valid_to >= $3::date)
         LIMIT 1`,
        [principal.organizationId, command.legalEntityId, command.effectiveFrom],
      )).rows[0]);
    });
    if (!registrationAvailable) throw new Error("An effective Canadian HST registration is required for this mapping date");
  }
  return { valid: true, writesPerformed: false, template, ledger, currentMappingVersion: currentVersion, normalizedMappings: [...command.mappings].sort((a, b) => `${a.fieldKey}|${a.glAccountId}`.localeCompare(`${b.fieldKey}|${b.glAccountId}`)) };
}

export async function loadTaxAccountMappingHistory(
  principal: SessionPrincipal,
  filter: Readonly<{ ledgerId?: string; templateId?: string }> = {},
) {
  return withWorkspaceTenantRead(readContext(principal), "/app/tax", async (client) => {
    await assertActorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.readTax });
    const result = await client.query(
      `SELECT mapping.id, mapping.legal_entity_id AS "legalEntityId", mapping.ledger_id AS "ledgerId",
         mapping.template_id AS "templateId", mapping.version, mapping.state,
         mapping.effective_from::text AS "effectiveFrom", mapping.effective_to::text AS "effectiveTo",
         mapping.supersedes_mapping_set_id AS "supersedesMappingSetId", mapping.reason,
         mapping.created_by AS "createdBy", mapping.created_at::text AS "createdAt",
         NOT EXISTS (SELECT 1 FROM tax_account_mapping_sets successor
           WHERE successor.organization_id=mapping.organization_id AND successor.supersedes_mapping_set_id=mapping.id) AS current,
         coalesce(jsonb_agg(jsonb_build_object(
           'fieldKey', line.field_key, 'glAccountId', line.gl_account_id,
           'balanceBasis', line.balance_basis, 'multiplier', line.multiplier::text
         ) ORDER BY line.field_key, line.gl_account_id) FILTER (WHERE line.id IS NOT NULL), '[]'::jsonb) AS lines
       FROM tax_account_mapping_sets mapping
       LEFT JOIN tax_account_mapping_lines line ON line.organization_id=mapping.organization_id AND line.mapping_set_id=mapping.id
       WHERE mapping.organization_id=$1
         AND ($2::uuid IS NULL OR mapping.ledger_id=$2)
         AND ($3::uuid IS NULL OR mapping.template_id=$3)
       GROUP BY mapping.id
       ORDER BY mapping.ledger_id, mapping.template_id, mapping.version`,
      [principal.organizationId, filter.ledgerId ?? null, filter.templateId ?? null],
    );
    return { versions: result.rows };
  });
}

export async function previewTaxFilingConfigurationDependencies(
  principal: SessionPrincipal,
  configurationId: string,
) {
  const parsedId = z.uuid().parse(configurationId);
  return withWorkspaceTenantRead(readContext(principal), "/app/tax", async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.readTax,
    });
    const result = await client.query<{
      id: string; version: number; state: string; template_id: string; mapping_set_id: string;
      registration_id: string | null; workpaper_count: number; canonical_count: number;
      replacement_count: number;
    }>(
      `SELECT configuration.id,configuration.version,configuration.state,
         configuration.template_id,configuration.mapping_set_id,configuration.registration_id,
         (SELECT count(*)::int FROM tax_filings filing
           WHERE filing.organization_id=configuration.organization_id
             AND filing.configuration_id=configuration.id) AS workpaper_count,
         (SELECT count(*)::int FROM tax_filing_canonical_selections selection
           JOIN tax_filings filing ON filing.organization_id=selection.organization_id
             AND filing.id=selection.filing_id
           WHERE selection.organization_id=configuration.organization_id
             AND filing.configuration_id=configuration.id
             AND selection.state='ACTIVE'
             AND NOT EXISTS (SELECT 1 FROM tax_filing_canonical_selections successor
               WHERE successor.organization_id=selection.organization_id
                 AND successor.supersedes_selection_id=selection.id)) AS canonical_count,
         (SELECT count(*)::int FROM tax_filing_configurations successor
           WHERE successor.organization_id=configuration.organization_id
             AND successor.supersedes_configuration_id=configuration.id) AS replacement_count
       FROM tax_filing_configurations configuration
       WHERE configuration.organization_id=$1 AND configuration.id=$2`,
      [principal.organizationId, parsedId],
    );
    const selected = result.rows[0];
    if (!selected) throw new Error("The filing configuration was not found");
    return {
      configurationId: selected.id,
      configurationVersion: selected.version,
      state: selected.state,
      templateId: selected.template_id,
      mappingSetId: selected.mapping_set_id,
      registrationId: selected.registration_id,
      dependencies: {
        workpapers: selected.workpaper_count,
        currentCanonicalSelections: selected.canonical_count,
        successorRevisions: selected.replacement_count,
      },
      hardDeleteAllowed: false,
      writesPerformed: false,
      consequence: "Configuration changes append a prospective revision; referenced templates, mappings, registrations, configurations, and workpapers remain immutable.",
    };
  });
}
