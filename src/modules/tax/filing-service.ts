import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction } from "@/db/transaction";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import { exact } from "@/kernel/money";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import type { SessionPrincipal } from "@/modules/identity/session";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
  mutationContext,
  principalCanWrite,
} from "@/modules/workspace/write-policy";
import {
  evaluateTaxFilingTemplate,
  taxFilingTemplateDefinitionSchema,
} from "./filing-template";

const decimalSchema = z.string().trim().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/).refine((value) => {
  try {
    return exact(value).abs().lessThanOrEqualTo("99999999999999999999999999999");
  } catch {
    return false;
  }
});
const fieldKeySchema = z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/);
const idempotencyKeySchema = z.string().trim().min(1).max(180);
const valueRecordSchema = z.record(fieldKeySchema, decimalSchema).superRefine((value, context) => {
  if (Object.keys(value).length > 200) {
    context.addIssue({ code: "custom", message: "A filing cannot contain more than 200 field values" });
  }
});

export const saveTaxAccountMappingsSchema = z.object({
  legalEntityId: z.uuid(),
  ledgerId: z.uuid(),
  templateId: z.uuid(),
  expectedTemplateVersion: z.number().int().min(1),
  expectedMappingVersion: z.number().int().min(0),
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().optional(),
  mappings: z.array(z.object({
    fieldKey: fieldKeySchema,
    glAccountId: z.uuid(),
    balanceBasis: z.enum(["DEBITS", "CREDITS", "NET_DEBIT", "NET_CREDIT", "ABSOLUTE_NET"]),
    multiplier: decimalSchema.refine((value) => !exact(value).isZero() && exact(value).abs().lessThanOrEqualTo(1000)),
  }).strict()).min(1).max(500),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
    context.addIssue({ code: "custom", path: ["effectiveTo"], message: "The mapping effective end cannot precede its start" });
  }
});

export const deactivateTaxAccountMappingsSchema = z.object({
  mappingSetId: z.uuid(),
  expectedMappingVersion: z.number().int().min(1),
  effectiveFrom: z.iso.date(),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const createTaxFilingSchema = z.object({
  legalEntityId: z.uuid(),
  ledgerId: z.uuid(),
  templateId: z.uuid(),
  configurationId: z.uuid().optional(),
  filingType: z.enum(["PREPARED", "HISTORICAL_IMPORT"]),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  externalReference: z.string().trim().min(1).max(200).optional(),
  sourceFileName: z.string().trim().min(1).max(255).optional(),
  manualValues: valueRecordSchema.default({}),
  reportedValues: valueRecordSchema.default({}),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (value.periodEnd < value.periodStart) {
    context.addIssue({ code: "custom", message: "The filing period end cannot precede its start", path: ["periodEnd"] });
  }
  if (value.filingType === "HISTORICAL_IMPORT") {
    if (!value.externalReference) {
      context.addIssue({ code: "custom", message: "Historical filings need an external reference", path: ["externalReference"] });
    }
    if (Object.keys(value.reportedValues).length === 0) {
      context.addIssue({ code: "custom", message: "Historical filings need at least one reported field", path: ["reportedValues"] });
    }
  }
}).transform((value) => ({
  ...value,
  externalReference: value.externalReference || undefined,
  sourceFileName: value.sourceFileName || undefined,
}));

export const saveTaxFilingConfigurationSchema = z.object({
  legalEntityId: z.uuid(),
  ledgerId: z.uuid(),
  registrationId: z.uuid().nullable().default(null),
  filingTypeKey: z.string().trim().regex(/^[a-z][a-z0-9.-]{2,99}$/),
  templateId: z.uuid(),
  mappingSetId: z.uuid(),
  expectedConfigurationVersion: z.number().int().min(0),
  state: z.enum(["ACTIVE", "INACTIVE", "NEEDS_CONFIGURATION"]).default("ACTIVE"),
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().nullable().optional(),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
    context.addIssue({ code: "custom", path: ["effectiveTo"], message: "The configuration effective end cannot precede its start" });
  }
});

export const setTaxFilingCanonicalSchema = z.object({
  filingId: z.uuid(),
  expectedSelectionVersion: z.number().int().min(0),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const transitionTaxFilingLifecycleSchema = z.object({
  filingId: z.uuid(),
  expectedLifecycleVersion: z.number().int().positive(),
  state: z.enum(["SUPERSEDED", "ARCHIVED"]),
  replacementFilingId: z.uuid().optional(),
  reason: z.string().trim().min(8).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export type SaveTaxAccountMappingsInput = z.input<typeof saveTaxAccountMappingsSchema>;
export type DeactivateTaxAccountMappingsInput = z.input<typeof deactivateTaxAccountMappingsSchema>;
export type CreateTaxFilingInput = z.input<typeof createTaxFilingSchema>;
export type SaveTaxFilingConfigurationInput = z.input<typeof saveTaxFilingConfigurationSchema>;
export type SetTaxFilingCanonicalInput = z.input<typeof setTaxFilingCanonicalSchema>;
export type TransitionTaxFilingLifecycleInput = z.input<typeof transitionTaxFilingLifecycleSchema>;

export class TaxFilingError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
  ) {
    super(message);
    this.name = "TaxFilingError";
  }
}

function assertWritableTaxSession(principal: SessionPrincipal): void {
  if (!principalCanWrite(principal)) {
    throw new TaxFilingError("A writable organization session is required.", 403, "WRITES_DISABLED");
  }
}

async function withAuthorizedTaxWrite<T>(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  permission: Permission;
  reason: string;
  sourceSurface?: "API" | "IMPORT" | "MCP";
}>, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const context = mutationContext(input.principal, input.requestId, {
    reason: input.reason,
    sourceSurface: input.sourceSurface ?? "API",
  });
  assertTenantWritesEnabled(context);
  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    await assertActorHasActivePermission(client, {
      organizationId: input.principal.organizationId,
      actorId: input.principal.userId,
      permission: input.permission,
    });
    return work(client);
  });
}

type TemplateRow = Readonly<{
  id: string;
  currency_code: string;
  definition: unknown;
  template_key: string;
  version: number;
  name: string;
  authority: string;
  jurisdiction: string;
  form_code: string;
  effective_from: string;
  effective_to: string | null;
  source_uri: string;
  source_digest: string;
}>;

