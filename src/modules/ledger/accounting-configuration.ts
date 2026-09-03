import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction } from "@/db/transaction";
import { actorHasActivePermission } from "@/modules/identity/authorization";
import { OrganizationAdministrationError } from "@/modules/identity/organization-administration";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { hasRecentStepUp, transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import {
  decryptField,
  encryptField,
  parseEncryptedField,
  serializeEncryptedField,
} from "@/security/organization-encryption";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
  demoWritesEnabled,
  mutationContext,
  principalCanWrite,
} from "@/modules/workspace/write-policy";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import { supportedCurrencies } from "@/kernel/money";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import { presentAccountKey } from "./account-key-display";
import {
  accountSegmentKeys,
  type AccountSegmentKey,
} from "./accounting-configuration-contract";

export { accountSegmentKeys, type AccountSegmentKey } from "./accounting-configuration-contract";

const countrySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const regionSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,10}$/);
const currencySchema = z.string().trim().toUpperCase().refine(
  (value) => supportedCurrencies.includes(value),
  "Choose a supported currency",
);
const optionalCitySchema = z.union([
  z.string().trim().min(1).max(100),
  z.literal(""),
]).nullish().transform((value) => value || null);
const optionalLocationCodeSchema = z.union([
  z.string().trim().toUpperCase().min(1).max(40),
  z.literal(""),
]).nullish().transform((value) => value || null);
const optionalDateSchema = z.union([
  z.iso.date(),
  z.literal(""),
]).nullish().transform((value) => value || null);
const optionalUuidSchema = z.union([
  z.uuid(),
  z.literal(""),
  z.null(),
]).optional().transform((value) => value || null);

export const accountSegmentKeySchema = z.enum(accountSegmentKeys);

export const legalEntityConfigurationSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/).refine((value) => value !== "0000"),
  displayName: z.string().trim().min(2).max(200),
  countryCode: countrySchema,
  regionCode: regionSchema,
  functionalCurrency: currencySchema,
  accountingProfile: z.enum(["CAN_ASPE", "US_GAAP_NONPUBLIC"]),
  fiscalYear: z.number().int().min(2000).max(2200),
  manualPostingMode: z.enum(["REVIEW_REQUIRED", "AUTO_POST"]),
  reason: z.string().trim().min(8).max(500),
}).strict();

export const fiscalPeriodCreationSchema = z.object({
  ledgerId: z.uuid(),
  fiscalYear: z.number().int().min(2000).max(2200),
  periodPattern: z.literal("MONTHLY"),
  initialState: z.literal("OPEN"),
  idempotencyKey: z.string().trim().min(1).max(180),
  reason: z.string().trim().min(8).max(500),
}).strict();

const fiscalPeriodOutcomeSchema = z.enum([
  "CREATED",
  "ALREADY_EXISTING",
  "REJECTED",
]);
const fiscalPeriodRejectionSchema = z.enum([
  "INCOMPATIBLE_PERIOD_DEFINITION",
  "OVERLAPPING_PERIOD",
  "BATCH_REJECTED",
]);
const fiscalPeriodStateSchema = z.enum([
  "OPEN",
  "ADJUSTMENT_ONLY",
  "HARD_CLOSED",
  "SEALED",
]);

export const fiscalPeriodCreationResultSchema = z.object({
  accepted: z.boolean(),
  idempotentReplay: z.boolean(),
  ledgerId: z.uuid(),
  fiscalYear: z.number().int(),
  periodPattern: z.literal("MONTHLY"),
  initialState: z.literal("OPEN"),
  summary: z.object({
    created: z.number().int().nonnegative(),
    existing: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }).strict(),
  periods: z.array(z.object({
    periodId: z.uuid().nullable(),
    periodNumber: z.number().int().min(1).max(12),
    label: z.string(),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    state: fiscalPeriodStateSchema.nullable(),
    outcome: fiscalPeriodOutcomeSchema,
    rejectionCode: fiscalPeriodRejectionSchema.nullable(),
  }).strict()).length(12),
  conflicts: z.array(z.object({
    periodId: z.uuid(),
    fiscalYear: z.number().int(),
    periodNumber: z.number().int(),
    label: z.string(),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    state: fiscalPeriodStateSchema,
    rejectionCode: fiscalPeriodRejectionSchema.exclude(["BATCH_REJECTED"]),
  }).strict()),
}).strict();

export type FiscalPeriodCreationResult = z.output<typeof fiscalPeriodCreationResultSchema>;

export const organizationCurrencyConfigurationSchema = z.object({
  currencyCode: currencySchema,
  enabled: z.boolean(),
  reason: z.string().trim().min(8).max(500),
}).strict();