async function loadTemplate(
  client: PoolClient,
  templateId: string,
  periodEnd?: string,
): Promise<TemplateRow> {
  const result = await client.query<TemplateRow>(
    `SELECT id, currency_code, definition, template_key, version, name,
       authority, jurisdiction, form_code, effective_from::text,
       effective_to::text, source_uri, source_digest
     FROM tax_filing_templates
     WHERE id = $1
       AND ($2::date IS NULL OR effective_from <= $2::date)
       AND ($2::date IS NULL OR effective_to IS NULL OR effective_to >= $2::date)`,
    [templateId, periodEnd ?? null],
  );
  const template = result.rows[0];
  if (!template) {
    throw new TaxFilingError("The tax template is unavailable for this reporting period.", 404, "TEMPLATE_NOT_FOUND");
  }
  taxFilingTemplateDefinitionSchema.parse(template.definition);
  return template;
}

async function assertEntityLedger(
  client: PoolClient,
  organizationId: string,
  legalEntityId: string,
  ledgerId: string,
): Promise<{ currency: string }> {
  const result = await client.query<{ functional_currency: string }>(
    `SELECT ledger.functional_currency
     FROM legal_entities entity
     JOIN ledgers ledger
       ON ledger.organization_id = entity.organization_id
      AND ledger.legal_entity_id = entity.id
     WHERE entity.organization_id = $1
       AND entity.id = $2
       AND ledger.id = $3
       AND entity.active
       AND ledger.active`,
    [organizationId, legalEntityId, ledgerId],
  );
  if (!result.rows[0]) {
    throw new TaxFilingError("Choose an active company ledger in this organization.", 400, "INVALID_LEDGER");
  }
  return { currency: result.rows[0].functional_currency };
}

function normalizedMappings(command: z.output<typeof saveTaxAccountMappingsSchema>) {
  return [...command.mappings].sort((left, right) => (
    `${left.fieldKey}|${left.glAccountId}|${left.balanceBasis}|${left.multiplier}`
      .localeCompare(`${right.fieldKey}|${right.glAccountId}|${right.balanceBasis}|${right.multiplier}`)
  ));
}