export const currencyRateConfigurationSchema = z.object({
  sourceCurrency: currencySchema,
  targetCurrency: currencySchema,
  rate: z.string().trim().regex(/^\d+(?:\.\d{1,18})?$/).refine((value) => {
    const [integerPart, fractionalPart = ""] = value.split(".");
    const significantIntegerDigits = integerPart!.replace(/^0+/, "").length;
    return significantIntegerDigits <= 20 && /[1-9]/.test(`${integerPart}${fractionalPart}`);
  }, "Enter a positive rate with no more than 20 whole and 18 decimal digits"),
  effectiveAt: z.iso.datetime({ offset: true }),
  source: z.string().trim().min(2).max(100),
  reason: z.string().trim().min(8).max(500),
}).strict().refine((value) => value.sourceCurrency !== value.targetCurrency, {
  message: "Choose two different currencies",
  path: ["targetCurrency"],
});

export const segmentConfigurationSchema = z.object({
  key: accountSegmentKeySchema,
  displayName: z.string().trim().min(2).max(80),
  visible: z.boolean(),
  required: z.boolean(),
  action: z.enum(["CONFIGURE", "ACTIVATE", "DEACTIVATE"]),
  reason: z.string().trim().min(8).max(500),
}).strict();

export const segmentValueConfigurationSchema = z.object({
  definitionKey: accountSegmentKeySchema,
  code: z.string().trim().toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/)
    .refine((value) => value !== "0000", "0000 is reserved for an unused segment"),
  displayName: z.string().trim().min(2).max(100),
  validFrom: z.iso.date(),
  validTo: optionalDateSchema,
  reason: z.string().trim().min(8).max(500),
}).strict().superRefine((value, context) => {
  if (value.validTo && value.validTo < value.validFrom) {
    context.addIssue({
      code: "custom",
      message: "The valid-to date cannot precede the valid-from date",
      path: ["validTo"],
    });
  }
});

export const accountCombinationConfigurationSchema = z.object({
  legalEntityId: z.uuid(),
  ledgerId: z.uuid(),
  accountId: z.uuid(),
  subaccountId: optionalUuidSchema,
  departmentId: optionalUuidSchema,
  intercompanyEntityId: optionalUuidSchema,
  custom1Id: optionalUuidSchema,
  custom2Id: optionalUuidSchema,
  custom3Id: optionalUuidSchema,
  custom4Id: optionalUuidSchema,
  custom5Id: optionalUuidSchema,
  custom6Id: optionalUuidSchema,
  custom7Id: optionalUuidSchema,
  custom8Id: optionalUuidSchema,
  replacesCombinationId: optionalUuidSchema,
  reason: z.string().trim().min(8).max(500),
}).strict().refine((value) => value.intercompanyEntityId !== value.legalEntityId, {
  message: "Intercompany must reference another legal entity",
  path: ["intercompanyEntityId"],
});

export const taxRegistrationConfigurationSchema = z.object({
  legalEntityId: z.uuid(),
  regimeKey: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{1,99}$/),
  registrationReference: z.string().trim().min(2).max(200),
  destinationCountry: countrySchema,
  destinationRegion: regionSchema,
  destinationCity: optionalCitySchema,
  locationCode: optionalLocationCodeSchema,
  configurationEvidence: z.string().trim().min(8).max(1000),
  validFrom: z.iso.date(),
  validTo: optionalDateSchema,
  reason: z.string().trim().min(8).max(500),
}).strict().superRefine((value, context) => {
  if (value.validTo && value.validTo < value.validFrom) {
    context.addIssue({
      code: "custom",
      message: "The valid-to date cannot precede the valid-from date",
      path: ["validTo"],
    });
  }
  if (value.regimeKey === "us.wa.sales-use") {
    const seattleNamed = value.destinationCity?.toUpperCase() === "SEATTLE";
    const seattleLocation = value.locationCode === "1726";
    if (seattleNamed !== seattleLocation) {
      context.addIssue({
        code: "custom",
        message: "Seattle automation requires both city Seattle and DOR location code 1726",
        path: seattleNamed ? ["locationCode"] : ["destinationCity"],
      });
    }
  }
});

export function taxRegistrationAutomationStatus(input: Readonly<{
  regimeKey: string;
  destinationCountry: string;
  destinationRegion: string;
  destinationCity: string | null;
  locationCode: string | null;
}>): "AUTOMATED" | "MANUAL_REVIEW" {
  if (
    input.regimeKey === "ca.on.hst"
    && input.destinationCountry === "CA"
    && input.destinationRegion === "ON"
  ) return "AUTOMATED";
  if (
    input.regimeKey === "us.wa.sales-use"
    && input.destinationCountry === "US"
    && input.destinationRegion === "WA"
    && input.destinationCity?.toUpperCase() === "SEATTLE"
    && input.locationCode === "1726"
  ) return "AUTOMATED";
  return "MANUAL_REVIEW";
}