export async function saveTaxAccountMappings(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  sourceSurface?: "API" | "MCP";
}> & SaveTaxAccountMappingsInput): Promise<Readonly<{
  mappingSetId: string;
  version: number;
  idempotentReplay: boolean;
}>> {
  assertWritableTaxSession(input.principal);
  const {
    principal: _principal,
    requestId: _requestId,
    sourceSurface: _sourceSurface,
    ...unparsedCommand
  } = input;
  void _principal;
  void _requestId;
  void _sourceSurface;
  const command = saveTaxAccountMappingsSchema.parse(unparsedCommand);
  const mappings = normalizedMappings(command);
  const commandHash = createCommandFingerprint("tax.mapping-set.create", {
    ...command,
    mappings,
    idempotencyKey: undefined,
  });

  return withAuthorizedTaxWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.manageTaxMappings,
    reason: command.reason,
    sourceSurface: input.sourceSurface,
  }, async (client) => {
    const replay = await client.query<{ id: string; version: number; command_hash: string }>(
      `SELECT id, version, command_hash
       FROM tax_account_mapping_sets mapping
       WHERE organization_id = $1 AND idempotency_key = $2`,
      [input.principal.organizationId, command.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].command_hash !== commandHash) {
        throw new TaxFilingError("The mapping idempotency key was already used for another request.", 409, "IDEMPOTENCY_CONFLICT");
      }
      return { mappingSetId: replay.rows[0].id, version: replay.rows[0].version, idempotentReplay: true };
    }

    const [template, ledger] = await Promise.all([
      loadTemplate(client, command.templateId),
      assertEntityLedger(client, input.principal.organizationId, command.legalEntityId, command.ledgerId),
    ]);
    if (template.version !== command.expectedTemplateVersion) {
      throw new TaxFilingError("The filing template version is stale. Reload the reviewed template before saving mappings.", 409, "TEMPLATE_VERSION_CONFLICT");
    }
    if (template.currency_code !== ledger.currency) {
      throw new TaxFilingError(
        `This template reports in ${template.currency_code}; choose a ${template.currency_code} functional-currency ledger.`,
        400,
        "TEMPLATE_CURRENCY_MISMATCH",
      );
    }
    if (template.template_key === "ca.gst-hst.return") {
      const registration = (await client.query(
        `SELECT 1 FROM entity_tax_registrations registration
         WHERE registration.organization_id=$1
           AND registration.legal_entity_id=$2
           AND registration.regime_key LIKE 'ca.%.hst'
           AND registration.valid_from <= $3::date
           AND (registration.valid_to IS NULL OR registration.valid_to >= $3::date)
         LIMIT 1`,
        [input.principal.organizationId, command.legalEntityId, command.effectiveFrom],
      )).rows[0];
      if (!registration) {
        throw new TaxFilingError("An effective Canadian HST registration is required for this mapping date.", 400, "TAX_REGISTRATION_CONTEXT_INVALID");
      }
    }

    const definition = taxFilingTemplateDefinitionSchema.parse(template.definition);
    const mappedFields = new Set(definition.fields.filter((field) => field.allowAccountMapping).map((field) => field.key));
    if (mappings.some((mapping) => !mappedFields.has(mapping.fieldKey))) {
      throw new TaxFilingError("A mapping refers to a field that does not accept ledger accounts.", 400, "INVALID_MAPPING_FIELD");
    }
    const identities = new Set(mappings.map((mapping) => `${mapping.fieldKey}|${mapping.glAccountId}`));
    if (identities.size !== mappings.length) {
      throw new TaxFilingError("Each account can be mapped to a template field only once.", 400, "DUPLICATE_MAPPING");
    }
    const requiredFields = definition.fields.filter((field) => field.kind === "ACCOUNT" && field.required);
    if (requiredFields.some((field) => !mappings.some((mapping) => mapping.fieldKey === field.key))) {
      throw new TaxFilingError("Map every required account-backed tax field before saving.", 400, "INCOMPLETE_MAPPING");
    }

    const accounts = await client.query<{ id: string }>(
      `SELECT id
       FROM gl_accounts
       WHERE organization_id = $1
         AND ledger_id = $2
         AND id = ANY($3::uuid[])
         AND active
         AND postable
         AND control_kind = 'NONE'`,
      [input.principal.organizationId, command.ledgerId, mappings.map((mapping) => mapping.glAccountId)],
    );
    if (accounts.rows.length !== new Set(mappings.map((mapping) => mapping.glAccountId)).size) {
      throw new TaxFilingError("Choose active postable non-control accounts from the selected ledger.", 400, "INVALID_MAPPING_ACCOUNT");
    }

    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('business-finlynq:tax-mapping:' || $1::uuid::text || ':' || $2::uuid::text || ':' || $3::uuid::text, 0)
       )`,
      [input.principal.organizationId, command.ledgerId, command.templateId],
    );
    const currentResult = await client.query<{ id: string; version: number; state: string; effective_from: string }>(
      `SELECT mapping.id, mapping.version, mapping.state, mapping.effective_from::text
       FROM tax_account_mapping_sets mapping
       WHERE mapping.organization_id = $1 AND mapping.ledger_id = $2 AND mapping.template_id = $3
         AND NOT EXISTS (SELECT 1 FROM tax_account_mapping_sets successor
           WHERE successor.organization_id=mapping.organization_id
             AND successor.supersedes_mapping_set_id=mapping.id)
       ORDER BY mapping.version DESC LIMIT 1`,
      [input.principal.organizationId, command.ledgerId, command.templateId],
    );
    const current = currentResult.rows[0];
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== command.expectedMappingVersion) {
      throw new TaxFilingError("The mapping version is stale. Reload and compare the current immutable version.", 409, "MAPPING_VERSION_CONFLICT");
    }
    if (current && command.effectiveFrom <= current.effective_from) {
      throw new TaxFilingError("A mapping revision must become effective after the current version.", 400, "MAPPING_EFFECTIVE_DATE_INVALID");
    }
    const version = currentVersion + 1;
    const mappingSetId = randomUUID();
    await client.query(
      `INSERT INTO tax_account_mapping_sets (
         id, organization_id, legal_entity_id, ledger_id, template_id, version,
         state, effective_from, effective_to, supersedes_mapping_set_id,
         reason, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9,$10,$11,$12,$13)`,
      [
        mappingSetId,
        input.principal.organizationId,
        command.legalEntityId,
        command.ledgerId,
        command.templateId,
        version,
        command.effectiveFrom,
        command.effectiveTo ?? null,
        current?.id ?? null,
        command.reason,
        command.idempotencyKey,
        commandHash,
        input.principal.userId,
      ],
    );
    await client.query(
      `INSERT INTO tax_account_mapping_lines (
         id, organization_id, mapping_set_id, field_key, gl_account_id,
         balance_basis, multiplier
       )
       SELECT gen_random_uuid(), $1, $2, mapping.field_key,
         mapping.gl_account_id, mapping.balance_basis, mapping.multiplier
       FROM jsonb_to_recordset($3::jsonb) AS mapping(
         field_key text, gl_account_id uuid, balance_basis text, multiplier numeric
       )`,
      [
        input.principal.organizationId,
        mappingSetId,
        JSON.stringify(mappings.map((mapping) => ({
          field_key: mapping.fieldKey,
          gl_account_id: mapping.glAccountId,
          balance_basis: mapping.balanceBasis,
          multiplier: mapping.multiplier,
        }))),
      ],
    );
    return { mappingSetId, version, idempotentReplay: false };
  });
}

export async function deactivateTaxAccountMappings(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  sourceSurface?: "API" | "MCP";
}> & DeactivateTaxAccountMappingsInput) {
  assertWritableTaxSession(input.principal);
  const { principal: _principal, requestId: _requestId, sourceSurface: _sourceSurface, ...raw } = input;
  void _principal; void _requestId; void _sourceSurface;
  const command = deactivateTaxAccountMappingsSchema.parse(raw);
  const commandHash = createCommandFingerprint("tax.mapping-set.deactivate", { ...command, idempotencyKey: undefined });
  return withAuthorizedTaxWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.manageTaxMappings,
    reason: command.reason,
    sourceSurface: input.sourceSurface,
  }, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:tax-mapping-version:' || $1::text || ':' || $2::text, 0))",
      [input.principal.organizationId, command.mappingSetId],
    );
    const replay = (await client.query<{ id: string; version: number; command_hash: string }>(
      `SELECT id, version, command_hash FROM tax_account_mapping_sets WHERE organization_id=$1 AND idempotency_key=$2`,
      [input.principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new TaxFilingError("The mapping idempotency key was already used for another request.", 409, "IDEMPOTENCY_CONFLICT");
      return { mappingSetId: replay.id, version: replay.version, state: "INACTIVE" as const, idempotentReplay: true };
    }
    const current = (await client.query<{
      id: string; legal_entity_id: string; ledger_id: string; template_id: string;
      version: number; state: string; effective_from: string;
    }>(
      `SELECT mapping.id, mapping.legal_entity_id, mapping.ledger_id, mapping.template_id,
         mapping.version, mapping.state, mapping.effective_from::text
       FROM tax_account_mapping_sets mapping
       WHERE mapping.organization_id=$1 AND mapping.id=$2
         AND NOT EXISTS (SELECT 1 FROM tax_account_mapping_sets successor
           WHERE successor.organization_id=mapping.organization_id AND successor.supersedes_mapping_set_id=mapping.id)`,
      [input.principal.organizationId, command.mappingSetId],
    )).rows[0];
    if (!current || current.version !== command.expectedMappingVersion || current.state !== "ACTIVE") {
      throw new TaxFilingError("Choose the exact current active mapping version before deactivation.", 409, "MAPPING_VERSION_CONFLICT");
    }
    if (command.effectiveFrom <= current.effective_from) {
      throw new TaxFilingError("A mapping deactivation must become effective after the active version.", 400, "MAPPING_EFFECTIVE_DATE_INVALID");
    }
    const mappingSetId = randomUUID();
    const version = current.version + 1;
    await client.query(
      `INSERT INTO tax_account_mapping_sets(
         id, organization_id, legal_entity_id, ledger_id, template_id, version,
         state, effective_from, effective_to, supersedes_mapping_set_id,
         reason, idempotency_key, command_hash, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,'INACTIVE',$7,NULL,$8,$9,$10,$11,$12)`,
      [mappingSetId, input.principal.organizationId, current.legal_entity_id,
        current.ledger_id, current.template_id, version, command.effectiveFrom,
        current.id, command.reason, command.idempotencyKey, commandHash,
        input.principal.userId],
    );
    return { mappingSetId, version, state: "INACTIVE" as const, idempotentReplay: false };
  });
}

export async function saveTaxFilingConfiguration(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  sourceSurface?: "API" | "MCP";
}> & SaveTaxFilingConfigurationInput): Promise<Readonly<{
  configurationId: string;
  version: number;
  state: "ACTIVE" | "INACTIVE" | "NEEDS_CONFIGURATION";
  idempotentReplay: boolean;
}>> {
  assertWritableTaxSession(input.principal);
  const { principal: _principal, requestId: _requestId, sourceSurface: _sourceSurface, ...raw } = input;
  void _principal; void _requestId; void _sourceSurface;
  const command = saveTaxFilingConfigurationSchema.parse(raw);
  const commandHash = createCommandFingerprint("tax.filing-configuration.save", { ...command, idempotencyKey: undefined });
  return withAuthorizedTaxWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.manageTaxFilingConfiguration,
    reason: command.reason,
    sourceSurface: input.sourceSurface,
  }, async (client) => {
    const replay = (await client.query<{ id: string; version: number; state: "ACTIVE" | "INACTIVE" | "NEEDS_CONFIGURATION"; command_hash: string }>(
      `SELECT id, version, state, command_hash FROM tax_filing_configurations
       WHERE organization_id=$1 AND idempotency_key=$2`,
      [input.principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new TaxFilingError("The configuration idempotency key was already used for another request.", 409, "IDEMPOTENCY_CONFLICT");
      return { configurationId: replay.id, version: replay.version, state: replay.state, idempotentReplay: true };
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:tax-filing-config:' || $1::text || ':' || $2::text || ':' || coalesce($3::text,'none'), 0))",
      [input.principal.organizationId, command.legalEntityId, command.registrationId],
    );
    const [template] = await Promise.all([
      loadTemplate(client, command.templateId, command.effectiveFrom),
      assertEntityLedger(client, input.principal.organizationId, command.legalEntityId, command.ledgerId),
    ]);
    if (template.template_key !== command.filingTypeKey) {
      throw new TaxFilingError("The template does not match the selected filing type.", 400, "CONFIGURATION_TEMPLATE_TYPE_MISMATCH");
    }
    if (template.effective_to && (!command.effectiveTo || command.effectiveTo > template.effective_to)) {
      throw new TaxFilingError("The configuration window extends beyond the selected template version.", 400, "CONFIGURATION_TEMPLATE_WINDOW_INVALID");
    }
    if (template.template_key === "ca.gst-hst.return" && !command.registrationId) {
      throw new TaxFilingError("A GST/HST filing configuration requires an effective entity registration.", 400, "CONFIGURATION_REGISTRATION_REQUIRED");
    }
    const mapping = (await client.query<{ id: string }>(
      `SELECT mapping.id FROM tax_account_mapping_sets mapping
       WHERE mapping.organization_id=$1 AND mapping.id=$2
         AND mapping.legal_entity_id=$3 AND mapping.ledger_id=$4
         AND mapping.template_id=$5 AND mapping.state='ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM tax_account_mapping_sets successor
           WHERE successor.organization_id=mapping.organization_id
             AND successor.supersedes_mapping_set_id=mapping.id)`,
      [input.principal.organizationId, command.mappingSetId, command.legalEntityId, command.ledgerId, command.templateId],
    )).rows[0];
    if (!mapping) throw new TaxFilingError("Choose the exact current active mapping version for this template.", 409, "CONFIGURATION_MAPPING_STALE");
    if (command.registrationId) {
      const registration = (await client.query(
        `SELECT 1 FROM entity_tax_registrations registration
         WHERE registration.organization_id=$1 AND registration.id=$2
           AND registration.legal_entity_id=$3
           AND registration.valid_from <= $4::date
           AND (registration.valid_to IS NULL OR registration.valid_to >= coalesce($5::date,$4::date))`,
        [input.principal.organizationId, command.registrationId, command.legalEntityId,
          command.effectiveFrom, command.effectiveTo ?? null],
      )).rows[0];
      if (!registration) throw new TaxFilingError("The registration is not effective for this entity and configuration date.", 400, "CONFIGURATION_REGISTRATION_INVALID");
    }
    const current = (await client.query<{
      id: string;
      version: number;
      state: string;
      effective_from: string;
      effective_to: string | null;
    }>(
      `SELECT configuration.id, configuration.version, configuration.state,
         configuration.effective_from::text, configuration.effective_to::text
       FROM tax_filing_configurations configuration
       WHERE configuration.organization_id=$1 AND configuration.legal_entity_id=$2
         AND configuration.filing_type_key=$3
         AND configuration.registration_id IS NOT DISTINCT FROM $4::uuid
         AND NOT EXISTS (SELECT 1 FROM tax_filing_configurations successor
           WHERE successor.organization_id=configuration.organization_id
             AND successor.supersedes_configuration_id=configuration.id)
       ORDER BY configuration.version DESC LIMIT 1 FOR UPDATE`,
      [input.principal.organizationId, command.legalEntityId, command.filingTypeKey, command.registrationId],
    )).rows[0];
    if ((current?.version ?? 0) !== command.expectedConfigurationVersion) {
      throw new TaxFilingError("The filing configuration changed. Reload its exact current version.", 409, "CONFIGURATION_VERSION_CONFLICT");
    }
    if (current && command.effectiveFrom < current.effective_from) {
      throw new TaxFilingError("A filing configuration revision cannot become effective before its predecessor.", 400, "CONFIGURATION_EFFECTIVE_DATE_INVALID");
    }
    if (current?.state === "ACTIVE" && current.effective_to && command.state === "ACTIVE"
        && command.effectiveFrom <= current.effective_to) {
      throw new TaxFilingError("Active filing configuration windows cannot overlap.", 400, "CONFIGURATION_EFFECTIVE_DATE_OVERLAP");
    }
    const version = (current?.version ?? 0) + 1;
    const configurationId = randomUUID();
    await client.query(
      `INSERT INTO tax_filing_configurations(
         id,organization_id,legal_entity_id,ledger_id,registration_id,filing_type_key,
         template_id,mapping_set_id,version,state,effective_from,effective_to,
         supersedes_configuration_id,reason,idempotency_key,command_hash,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [configurationId, input.principal.organizationId, command.legalEntityId, command.ledgerId,
        command.registrationId, command.filingTypeKey, command.templateId, command.mappingSetId,
        version, command.state, command.effectiveFrom, command.effectiveTo ?? null,
        current?.id ?? null, command.reason, command.idempotencyKey, commandHash, input.principal.userId],
    );
    return { configurationId, version, state: command.state, idempotentReplay: false };
  });
}

async function calculateMappedValues(input: Readonly<{
  client: PoolClient;
  organizationId: string;
  mappingSetId: string;
  periodStart: string;
  periodEnd: string;
}>): Promise<Readonly<Record<string, string>>> {
  const result = await input.client.query<{ field_key: string; amount: string }>(
    `WITH mapped_account_totals AS (
       SELECT mapping.id, mapping.field_key, mapping.balance_basis,
         mapping.multiplier,
         coalesce(sum(line.debit_functional) FILTER (WHERE entry.id IS NOT NULL), 0) AS debits,
         coalesce(sum(line.credit_functional) FILTER (WHERE entry.id IS NOT NULL), 0) AS credits
       FROM tax_account_mapping_lines mapping
       JOIN tax_account_mapping_sets mapping_set
         ON mapping_set.organization_id = mapping.organization_id
        AND mapping_set.id = mapping.mapping_set_id
       LEFT JOIN account_combinations combination
         ON combination.organization_id = mapping.organization_id
        AND combination.ledger_id = mapping_set.ledger_id
        AND combination.account_id = mapping.gl_account_id
       LEFT JOIN journal_lines line
         ON line.organization_id = mapping.organization_id
        AND line.ledger_id = mapping_set.ledger_id
        AND line.account_combination_id = combination.id
       LEFT JOIN journal_entries entry
         ON entry.organization_id = line.organization_id
        AND entry.id = line.journal_entry_id
        AND entry.status = 'POSTED'
        AND entry.accounting_date BETWEEN $3::date AND $4::date
       WHERE mapping.organization_id = $1
         AND mapping.mapping_set_id = $2
       GROUP BY mapping.id, mapping.field_key, mapping.balance_basis, mapping.multiplier
     )
     SELECT field_key,
       sum((CASE balance_basis
         WHEN 'DEBITS' THEN debits
         WHEN 'CREDITS' THEN credits
         WHEN 'NET_DEBIT' THEN debits - credits
         WHEN 'NET_CREDIT' THEN credits - debits
         WHEN 'ABSOLUTE_NET' THEN abs(debits - credits)
       END) * multiplier)::text AS amount
     FROM mapped_account_totals
     GROUP BY field_key`,
    [input.organizationId, input.mappingSetId, input.periodStart, input.periodEnd],
  );
  return Object.fromEntries(result.rows.map((row) => [row.field_key, row.amount]));
}