export type AccountingSegmentValueDto = Readonly<{
  id: string;
  definitionKey: AccountSegmentKey;
  code: string;
  displayName: string;
  active: boolean;
  validFrom: string;
  validTo: string | null;
}>;

export type AccountingCombinationSegmentValueDto = Readonly<{
  id: string;
  code: string;
  displayName: string;
}>;

export type AccountingConfigurationDto = Readonly<{
  canManageSettings: boolean;
  canManageSegments: boolean;
  canManagePostingPolicy: boolean;
  requiresMfaStepUp: boolean;
  currencies: readonly Readonly<{
    code: string;
    minorUnits: number;
    enabled: boolean;
    functional: boolean;
  }>[];
  rates: readonly Readonly<{
    id: string;
    sourceCurrency: string;
    targetCurrency: string;
    rate: string;
    effectiveAt: string;
    source: string;
    createdAt: string;
  }>[];
  segments: readonly Readonly<{
    id: string;
    key: AccountSegmentKey;
    displayName: string;
    state: "EMPTY" | "CONFIGURED_UNBOUND" | "ACTIVE_LOCKED" | "INACTIVE_LOCKED";
    required: boolean;
    visible: boolean;
    protectedUseAt: string | null;
    missingActiveCombinationCount: number;
    values: readonly AccountingSegmentValueDto[];
  }>[];
  entities: readonly Readonly<{
    id: string;
    code: string;
    displayName: string;
    countryCode: string;
    regionCode: string;
    ledgerId: string;
    ledgerCode: string;
    functionalCurrency: string;
    accountingProfile: "CAN_ASPE" | "US_GAAP_NONPUBLIC";
    firstPostedAt: string | null;
    manualPostingMode: "REVIEW_REQUIRED" | "AUTO_POST";
    postingPolicyVersion: number;
    accounts: readonly Readonly<{
      id: string;
      code: string;
      displayName: string;
      accountClass: string;
    }>[];
  }>[];
  accountCombinations: readonly Readonly<{
    id: string;
    legalEntityId: string;
    entityCode: string;
    ledgerId: string;
    ledgerCode: string;
    accountId: string;
    accountCode: string;
    accountName: string;
    intercompanyEntityId: string | null;
    intercompanyEntityCode: string | null;
    segmentValues: Readonly<Record<AccountSegmentKey, AccountingCombinationSegmentValueDto | null>>;
    canonicalKey: string;
    displayKey: string;
    active: boolean;
    used: boolean;
    lastUsedAt: string | null;
  }>[];
  taxPacks: readonly Readonly<{
    key: string;
    version: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>[];
  taxRegistrations: readonly Readonly<{
    id: string;
    legalEntityId: string;
    entityCode: string;
    regimeKey: string;
    registrationReference: string;
    destinationCountry: string | null;
    destinationRegion: string | null;
    destinationCity: string | null;
    locationCode: string | null;
    configurationEvidence: string | null;
    validFrom: string;
    validTo: string | null;
    automationStatus: "AUTOMATED" | "MANUAL_REVIEW";
  }>[];
}>;

function readContext(principal: SessionPrincipal) {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `accounting-configuration-read:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI" as const,
  };
}

export async function loadAccountingConfiguration(
  principal: SessionPrincipal,
): Promise<AccountingConfigurationDto> {
  return withWorkspaceTenantRead(readContext(principal), "/app/settings/accounting", async (client) => {
    const [canManageSettings, canManageSegments, canManagePostingPolicy, canReadTax] = await Promise.all([
      actorHasActivePermission(client, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.manageOrganizationSettings,
      }),
      actorHasActivePermission(client, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.manageSegments,
      }),
      actorHasActivePermission(client, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.managePostingPolicy,
      }),
      actorHasActivePermission(client, {
        organizationId: principal.organizationId,
        actorId: principal.userId,
        permission: PERMISSIONS.readTax,
      }),
    ]);
    const writable = principalCanWrite(principal);
    const [
      currencyResult,
      rateResult,
      segmentResult,
      entityResult,
      taxPackResult,
      taxRegistrationResult,
      segmentValueResult,
      accountResult,
      combinationResult,
    ] = await Promise.all([
      client.query<{
        code: string; minor_units: number; enabled: boolean; functional: boolean;
      }>(
        `SELECT definition.code, definition.minor_units,
           coalesce(config.enabled, false) AS enabled,
           EXISTS (
             SELECT 1 FROM ledgers ledger
             WHERE ledger.organization_id = $1 AND ledger.active
               AND ledger.functional_currency = definition.code
           ) AS functional
         FROM currency_definitions definition
         LEFT JOIN organization_currencies config
           ON config.organization_id = $1 AND config.currency_code = definition.code
         WHERE definition.active
         ORDER BY CASE definition.code WHEN 'USD' THEN 0 WHEN 'CAD' THEN 1 ELSE 2 END,
           definition.code`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; source_currency: string; target_currency: string; rate: string;
        effective_at: string; source: string; created_at: string;
      }>(
        `SELECT id, source_currency, target_currency, rate::text,
           effective_at::text, source, created_at::text
         FROM currency_exchange_rates
         WHERE organization_id = $1
         ORDER BY effective_at DESC, created_at DESC, id DESC
         LIMIT 200`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; key: AccountSegmentKey; display_name: string;
        state: AccountingConfigurationDto["segments"][number]["state"];
        required: boolean; visible: boolean; protected_use_at: string | null;
        missing_active_combination_count: number;
      }>(
        `SELECT definition.id, lower(definition.key) AS key,
           definition.display_name, definition.state, definition.required,
           definition.visible, definition.protected_use_at::text,
           (
             SELECT count(*)::integer
             FROM account_combinations combination
             WHERE combination.organization_id = definition.organization_id
               AND combination.active
               AND CASE lower(definition.key)
                 WHEN 'subaccount' THEN combination.subaccount_id
                 WHEN 'department' THEN combination.department_id
                 WHEN 'custom1' THEN combination.custom_1_id
                 WHEN 'custom2' THEN combination.custom_2_id
                 WHEN 'custom3' THEN combination.custom_3_id
                 WHEN 'custom4' THEN combination.custom_4_id
                 WHEN 'custom5' THEN combination.custom_5_id
                 WHEN 'custom6' THEN combination.custom_6_id
                 WHEN 'custom7' THEN combination.custom_7_id
                 WHEN 'custom8' THEN combination.custom_8_id
               END IS NULL
           ) AS missing_active_combination_count
         FROM segment_definitions definition
         WHERE definition.organization_id = $1
         ORDER BY definition.ordinal`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; code: string; display_name: string; country_code: string; region_code: string;
        ledger_id: string; ledger_code: string; functional_currency: string;
        accounting_profile: "CAN_ASPE" | "US_GAAP_NONPUBLIC"; first_posted_at: string | null;
        manual_posting_mode: "REVIEW_REQUIRED" | "AUTO_POST"; posting_policy_version: number;
      }>(
        `SELECT entity.id, entity.code, entity.display_name,
           entity.country_code, entity.region_code, ledger.id AS ledger_id,
           ledger.code AS ledger_code,
           ledger.functional_currency, ledger.accounting_profile,
           ledger.first_posted_at::text,
           coalesce(policy.manual_mode, 'REVIEW_REQUIRED'::manual_posting_mode) AS manual_posting_mode,
           coalesce(policy.version, 0) AS posting_policy_version
         FROM legal_entities entity
         JOIN ledgers ledger
           ON ledger.organization_id = entity.organization_id
          AND ledger.legal_entity_id = entity.id
          AND ledger.kind = 'PRIMARY' AND ledger.active
         LEFT JOIN ledger_posting_policies policy
           ON policy.organization_id = ledger.organization_id
          AND policy.ledger_id = ledger.id
         WHERE entity.organization_id = $1 AND entity.active
         ORDER BY entity.code`,
        [principal.organizationId],
      ),
      client.query<{
        pack_key: string; version: string; effective_from: string; effective_to: string | null;
      }>(
        `SELECT DISTINCT ON (pack_key) pack_key, version,
           effective_from::text, effective_to::text
         FROM tax_pack_versions
         ORDER BY pack_key, effective_from DESC, approved_at DESC`,
      ),
      client.query<{
        id: string; legal_entity_id: string; entity_code: string; regime_key: string;
        registration_ciphertext: string; key_version: string;
        destination_country: string | null; destination_region: string | null;
        destination_city: string | null; location_code: string | null;
        configuration_evidence: string | null; valid_from: string; valid_to: string | null;
      }>(
        `SELECT registration.id, registration.legal_entity_id,
           entity.code AS entity_code, registration.regime_key,
           registration.registration_ciphertext, registration.key_version,
           registration.destination_country, registration.destination_region,
           registration.destination_city, registration.location_code,
           registration.configuration_evidence,
           registration.valid_from::text, registration.valid_to::text
         FROM entity_tax_registrations registration
         JOIN legal_entities entity
           ON entity.organization_id = registration.organization_id
          AND entity.id = registration.legal_entity_id
         WHERE registration.organization_id = $1
         ORDER BY entity.code, registration.valid_from DESC, registration.id DESC
         LIMIT 500`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; definition_key: AccountSegmentKey; code: string; display_name: string;
        active: boolean; valid_from: string; valid_to: string | null;
      }>(
        `SELECT value.id, lower(definition.key) AS definition_key,
           value.code, value.display_name, value.active,
           value.valid_from::text, value.valid_to::text
         FROM segment_values value
         JOIN segment_definitions definition
           ON definition.organization_id = value.organization_id
          AND definition.id = value.definition_id
         WHERE value.organization_id = $1
         ORDER BY definition.ordinal, value.code, value.valid_from, value.id
         LIMIT 2000`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; ledger_id: string; code: string; display_name: string; account_class: string;
      }>(
        `SELECT account.id, account.ledger_id, account.code,
           account.display_name, account.class::text AS account_class
         FROM gl_accounts account
         WHERE account.organization_id = $1
           AND account.active AND account.postable
         ORDER BY account.ledger_id, account.code, account.id
         LIMIT 5000`,
        [principal.organizationId],
      ),
      client.query<{
        id: string; legal_entity_id: string; entity_code: string;
        ledger_id: string; ledger_code: string; account_id: string;
        account_code: string; account_name: string;
        intercompany_entity_id: string | null; intercompany_entity_code: string | null;
        subaccount_id: string | null; subaccount_code: string | null; subaccount_name: string | null;
        department_id: string | null; department_code: string | null; department_name: string | null;
        custom_1_id: string | null; custom_1_code: string | null; custom_1_name: string | null;
        custom_2_id: string | null; custom_2_code: string | null; custom_2_name: string | null;
        custom_3_id: string | null; custom_3_code: string | null; custom_3_name: string | null;
        custom_4_id: string | null; custom_4_code: string | null; custom_4_name: string | null;
        custom_5_id: string | null; custom_5_code: string | null; custom_5_name: string | null;
        custom_6_id: string | null; custom_6_code: string | null; custom_6_name: string | null;
        custom_7_id: string | null; custom_7_code: string | null; custom_7_name: string | null;
        custom_8_id: string | null; custom_8_code: string | null; custom_8_name: string | null;
        canonical_key: string; active: boolean; used: boolean; last_used_at: string | null;
      }>(
        `SELECT combination.id, combination.entity_id AS legal_entity_id,
           entity.code AS entity_code, combination.ledger_id, ledger.code AS ledger_code,
           combination.account_id, account.code AS account_code,
           account.display_name AS account_name,
           combination.intercompany_entity_id, intercompany.code AS intercompany_entity_code,
           combination.subaccount_id, subaccount.code AS subaccount_code,
           subaccount.display_name AS subaccount_name,
           combination.department_id, department.code AS department_code,
           department.display_name AS department_name,
           combination.custom_1_id, custom1.code AS custom_1_code, custom1.display_name AS custom_1_name,
           combination.custom_2_id, custom2.code AS custom_2_code, custom2.display_name AS custom_2_name,
           combination.custom_3_id, custom3.code AS custom_3_code, custom3.display_name AS custom_3_name,
           combination.custom_4_id, custom4.code AS custom_4_code, custom4.display_name AS custom_4_name,
           combination.custom_5_id, custom5.code AS custom_5_code, custom5.display_name AS custom_5_name,
           combination.custom_6_id, custom6.code AS custom_6_code, custom6.display_name AS custom_6_name,
           combination.custom_7_id, custom7.code AS custom_7_code, custom7.display_name AS custom_7_name,
           combination.custom_8_id, custom8.code AS custom_8_code, custom8.display_name AS custom_8_name,
           concat_ws('.', entity.code, account.code,
             coalesce(subaccount.code, '0000'), coalesce(department.code, '0000'),
             coalesce(intercompany.code, '0000'),
             coalesce(custom1.code, '0000'), coalesce(custom2.code, '0000'),
             coalesce(custom3.code, '0000'), coalesce(custom4.code, '0000'),
             coalesce(custom5.code, '0000'), coalesce(custom6.code, '0000'),
             coalesce(custom7.code, '0000'), coalesce(custom8.code, '0000')) AS canonical_key,
           combination.active,
           EXISTS (
             SELECT 1 FROM journal_lines line
             WHERE line.organization_id = combination.organization_id
               AND line.account_combination_id = combination.id
           ) AS used,
           combination.last_used_at::text
         FROM account_combinations combination
         JOIN legal_entities entity
           ON entity.organization_id = combination.organization_id
          AND entity.id = combination.entity_id
         JOIN ledgers ledger
           ON ledger.organization_id = combination.organization_id
          AND ledger.id = combination.ledger_id
         JOIN gl_accounts account
           ON account.organization_id = combination.organization_id
          AND account.id = combination.account_id
         LEFT JOIN legal_entities intercompany
           ON intercompany.organization_id = combination.organization_id
          AND intercompany.id = combination.intercompany_entity_id
         LEFT JOIN segment_values subaccount
           ON subaccount.organization_id = combination.organization_id
          AND subaccount.id = combination.subaccount_id
         LEFT JOIN segment_values department
           ON department.organization_id = combination.organization_id
          AND department.id = combination.department_id
         LEFT JOIN segment_values custom1 ON custom1.organization_id = combination.organization_id AND custom1.id = combination.custom_1_id
         LEFT JOIN segment_values custom2 ON custom2.organization_id = combination.organization_id AND custom2.id = combination.custom_2_id
         LEFT JOIN segment_values custom3 ON custom3.organization_id = combination.organization_id AND custom3.id = combination.custom_3_id
         LEFT JOIN segment_values custom4 ON custom4.organization_id = combination.organization_id AND custom4.id = combination.custom_4_id
         LEFT JOIN segment_values custom5 ON custom5.organization_id = combination.organization_id AND custom5.id = combination.custom_5_id
         LEFT JOIN segment_values custom6 ON custom6.organization_id = combination.organization_id AND custom6.id = combination.custom_6_id
         LEFT JOIN segment_values custom7 ON custom7.organization_id = combination.organization_id AND custom7.id = combination.custom_7_id
         LEFT JOIN segment_values custom8 ON custom8.organization_id = combination.organization_id AND custom8.id = combination.custom_8_id
         WHERE combination.organization_id = $1
         ORDER BY combination.active DESC, entity.code, account.code, canonical_key, combination.id
         LIMIT 5000`,
        [principal.organizationId],
      ),
    ]);

    const taxRegistrations: AccountingConfigurationDto["taxRegistrations"][number][] = [];
    if ((canManageSettings || canReadTax) && taxRegistrationResult.rows.length > 0) {
      const activeKey = await loadActiveOrganizationKey(client, principal.organizationId);
      try {
        for (const row of taxRegistrationResult.rows) {
          const keyVersion = Number(row.key_version);
          if (!Number.isSafeInteger(keyVersion) || keyVersion !== activeKey.keyVersion) {
            throw new Error("Tax registration encryption key is not the active organization key");
          }
          const registrationReference = decryptField(
            parseEncryptedField(row.registration_ciphertext),
            activeKey.dek,
            {
              organizationId: principal.organizationId,
              table: "entity_tax_registrations",
              column: "registration_ciphertext",
              recordId: row.id,
              keyVersion,
            },
          );
          taxRegistrations.push({
            id: row.id,
            legalEntityId: row.legal_entity_id,
            entityCode: row.entity_code,
            regimeKey: row.regime_key,
            registrationReference,
            destinationCountry: row.destination_country,
            destinationRegion: row.destination_region,
            destinationCity: row.destination_city,
            locationCode: row.location_code,
            configurationEvidence: row.configuration_evidence,
            validFrom: row.valid_from,
            validTo: row.valid_to,
            automationStatus: taxRegistrationAutomationStatus({
              regimeKey: row.regime_key,
              destinationCountry: row.destination_country ?? "",
              destinationRegion: row.destination_region ?? "",
              destinationCity: row.destination_city,
              locationCode: row.location_code,
            }),
          });
        }
      } finally {
        activeKey.dek.fill(0);
      }
    }

    const segmentValues = segmentValueResult.rows.map<AccountingSegmentValueDto>((row) => ({
      id: row.id,
      definitionKey: row.definition_key,
      code: row.code,
      displayName: row.display_name,
      active: row.active,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    }));
    const segmentDefinitions = segmentResult.rows.map((row) => ({
      key: row.key,
      displayName: row.display_name,
      visible: row.visible,
    }));
    const combinationValue = (
      id: string | null,
      code: string | null,
      displayName: string | null,
    ): AccountingCombinationSegmentValueDto | null => (
      id && code && displayName ? { id, code, displayName } : null
    );
    const accountCombinations: AccountingConfigurationDto["accountCombinations"][number][] =
      combinationResult.rows.map((row) => {
        const presentation = presentAccountKey(row.canonical_key, segmentDefinitions);
        return {
          id: row.id,
          legalEntityId: row.legal_entity_id,
          entityCode: row.entity_code,
          ledgerId: row.ledger_id,
          ledgerCode: row.ledger_code,
          accountId: row.account_id,
          accountCode: row.account_code,
          accountName: row.account_name,
          intercompanyEntityId: row.intercompany_entity_id,
          intercompanyEntityCode: row.intercompany_entity_code,
          segmentValues: {
            subaccount: combinationValue(row.subaccount_id, row.subaccount_code, row.subaccount_name),
            department: combinationValue(row.department_id, row.department_code, row.department_name),
            custom1: combinationValue(row.custom_1_id, row.custom_1_code, row.custom_1_name),
            custom2: combinationValue(row.custom_2_id, row.custom_2_code, row.custom_2_name),
            custom3: combinationValue(row.custom_3_id, row.custom_3_code, row.custom_3_name),
            custom4: combinationValue(row.custom_4_id, row.custom_4_code, row.custom_4_name),
            custom5: combinationValue(row.custom_5_id, row.custom_5_code, row.custom_5_name),
            custom6: combinationValue(row.custom_6_id, row.custom_6_code, row.custom_6_name),
            custom7: combinationValue(row.custom_7_id, row.custom_7_code, row.custom_7_name),
            custom8: combinationValue(row.custom_8_id, row.custom_8_code, row.custom_8_name),
          },
          canonicalKey: presentation.canonicalKey,
          displayKey: presentation.displayKey,
          active: row.active,
          used: row.used || row.last_used_at !== null,
          lastUsedAt: row.last_used_at,
        };
      });

    return {
      canManageSettings: writable && canManageSettings,
      canManageSegments: writable && canManageSegments,
      canManagePostingPolicy: writable && canManagePostingPolicy,
      requiresMfaStepUp: principal.sessionMode === "real" && !hasRecentStepUp(principal),
      currencies: currencyResult.rows.map((row) => ({
        code: row.code,
        minorUnits: row.minor_units,
        enabled: row.enabled,
        functional: row.functional,
      })),
      rates: rateResult.rows.map((row) => ({
        id: row.id,
        sourceCurrency: row.source_currency,
        targetCurrency: row.target_currency,
        rate: row.rate,
        effectiveAt: row.effective_at,
        source: row.source,
        createdAt: row.created_at,
      })),
      segments: segmentResult.rows.map((row) => ({
        id: row.id,
        key: row.key,
        displayName: row.display_name,
        state: row.state,
        required: row.required,
        visible: row.visible,
        protectedUseAt: row.protected_use_at,
        missingActiveCombinationCount: row.missing_active_combination_count,
        values: segmentValues.filter((value) => value.definitionKey === row.key),
      })),
      entities: entityResult.rows.map((row) => ({
        id: row.id,
        code: row.code,
        displayName: row.display_name,
        countryCode: row.country_code,
        regionCode: row.region_code,
        ledgerId: row.ledger_id,
        ledgerCode: row.ledger_code,
        functionalCurrency: row.functional_currency,
        accountingProfile: row.accounting_profile,
        firstPostedAt: row.first_posted_at,
        manualPostingMode: row.manual_posting_mode,
        postingPolicyVersion: row.posting_policy_version,
        accounts: accountResult.rows
          .filter((account) => account.ledger_id === row.ledger_id)
          .map((account) => ({
            id: account.id,
            code: account.code,
            displayName: account.display_name,
            accountClass: account.account_class,
          })),
      })),
      accountCombinations,
      taxPacks: taxPackResult.rows.map((row) => ({
        key: row.pack_key,
        version: row.version,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
      })),
      taxRegistrations,
    };
  });
}

function assertConfigurationMutationSession(principal: SessionPrincipal): void {
  if (principal.sessionMode === "demo") {
    if (!demoWritesEnabled()) {
      throw new OrganizationAdministrationError(
        "Demo changes are not available on this deployment.",
        403,
        "DEMO_WRITES_DISABLED",
      );
    }
    return;
  }
  if (!hasRecentStepUp(principal)) {
    throw new OrganizationAdministrationError(
      "Verify your authenticator code before changing accounting configuration.",
      428,
      "MFA_STEP_UP_REQUIRED",
    );
  }
}

async function mutateConfiguration<T>(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  reason: string;
  sourceSurface?: "API" | "MCP";
}>, work: Parameters<typeof withTenantTransaction<T>>[1]): Promise<T> {
  assertConfigurationMutationSession(input.principal);
  const context = mutationContext(input.principal, input.requestId, {
    reason: input.reason,
    sourceSurface: input.sourceSurface ?? "API",
  });
  assertTenantWritesEnabled(context);
  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    return work(client);
  });
}

export async function configureOrganizationCurrency(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
}> & z.output<typeof organizationCurrencyConfigurationSchema>) {
  return mutateConfiguration(input, async (client) => {
    const result = await client.query<{ enabled: boolean }>(
      "SELECT app.accounting_set_currency_enabled($1,$2) AS enabled",
      [input.currencyCode, input.enabled],
    );
    return { enabled: result.rows[0]?.enabled ?? input.enabled };
  });
}

export async function recordCurrencyRate(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
}> & z.output<typeof currencyRateConfigurationSchema>) {
  return mutateConfiguration(input, async (client) => {
    const result = await client.query<{ id: string }>(
      "SELECT app.accounting_add_currency_rate($1,$2,$3::numeric,$4::timestamptz,$5) AS id",
      [input.sourceCurrency, input.targetCurrency, input.rate, input.effectiveAt, input.source],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Exchange rate was not recorded");
    return { id };
  });
}

export async function configureTaxRegistration(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
}> & z.output<typeof taxRegistrationConfigurationSchema>) {
  return mutateConfiguration(input, async (client) => {
    const registrationId = randomUUID();
    const activeKey = await loadActiveOrganizationKey(client, input.principal.organizationId);
    try {
      const encryptedReference = encryptField(input.registrationReference, activeKey.dek, {
        organizationId: input.principal.organizationId,
        table: "entity_tax_registrations",
        column: "registration_ciphertext",
        recordId: registrationId,
        keyVersion: activeKey.keyVersion,
      });
      const result = await client.query<{ id: string }>(
        `SELECT app.accounting_add_tax_registration(
           $1::uuid,$2::uuid,$3,$4,$5::integer,$6,$7,$8,$9,$10,$11::date,$12::date
         ) AS id`,
        [
          registrationId,
          input.legalEntityId,
          input.regimeKey,
          serializeEncryptedField(encryptedReference),
          activeKey.keyVersion,
          input.destinationCountry,
          input.destinationRegion,
          input.destinationCity,
          input.locationCode,
          input.configurationEvidence,
          input.validFrom,
          input.validTo,
        ],
      );
      const id = result.rows[0]?.id;
      if (id !== registrationId) throw new Error("Tax registration was not recorded");
      return { id };
    } finally {
      activeKey.dek.fill(0);
    }
  });
}

export async function configureSegment(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
}> & z.output<typeof segmentConfigurationSchema>) {
  return mutateConfiguration(input, async (client) => {
    const result = await client.query<{ key: string; state: string }>(
      `SELECT (configuration).key, (configuration).state
       FROM (
         SELECT app.accounting_configure_segment($1,$2,$3,$4,$5) AS configuration
       ) configured`,
      [input.key, input.displayName, input.visible, input.required, input.action],
    );
    if (!result.rows[0]) throw new Error("Segment configuration was not updated");
    return result.rows[0];
  });
}

export async function addSegmentValue(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
}> & z.output<typeof segmentValueConfigurationSchema>) {
  return mutateConfiguration(input, async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT (created).id
       FROM (
         SELECT app.accounting_add_segment_value($1,$2,$3,$4::date,$5::date) AS created
       ) mutation`,
      [input.definitionKey, input.code, input.displayName, input.validFrom, input.validTo],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Segment value was not created");
    return { id };
  });
}

export async function createAccountCombination(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
}> & z.output<typeof accountCombinationConfigurationSchema>) {
  return mutateConfiguration(input, async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT (created).id
       FROM (
         SELECT app.accounting_create_account_combination(
           $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,
           $7::uuid,$8::uuid,$9::uuid,$10::uuid,$11::uuid,$12::uuid,
           $13::uuid,$14::uuid,$15::uuid
         ) AS created
       ) mutation`,
      [
        input.legalEntityId,
        input.ledgerId,
        input.accountId,
        input.subaccountId,
        input.departmentId,
        input.intercompanyEntityId,
        input.custom1Id,
        input.custom2Id,
        input.custom3Id,
        input.custom4Id,
        input.custom5Id,
        input.custom6Id,
        input.custom7Id,
        input.custom8Id,
        input.replacesCombinationId,
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Account combination was not created");
    return { id };
  });
}

export async function createLegalEntity(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
}> & z.output<typeof legalEntityConfigurationSchema>) {
  return mutateConfiguration(input, async (client) => {
    const result = await client.query<{ legal_entity_id: string; ledger_id: string }>(
      "SELECT * FROM app.accounting_create_legal_entity($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        input.code,
        input.displayName,
        input.countryCode,
        input.regionCode,
        input.functionalCurrency,
        input.accountingProfile,
        input.fiscalYear,
        input.manualPostingMode,
      ],
    );
    const entity = result.rows[0];
    if (!entity) throw new Error("Legal entity was not created");
    return { legalEntityId: entity.legal_entity_id, ledgerId: entity.ledger_id };
  });
}

export async function createFiscalPeriods(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  sourceSurface?: "API" | "MCP";
}> & z.output<typeof fiscalPeriodCreationSchema>): Promise<FiscalPeriodCreationResult> {
  const businessRequestId = `period-create:${createCommandFingerprint(
    "ledger.fiscal-periods.idempotency-key",
    {
      organizationId: input.principal.organizationId,
      idempotencyKey: input.idempotencyKey,
    },
  )}`;
  const commandHash = createCommandFingerprint("ledger.fiscal-periods.create", {
    ledgerId: input.ledgerId,
    fiscalYear: input.fiscalYear,
    periodPattern: input.periodPattern,
    initialState: input.initialState,
    reason: input.reason,
  });

  return mutateConfiguration({
    principal: input.principal,
    requestId: businessRequestId,
    reason: input.reason,
    sourceSurface: input.sourceSurface,
  }, async (client) => {
    const result = await client.query<{ result: unknown }>(
      `SELECT app.accounting_create_fiscal_periods(
         $1::uuid,$2::integer,$3::text,$4::period_state,$5::text
       ) AS result`,
      [
        input.ledgerId,
        input.fiscalYear,
        input.periodPattern,
        input.initialState,
        commandHash,
      ],
    );
    const created = result.rows[0]?.result;
    if (!created) throw new Error("Fiscal periods were not created");
    return fiscalPeriodCreationResultSchema.parse(created);
  });
}