export async function createTaxFiling(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  sourceSurface?: "API" | "MCP";
}> & CreateTaxFilingInput): Promise<Readonly<{
  filingId: string;
  filingType: "PREPARED" | "HISTORICAL_IMPORT";
  status: "READY" | "MATCHED" | "REVIEW_REQUIRED";
  templateId: string;
  templateVersion: number;
  mappingSetId: string;
  mappingVersion: number;
  configurationId: string;
  configurationVersion: number;
  varianceCount: number;
  failedValidationCount: number;
  idempotentReplay: boolean;
}>> {
  assertWritableTaxSession(input.principal);
  const {
    principal: _principal,
    requestId: _requestId,
    sourceSurface: _sourceSurface,
    ...unparsedCommand
  } = input;
  void _principal;
  void _requestId;
  void _sourceSurface;
  const command = createTaxFilingSchema.parse(unparsedCommand);
  const commandHash = createCommandFingerprint("tax.filing.create", {
    ...command,
    idempotencyKey: undefined,
  });
  const reason = command.filingType === "HISTORICAL_IMPORT"
    ? `Import historical tax filing ${command.externalReference}`
    : `Prepare tax return for ${command.periodStart} to ${command.periodEnd}`;

  return withAuthorizedTaxWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.prepareTaxFilings,
    reason,
    sourceSurface: input.sourceSurface
      ?? (command.filingType === "HISTORICAL_IMPORT" ? "IMPORT" : "API"),
  }, async (client) => {
    const replay = await client.query<{
      id: string;
      filing_type: "PREPARED" | "HISTORICAL_IMPORT";
      status: "READY" | "MATCHED" | "REVIEW_REQUIRED";
      template_id: string;
      mapping_set_id: string;
      template_version: number;
      mapping_version: number;
      configuration_id: string;
      configuration_version: number;
      command_hash: string;
      reconciliation_snapshot: unknown;
      validation_snapshot: unknown;
    }>(
      `SELECT id, filing_type, status, template_id, mapping_set_id,
         configuration_id, configuration_version,
         (template_snapshot ->> 'version')::integer AS template_version,
         (template_snapshot ->> 'mappingVersion')::integer AS mapping_version,
         command_hash, reconciliation_snapshot, validation_snapshot
       FROM tax_filings
       WHERE organization_id = $1 AND idempotency_key = $2`,
      [input.principal.organizationId, command.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].command_hash !== commandHash) {
        throw new TaxFilingError("The filing idempotency key was already used for another request.", 409, "IDEMPOTENCY_CONFLICT");
      }
      const reconciliation = z.array(z.object({ status: z.string() }).passthrough()).parse(replay.rows[0].reconciliation_snapshot);
      const validations = z.array(z.object({ status: z.string() }).passthrough()).parse(replay.rows[0].validation_snapshot);
      return {
        filingId: replay.rows[0].id,
        filingType: replay.rows[0].filing_type,
        status: replay.rows[0].status,
        templateId: replay.rows[0].template_id,
        templateVersion: replay.rows[0].template_version,
        mappingSetId: replay.rows[0].mapping_set_id,
        mappingVersion: replay.rows[0].mapping_version,
        configurationId: replay.rows[0].configuration_id,
        configurationVersion: replay.rows[0].configuration_version,
        varianceCount: reconciliation.filter((field) => field.status === "VARIANCE").length,
        failedValidationCount: validations.filter((rule) => rule.status === "FAIL").length,
        idempotentReplay: true,
      };
    }

    const [template, ledger] = await Promise.all([
      loadTemplate(client, command.templateId, command.periodEnd),
      assertEntityLedger(client, input.principal.organizationId, command.legalEntityId, command.ledgerId),
    ]);
    if (template.currency_code !== ledger.currency) {
      throw new TaxFilingError(
        `This template reports in ${template.currency_code}; choose a ${template.currency_code} functional-currency ledger.`,
        400,
        "TEMPLATE_CURRENCY_MISMATCH",
      );
    }
    const definition = taxFilingTemplateDefinitionSchema.parse(template.definition);
    const manualFields = new Set(definition.fields.filter((field) => field.kind === "MANUAL").map((field) => field.key));
    if (Object.keys(command.manualValues).some((field) => !manualFields.has(field))) {
      throw new TaxFilingError("Manual values can be entered only for manual template fields.", 400, "INVALID_MANUAL_FIELD");
    }

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:tax-filing-period:' || $1::text || ':' || $2::text || ':' || $3::text || ':' || $4::text, 0))",
      [input.principal.organizationId, command.legalEntityId, template.template_key, `${command.periodStart}:${command.periodEnd}`],
    );
    const configurations = await client.query<{
      id: string;
      version: number;
      state: string;
      template_id: string;
      mapping_set_id: string;
      registration_id: string | null;
    }>(
      `SELECT configuration.id, configuration.version, configuration.state,
         configuration.template_id, configuration.mapping_set_id, configuration.registration_id
       FROM tax_filing_configurations configuration
       WHERE configuration.organization_id=$1 AND configuration.legal_entity_id=$2
         AND configuration.ledger_id=$3 AND configuration.filing_type_key=$4
         AND configuration.effective_from <= $5::date
         AND (configuration.effective_to IS NULL OR configuration.effective_to >= $5::date)
         AND ($6::uuid IS NULL OR configuration.id=$6)
         AND NOT EXISTS (SELECT 1 FROM tax_filing_configurations successor
           WHERE successor.organization_id=configuration.organization_id
             AND successor.supersedes_configuration_id=configuration.id
             AND successor.effective_from <= $5::date)
       ORDER BY configuration.effective_from DESC,configuration.version DESC LIMIT 2`,
      [input.principal.organizationId, command.legalEntityId, command.ledgerId,
        template.template_key, command.periodEnd, command.configurationId ?? null],
    );
    if (configurations.rows.length !== 1) {
      throw new TaxFilingError(
        configurations.rows.length === 0
          ? "Activate one effective filing configuration before creating this workpaper."
          : "Multiple filing configurations are effective for this scope and period; resolve the overlap first.",
        409,
        configurations.rows.length === 0 ? "CONFIGURATION_REQUIRED" : "CONFIGURATION_OVERLAP",
      );
    }
    const configuration = configurations.rows[0]!;
    if (configuration.state !== "ACTIVE") {
      throw new TaxFilingError("The effective filing configuration is inactive and cannot create a workpaper.", 409, "CONFIGURATION_INACTIVE");
    }
    if (configuration.template_id !== command.templateId) {
      throw new TaxFilingError("The selected template is not the effective configured version for this period.", 409, "CONFIGURED_TEMPLATE_REQUIRED");
    }
    const mappingResult = await client.query<{ id: string; version: number }>(
      `SELECT mapping.id, mapping.version FROM tax_account_mapping_sets mapping
       WHERE mapping.organization_id=$1 AND mapping.id=$2
         AND mapping.legal_entity_id=$3 AND mapping.ledger_id=$4
         AND mapping.template_id=$5 AND mapping.state='ACTIVE'
         AND mapping.effective_from <= $6::date
         AND (mapping.effective_to IS NULL OR mapping.effective_to >= $6::date)`,
      [input.principal.organizationId, configuration.mapping_set_id, command.legalEntityId,
        command.ledgerId, command.templateId, command.periodEnd],
    );
    const mappingSet = mappingResult.rows[0];
    if (!mappingSet) {
      throw new TaxFilingError("Configure client account mappings before preparing or reconciling a return.", 400, "MAPPING_REQUIRED");
    }
    if (command.filingType === "PREPARED") {
      const current = (await client.query(
        `SELECT 1 FROM tax_filings filing
         JOIN tax_filing_configurations existing_configuration
           ON existing_configuration.organization_id=filing.organization_id
          AND existing_configuration.id=filing.configuration_id
         JOIN tax_filing_lifecycle_events lifecycle
           ON lifecycle.organization_id=filing.organization_id AND lifecycle.filing_id=filing.id
         WHERE filing.organization_id=$1 AND filing.legal_entity_id=$2
           AND existing_configuration.registration_id IS NOT DISTINCT FROM $3::uuid
           AND existing_configuration.filing_type_key=$4
           AND filing.period_start=$5::date AND filing.period_end=$6::date
           AND lifecycle.state='CURRENT'
           AND NOT EXISTS (SELECT 1 FROM tax_filing_lifecycle_events successor
             WHERE successor.organization_id=lifecycle.organization_id
               AND successor.supersedes_event_id=lifecycle.id)
         LIMIT 1`,
        [input.principal.organizationId, command.legalEntityId, configuration.registration_id,
          template.template_key, command.periodStart, command.periodEnd],
      )).rows[0];
      if (current) throw new TaxFilingError("A current prepared workpaper already exists for this configuration and period.", 409, "CURRENT_WORKPAPER_EXISTS");
    }
    const mappedValues = await calculateMappedValues({
      client,
      organizationId: input.principal.organizationId,
      mappingSetId: mappingSet.id,
      periodStart: command.periodStart,
      periodEnd: command.periodEnd,
    });
    const mappedManualFields = Object.keys(command.manualValues).filter((field) => (
      Object.hasOwn(mappedValues, field)
    ));
    if (mappedManualFields.length > 0) {
      throw new TaxFilingError(
        "Remove manual values for fields supplied by account mappings.",
        400,
        "MAPPED_MANUAL_CONFLICT",
      );
    }
    const initial = evaluateTaxFilingTemplate({
      definition,
      currency: ledger.currency,
      mappedValues,
      manualValues: command.manualValues,
      reportedValues: command.filingType === "HISTORICAL_IMPORT" ? command.reportedValues : undefined,
    });
    const reportedValues = command.filingType === "PREPARED"
      ? initial.calculatedValues
      : command.reportedValues;
    const evaluation = command.filingType === "PREPARED"
      ? evaluateTaxFilingTemplate({
          definition,
          currency: ledger.currency,
          mappedValues,
          manualValues: command.manualValues,
          reportedValues,
        })
      : initial;
    const needsReview = evaluation.failedValidationCount > 0 ||
      evaluation.reconciliation.some((field) => field.status !== "MATCHED");
    const status = needsReview
      ? "REVIEW_REQUIRED" as const
      : command.filingType === "PREPARED" ? "READY" as const : "MATCHED" as const;
    const templateSnapshot = {
      id: template.id,
      templateKey: template.template_key,
      version: template.version,
      name: template.name,
      authority: template.authority,
      jurisdiction: template.jurisdiction,
      formCode: template.form_code,
      currencyCode: template.currency_code,
      effectiveFrom: template.effective_from,
      effectiveTo: template.effective_to,
      sourceUri: template.source_uri,
      sourceDigest: template.source_digest,
      definition,
      mappingSetId: mappingSet.id,
      mappingVersion: mappingSet.version,
      configurationId: configuration.id,
      configurationVersion: configuration.version,
    };
    const filingId = randomUUID();
    await client.query(
      `INSERT INTO tax_filings (
         id, organization_id, legal_entity_id, ledger_id, template_id,
         mapping_set_id, configuration_id, configuration_version,
         filing_type, status, period_start, period_end,
         external_reference, source_file_name, reported_values,
         calculated_values, reconciliation_snapshot, validation_snapshot,
         template_snapshot, idempotency_key, command_hash, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,
         $17::jsonb,$18::jsonb,$19::jsonb,$20,$21,$22
       )`,
      [
        filingId,
        input.principal.organizationId,
        command.legalEntityId,
        command.ledgerId,
        command.templateId,
        mappingSet.id,
        configuration.id,
        configuration.version,
        command.filingType,
        status,
        command.periodStart,
        command.periodEnd,
        command.externalReference ?? null,
        command.sourceFileName ?? null,
        JSON.stringify(reportedValues),
        JSON.stringify(evaluation.calculatedValues),
        JSON.stringify(evaluation.reconciliation),
        JSON.stringify(evaluation.validations),
        JSON.stringify(templateSnapshot),
        command.idempotencyKey,
        commandHash,
        input.principal.userId,
      ],
    );
    const lifecycleState = command.filingType === "PREPARED" ? "CURRENT" : "HISTORICAL";
    await client.query(
      `INSERT INTO tax_filing_lifecycle_events(
         id,organization_id,filing_id,version,state,replacement_filing_id,
         supersedes_event_id,reason,idempotency_key,command_hash,created_by
       ) VALUES ($1,$2,$3,1,$4,NULL,NULL,$5,$6,$7,$8)`,
      [randomUUID(), input.principal.organizationId, filingId, lifecycleState,
        command.filingType === "PREPARED" ? "Prepared workpaper created as current" : "Historical filing imported for comparison",
        command.idempotencyKey,
        createCommandFingerprint("tax.filing-lifecycle.create", { filingId, state: lifecycleState }),
        input.principal.userId],
    );
    return {
      filingId,
      filingType: command.filingType,
      status,
      templateId: template.id,
      templateVersion: template.version,
      mappingSetId: mappingSet.id,
      mappingVersion: mappingSet.version,
      configurationId: configuration.id,
      configurationVersion: configuration.version,
      varianceCount: evaluation.varianceCount,
      failedValidationCount: evaluation.failedValidationCount,
      idempotentReplay: false,
    };
  });
}

export async function setTaxFilingCanonical(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  sourceSurface?: "API" | "MCP";
}> & SetTaxFilingCanonicalInput): Promise<Readonly<{
  selectionId: string;
  version: number;
  idempotentReplay: boolean;
}>> {
  assertWritableTaxSession(input.principal);
  const { principal: _principal, requestId: _requestId, sourceSurface: _sourceSurface, ...raw } = input;
  void _principal; void _requestId; void _sourceSurface;
  const command = setTaxFilingCanonicalSchema.parse(raw);
  const commandHash = createCommandFingerprint("tax.filing-canonical.select", { ...command, idempotencyKey: undefined });
  return withAuthorizedTaxWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.manageTaxFilingCanonical,
    reason: command.reason,
    sourceSurface: input.sourceSurface,
  }, async (client) => {
    const replay = (await client.query<{ id: string; version: number; command_hash: string }>(
      `SELECT id, version, command_hash FROM tax_filing_canonical_selections
       WHERE organization_id=$1 AND idempotency_key=$2`,
      [input.principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new TaxFilingError("The canonical-selection idempotency key conflicts with another request.", 409, "IDEMPOTENCY_CONFLICT");
      return { selectionId: replay.id, version: replay.version, idempotentReplay: true };
    }
    const filing = (await client.query<{
      id: string; legal_entity_id: string; registration_id: string | null; filing_type_key: string;
      period_start: string; period_end: string; lifecycle_state: string;
    }>(
      `SELECT filing.id, filing.legal_entity_id, configuration.registration_id,
         configuration.filing_type_key, filing.period_start::text, filing.period_end::text,
         lifecycle.state AS lifecycle_state
       FROM tax_filings filing
       JOIN tax_filing_configurations configuration
         ON configuration.organization_id=filing.organization_id AND configuration.id=filing.configuration_id
       JOIN tax_filing_lifecycle_events lifecycle
         ON lifecycle.organization_id=filing.organization_id AND lifecycle.filing_id=filing.id
         AND NOT EXISTS (SELECT 1 FROM tax_filing_lifecycle_events successor
           WHERE successor.organization_id=lifecycle.organization_id AND successor.supersedes_event_id=lifecycle.id)
       WHERE filing.organization_id=$1 AND filing.id=$2 FOR UPDATE OF filing`,
      [input.principal.organizationId, command.filingId],
    )).rows[0];
    if (!filing) throw new TaxFilingError("The filing workpaper was not found.", 404, "FILING_NOT_FOUND");
    if (["ARCHIVED", "SUPERSEDED"].includes(filing.lifecycle_state)) {
      throw new TaxFilingError("An archived or superseded workpaper cannot become canonical.", 409, "FILING_LIFECYCLE_CONFLICT");
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('business-finlynq:tax-filing-canonical:' || $1::text || ':' || $2::text || ':' || $3::text || ':' || $4::text, 0))",
      [input.principal.organizationId, filing.legal_entity_id, filing.filing_type_key, `${filing.period_start}:${filing.period_end}`],
    );
    const current = (await client.query<{ id: string; version: number }>(
      `SELECT selection.id, selection.version FROM tax_filing_canonical_selections selection
       WHERE selection.organization_id=$1 AND selection.legal_entity_id=$2
         AND selection.registration_id IS NOT DISTINCT FROM $3::uuid
         AND selection.filing_type_key=$4 AND selection.period_start=$5::date AND selection.period_end=$6::date
         AND NOT EXISTS (SELECT 1 FROM tax_filing_canonical_selections successor
           WHERE successor.organization_id=selection.organization_id
             AND successor.supersedes_selection_id=selection.id)
       ORDER BY selection.version DESC LIMIT 1 FOR UPDATE`,
      [input.principal.organizationId, filing.legal_entity_id, filing.registration_id,
        filing.filing_type_key, filing.period_start, filing.period_end],
    )).rows[0];
    if ((current?.version ?? 0) !== command.expectedSelectionVersion) {
      throw new TaxFilingError("The canonical selection changed. Reload its exact current version.", 409, "CANONICAL_VERSION_CONFLICT");
    }
    const selectionId = randomUUID();
    const version = (current?.version ?? 0) + 1;
    await client.query(
      `INSERT INTO tax_filing_canonical_selections(
         id,organization_id,legal_entity_id,registration_id,filing_type_key,
         period_start,period_end,filing_id,version,state,supersedes_selection_id,
         reason,idempotency_key,command_hash,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10,$11,$12,$13,$14)`,
      [selectionId, input.principal.organizationId, filing.legal_entity_id, filing.registration_id,
        filing.filing_type_key, filing.period_start, filing.period_end, filing.id, version,
        current?.id ?? null, command.reason, command.idempotencyKey, commandHash, input.principal.userId],
    );
    return { selectionId, version, idempotentReplay: false };
  });
}

export async function transitionTaxFilingLifecycle(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  sourceSurface?: "API" | "MCP";
}> & TransitionTaxFilingLifecycleInput): Promise<Readonly<{
  lifecycleEventId: string;
  version: number;
  state: "SUPERSEDED" | "ARCHIVED";
  idempotentReplay: boolean;
}>> {
  assertWritableTaxSession(input.principal);
  const { principal: _principal, requestId: _requestId, sourceSurface: _sourceSurface, ...raw } = input;
  void _principal; void _requestId; void _sourceSurface;
  const command = transitionTaxFilingLifecycleSchema.parse(raw);
  if (command.state === "SUPERSEDED" && !command.replacementFilingId) {
    throw new TaxFilingError("A superseded workpaper requires its replacement filing ID.", 400, "REPLACEMENT_REQUIRED");
  }
  const commandHash = createCommandFingerprint("tax.filing-lifecycle.transition", { ...command, idempotencyKey: undefined });
  return withAuthorizedTaxWrite({
    principal: input.principal,
    requestId: input.requestId,
    permission: PERMISSIONS.manageTaxFilingCanonical,
    reason: command.reason,
    sourceSurface: input.sourceSurface,
  }, async (client) => {
    const replay = (await client.query<{ id: string; version: number; state: "SUPERSEDED" | "ARCHIVED"; command_hash: string }>(
      `SELECT id,version,state,command_hash FROM tax_filing_lifecycle_events
       WHERE organization_id=$1 AND idempotency_key=$2`,
      [input.principal.organizationId, command.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new TaxFilingError("The lifecycle idempotency key conflicts with another request.", 409, "IDEMPOTENCY_CONFLICT");
      return { lifecycleEventId: replay.id, version: replay.version, state: replay.state, idempotentReplay: true };
    }
    const current = (await client.query<{ id: string; version: number; state: string }>(
      `SELECT lifecycle.id,lifecycle.version,lifecycle.state
       FROM tax_filing_lifecycle_events lifecycle
       WHERE lifecycle.organization_id=$1 AND lifecycle.filing_id=$2
         AND NOT EXISTS (SELECT 1 FROM tax_filing_lifecycle_events successor
           WHERE successor.organization_id=lifecycle.organization_id AND successor.supersedes_event_id=lifecycle.id)
       FOR UPDATE`,
      [input.principal.organizationId, command.filingId],
    )).rows[0];
    if (!current) throw new TaxFilingError("The filing lifecycle was not found.", 404, "FILING_NOT_FOUND");
    if (current.version !== command.expectedLifecycleVersion || ["ARCHIVED", "SUPERSEDED"].includes(current.state)) {
      throw new TaxFilingError("The filing lifecycle changed or is already terminal.", 409, "FILING_LIFECYCLE_CONFLICT");
    }
    const canonicalDependency = (await client.query(
      `SELECT 1 FROM tax_filing_canonical_selections selection
       WHERE selection.organization_id=$1 AND selection.filing_id=$2 AND selection.state='ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM tax_filing_canonical_selections successor
           WHERE successor.organization_id=selection.organization_id AND successor.supersedes_selection_id=selection.id)
       LIMIT 1`,
      [input.principal.organizationId, command.filingId],
    )).rows[0];
    if (canonicalDependency) {
      throw new TaxFilingError("Select a different canonical workpaper before archiving or superseding this one.", 409, "CANONICAL_DEPENDENCY");
    }
    if (command.replacementFilingId) {
      const replacement = (await client.query(
        `SELECT 1 FROM tax_filings original
         JOIN tax_filing_configurations original_configuration
           ON original_configuration.organization_id=original.organization_id
          AND original_configuration.id=original.configuration_id
         JOIN tax_filings replacement
           ON replacement.organization_id=original.organization_id
          AND replacement.legal_entity_id=original.legal_entity_id
          AND replacement.period_start=original.period_start AND replacement.period_end=original.period_end
         JOIN tax_filing_configurations replacement_configuration
           ON replacement_configuration.organization_id=replacement.organization_id
          AND replacement_configuration.id=replacement.configuration_id
          AND replacement_configuration.registration_id IS NOT DISTINCT FROM original_configuration.registration_id
          AND replacement_configuration.filing_type_key=original_configuration.filing_type_key
         JOIN tax_filing_lifecycle_events replacement_lifecycle
           ON replacement_lifecycle.organization_id=replacement.organization_id
          AND replacement_lifecycle.filing_id=replacement.id
          AND replacement_lifecycle.state NOT IN ('ARCHIVED','SUPERSEDED')
          AND NOT EXISTS (SELECT 1 FROM tax_filing_lifecycle_events successor
            WHERE successor.organization_id=replacement_lifecycle.organization_id
              AND successor.supersedes_event_id=replacement_lifecycle.id)
         WHERE original.organization_id=$1 AND original.id=$2 AND replacement.id=$3`,
        [input.principal.organizationId, command.filingId, command.replacementFilingId],
      )).rows[0];
      if (!replacement) throw new TaxFilingError("The replacement must belong to the same filing scope and period.", 400, "INVALID_REPLACEMENT");
    }
    const lifecycleEventId = randomUUID();
    const version = current.version + 1;
    await client.query(
      `INSERT INTO tax_filing_lifecycle_events(
         id,organization_id,filing_id,version,state,replacement_filing_id,
         supersedes_event_id,reason,idempotency_key,command_hash,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [lifecycleEventId, input.principal.organizationId, command.filingId, version, command.state,
        command.replacementFilingId ?? null, current.id, command.reason, command.idempotencyKey,
        commandHash, input.principal.userId],
    );
    return { lifecycleEventId, version, state: command.state, idempotentReplay: false };
  });
}
