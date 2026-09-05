import type { PoolClient } from "pg";
import { z } from "zod";
import { resolveSettlementFunding } from "./settlement-funding";
import type { TenantTransactionContext } from "@/db/transaction";
import {
  DOCUMENT_KIND_POLICY,
  recordSettlementSchema,
  SETTLEMENT_KIND_POLICY,
  type BusinessDocumentSnapshot,
} from "./document-model";
import type {
  AccountingSetup,
  AccountCombinationRow,
  EntityTaxRegistrationRow,
  TaxPackVersionRow,
} from "./ar-ap-types";
import {
  ACCOUNT_COMBINATION_REMEDIATION,
  AccountCombinationValidationError,
  type AccountCombinationFailure,
  type AccountCombinationFailureCode,
} from "./validation-errors";

export async function loadAccountingSetup(
  client: PoolClient,
  input: Readonly<{
    organizationId: string;
    ledgerId: string;
    legalEntityId: string;
    periodId: string;
    partyAccountId: string;
  }>,
): Promise<AccountingSetup> {
  const result = await client.query<AccountingSetup>(
    `SELECT ledger.functional_currency,
       period.state AS period_state, period.starts_on::text, period.ends_on::text,
       party_account.role AS party_role,
       party_account.control_account_id,
       party_account.transaction_currency AS party_currency
     FROM ledgers ledger
     JOIN legal_entities entity
       ON entity.organization_id = ledger.organization_id
      AND entity.id = ledger.legal_entity_id
      AND entity.id = $3 AND entity.active
     JOIN fiscal_periods period
       ON period.organization_id = ledger.organization_id
      AND period.ledger_id = ledger.id AND period.id = $4
     JOIN party_accounts party_account
       ON party_account.organization_id = ledger.organization_id
      AND party_account.ledger_id = ledger.id
      AND party_account.legal_entity_id = entity.id
      AND party_account.id = $5 AND party_account.active
     WHERE ledger.organization_id = $1 AND ledger.id = $2 AND ledger.active`,
    [
      input.organizationId,
      input.ledgerId,
      input.legalEntityId,
      input.periodId,
      input.partyAccountId,
    ],
  );
  const setup = result.rows[0];
  if (!setup) {
    throw new Error("Active ledger, entity, fiscal period, and party account configuration was not found");
  }
  return setup;
}

export function assertRoutineSetup(
  setup: AccountingSetup,
  input: Readonly<{
    accountingDate: string;
    currency: string;
    partyRole: "CUSTOMER" | "SUPPLIER";
  }>,
): void {
  if (setup.period_state !== "OPEN") {
    throw new Error("Routine AR/AP activity requires an open fiscal period");
  }
  if (input.accountingDate < setup.starts_on || input.accountingDate > setup.ends_on) {
    throw new Error("Accounting date is outside the selected fiscal period");
  }
  if (setup.party_role !== input.partyRole) {
    throw new Error(`The selected party account is not configured as ${input.partyRole.toLowerCase()}`);
  }
  if (setup.party_currency !== null && setup.party_currency !== input.currency) {
    throw new Error("Document currency does not match the party account currency restriction");
  }
}

type AccountCombinationDetailRow = Readonly<{
  id: string;
  ledger_id: string;
  entity_id: string;
  combination_active: boolean;
  account_id: string;
  account_code: string | null;
  account_name: string | null;
  account_active: boolean | null;
  account_postable: boolean | null;
  valid_from: string | null;
  valid_to: string | null;
  account_class: AccountCombinationRow["account_class"] | null;
  control_kind: AccountCombinationRow["control_kind"] | null;
}>;

export type AccountCombinationValidationReference = Readonly<{
  field: string;
  lineNumber?: number;
  combinationId: string;
  expectedAccountId?: string;
  expectedAccountClasses?: readonly AccountCombinationRow["account_class"][];
  expectedControlKinds?: readonly AccountCombinationRow["control_kind"][];
}>;

function accountCombinationFailure(
  reference: AccountCombinationValidationReference,
  row: AccountCombinationDetailRow | undefined,
  input: Readonly<{
    ledgerId: string;
    legalEntityId: string;
    accountingDate: string;
  }>,
): AccountCombinationFailure | null {
  const failureCodes: AccountCombinationFailureCode[] = [];
  if (!row) {
    failureCodes.push("NOT_FOUND_OR_UNAUTHORIZED");
  } else {
    if (row.ledger_id !== input.ledgerId) failureCodes.push("WRONG_LEDGER");
    if (row.entity_id !== input.legalEntityId) failureCodes.push("WRONG_ENTITY");
    if (!row.combination_active) failureCodes.push("COMBINATION_INACTIVE");
    if (row.account_active !== true) failureCodes.push("ACCOUNT_INACTIVE");
    if (row.account_postable !== true) failureCodes.push("ACCOUNT_NOT_POSTABLE");
    if (row.valid_from !== null && row.valid_from > input.accountingDate) {
      failureCodes.push("FUTURE_DATED");
    }
    if (row.valid_to !== null && row.valid_to < input.accountingDate) {
      failureCodes.push("EXPIRED");
    }
    if (reference.expectedControlKinds
        && (row.control_kind === null
          || !reference.expectedControlKinds.includes(row.control_kind))) {
      failureCodes.push("WRONG_CONTROL_KIND");
    }
    if (reference.expectedAccountClasses
        && (row.account_class === null
          || !reference.expectedAccountClasses.includes(row.account_class))) {
      failureCodes.push("WRONG_ACCOUNT_CLASS");
    }
    if (reference.expectedAccountId && row.account_id !== reference.expectedAccountId) {
      failureCodes.push("PARTY_CONTROL_ACCOUNT_MISMATCH");
    }
  }
  if (failureCodes.length === 0) return null;
  return {
    field: reference.field,
    ...(reference.lineNumber === undefined ? {} : { lineNumber: reference.lineNumber }),
    combinationId: reference.combinationId,
    accountCode: row?.account_code ?? null,
    accountName: row?.account_name ?? null,
    active: row ? row.combination_active && row.account_active === true : null,
    combinationActive: row?.combination_active ?? null,
    accountActive: row?.account_active ?? null,
    postable: row?.account_postable ?? null,
    validFrom: row?.valid_from ?? null,
    validTo: row?.valid_to ?? null,
    ledgerMismatch: row ? row.ledger_id !== input.ledgerId : null,
    entityMismatch: row ? row.entity_id !== input.legalEntityId : null,
    evaluatedAccountingDate: input.accountingDate,
    failureCodes,
    remediation: ACCOUNT_COMBINATION_REMEDIATION,
  };
}

export async function loadAccountCombinations(
  client: PoolClient,
  input: Readonly<{
    organizationId: string;
    ledgerId: string;
    legalEntityId: string;
    accountingDate: string;
    ids?: readonly string[];
    references?: readonly AccountCombinationValidationReference[];
  }>,
): Promise<Map<string, AccountCombinationRow>> {
  const references = input.references
    ?? (input.ids ?? []).map((combinationId) => ({
      field: "accountCombinationIds",
      combinationId,
    }));
  const uniqueIds = [...new Set(references.map((reference) => reference.combinationId))];
  const result = await client.query<AccountCombinationDetailRow>(
    `SELECT combination.id, combination.ledger_id, combination.entity_id,
       combination.active AS combination_active, combination.account_id,
       account.code AS account_code, account.display_name AS account_name,
       account.active AS account_active, account.postable AS account_postable,
       account.valid_from::text, account.valid_to::text,
       account.class AS account_class, account.control_kind
     FROM account_combinations combination
     LEFT JOIN gl_accounts account
       ON account.organization_id = combination.organization_id
      AND account.id = combination.account_id
     WHERE combination.organization_id = $1
       AND combination.id = ANY($2::uuid[])
     ORDER BY combination.id`,
    [input.organizationId, uniqueIds],
  );
  const detailById = new Map(result.rows.map((row) => [row.id, row]));
  const failures = references
    .map((reference) => accountCombinationFailure(reference, detailById.get(reference.combinationId), input))
    .filter((failure): failure is AccountCombinationFailure => failure !== null);
  if (failures.length > 0) throw new AccountCombinationValidationError(failures);
  return new Map(result.rows.map((row) => [row.id, {
    id: row.id,
    account_id: row.account_id,
    account_class: row.account_class!,
    control_kind: row.control_kind!,
  }]));
}

function assertBusinessAccountMappings(
  snapshot: BusinessDocumentSnapshot,
  setup: AccountingSetup,
  combinations: ReadonlyMap<string, AccountCombinationRow>,
): void {
  const policy = DOCUMENT_KIND_POLICY[snapshot.kind];
  const control = combinations.get(snapshot.controlAccountCombinationId);
  if (!control || control.account_id !== setup.control_account_id || control.control_kind !== policy.controlKind) {
    throw new Error("Control account combination does not match the party subledger account");
  }
  for (const line of snapshot.lines) {
    const combination = combinations.get(line.accountCombinationId);
    if (!combination || combination.control_kind !== "NONE") {
      throw new Error("Source lines cannot post directly to an AR or AP control account");
    }
    if (snapshot.kind === "SALES_INVOICE" && combination.account_class !== "REVENUE") {
      throw new Error("Sales-invoice source lines require revenue account combinations");
    }
    if (snapshot.kind === "SUPPLIER_BILL" &&
        combination.account_class !== "EXPENSE" && combination.account_class !== "ASSET") {
      throw new Error("Supplier-bill source lines require expense or asset account combinations");
    }
  }
  if (snapshot.taxAccountCombinationId !== null) {
    const tax = combinations.get(snapshot.taxAccountCombinationId);
    if (!tax || tax.control_kind !== "NONE") {
      throw new Error("Tax mapping cannot use an AR or AP control account");
    }
    if (snapshot.kind === "SALES_INVOICE" && tax.account_class !== "LIABILITY") {
      throw new Error("Sales tax payable mapping requires a liability account");
    }
    if (snapshot.kind === "SUPPLIER_BILL") {
      const treatments = new Set(snapshot.lines.flatMap((line) =>
        line.taxDecision.components.map((component) => component.treatment)));
      const hasRecoverableTax = treatments.has("RECOVERABLE");
      const hasSelfAssessedTax = treatments.has("SELF_ASSESSED_PAYABLE");
      if (hasRecoverableTax && hasSelfAssessedTax) {
        throw new Error(
          "A supplier bill cannot share one tax mapping between recoverable and self-assessed payable tax",
        );
      }
      if (hasSelfAssessedTax && tax.account_class !== "LIABILITY") {
        throw new Error("Self-assessed use tax requires a liability tax-payable account");
      }
      if (hasRecoverableTax && tax.account_class !== "ASSET" && tax.account_class !== "EXPENSE") {
        throw new Error("Recoverable purchase tax requires an asset or expense account");
      }
    }
  }
  if (snapshot.fxRoundingAccountCombinationId !== null &&
      combinations.get(snapshot.fxRoundingAccountCombinationId)?.control_kind !== "NONE") {
    throw new Error("FX rounding mapping cannot use an AR or AP control account");
  }
}

function optionalTaxFact(value: string | undefined): string | null {
  return value ?? null;
}

/**
 * Binds every supported tax decision to the immutable registration record that
 * supplied its jurisdiction facts. The entity registration configuration is
 * locked for the rest of the tenant transaction, including the final issue
 * transaction, so governed configuration mutations cannot race posting. This
 * uses the same per-regime advisory-lock identities as configuration mutation
 * and acquires them in lexical order to avoid cross-regime deadlocks. It does
 * not widen the runtime role's intentionally read-only table grant.
 *
 * The generic pack intentionally remains registration-optional: it is the
 * explicit manual/evidenced fallback for jurisdictions without an installed
 * automated pack. If a generic line does select a registration, that
 * reference is held to the same tenant, entity, sourcing, and validity checks.
 */
export async function assertBusinessDocumentTaxRegistrationBindings(
  client: PoolClient,
  context: TenantTransactionContext,
  snapshot: BusinessDocumentSnapshot,
): Promise<void> {
  const registrationIds = new Set<string>();
  const registrationRegimes = new Set<string>();

  for (const line of snapshot.lines) {
    const facts = line.taxDecision.facts;
    if (
      line.taxDecision.packKey !== line.tax.packKey
      || facts.taxPointDate !== snapshot.documentDate
      || facts.destinationCountry !== line.tax.destinationCountry
      || facts.destinationRegion !== line.tax.destinationRegion
      || optionalTaxFact(facts.destinationCity) !== optionalTaxFact(line.tax.destinationCity)
      || optionalTaxFact(facts.locationCode) !== optionalTaxFact(line.tax.locationCode)
      || optionalTaxFact(facts.registrationId) !== optionalTaxFact(line.tax.registrationId)
    ) {
      throw new Error(`Draft tax facts do not match source line ${line.lineNumber}`);
    }

    const registrationId = facts.registrationId;
    if (!registrationId && line.taxDecision.packKey === "generic.unsupported") continue;
    if (!registrationId) {
      throw new Error(`Tax registration is required for source line ${line.lineNumber}`);
    }
    if (!z.uuid().safeParse(registrationId).success) {
      throw new Error(`Tax registration reference is invalid for source line ${line.lineNumber}`);
    }
    registrationIds.add(registrationId);
    registrationRegimes.add(line.taxDecision.packKey.trim().toLowerCase());
  }

  if (registrationIds.size === 0) return;

  for (const regime of [...registrationRegimes].sort()) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${context.organizationId}|tax-registration|${snapshot.legalEntityId}|${regime}`],
    );
  }

  const result = await client.query<EntityTaxRegistrationRow>(
    `SELECT id, regime_key, destination_country, destination_region,
       destination_city, location_code, valid_from::text, valid_to::text
     FROM entity_tax_registrations
     WHERE organization_id = $1
       AND legal_entity_id = $2
       AND id = ANY($3::uuid[])
     ORDER BY id`,
    [context.organizationId, snapshot.legalEntityId, [...registrationIds].sort()],
  );
  const registrations = new Map(result.rows.map((row) => [row.id, row]));

  for (const line of snapshot.lines) {
    const facts = line.taxDecision.facts;
    if (!facts.registrationId) continue;
    const registration = registrations.get(facts.registrationId);
    if (!registration) {
      throw new Error(
        `Tax registration is missing or belongs to another organization or entity for source line ${line.lineNumber}`,
      );
    }
    if (registration.regime_key !== line.taxDecision.packKey) {
      throw new Error(`Tax registration pack does not match source line ${line.lineNumber}`);
    }
    if (
      registration.destination_country !== facts.destinationCountry
      || registration.destination_region !== facts.destinationRegion
      || registration.destination_city !== optionalTaxFact(facts.destinationCity)
      || registration.location_code !== optionalTaxFact(facts.locationCode)
    ) {
      throw new Error(`Tax registration destination does not match source line ${line.lineNumber}`);
    }
    if (
      snapshot.documentDate < registration.valid_from
      || (registration.valid_to !== null && snapshot.documentDate > registration.valid_to)
    ) {
      throw new Error(
        `Tax registration is not active on the document date for source line ${line.lineNumber}`,
      );
    }
  }
}

export async function validateDraftConfiguration(
  client: PoolClient,
  context: TenantTransactionContext,
  snapshot: BusinessDocumentSnapshot,
): Promise<AccountingSetup> {
  const policy = DOCUMENT_KIND_POLICY[snapshot.kind];
  const setup = await loadAccountingSetup(client, {
    organizationId: context.organizationId,
    ledgerId: snapshot.ledgerId,
    legalEntityId: snapshot.legalEntityId,
    periodId: snapshot.periodId,
    partyAccountId: snapshot.partyAccountId,
  });
  assertRoutineSetup(setup, {
    accountingDate: snapshot.accountingDate,
    currency: snapshot.currency,
    partyRole: policy.partyRole,
  });
  if (setup.functional_currency !== snapshot.functionalCurrency) {
    throw new Error("Document functional-currency snapshot does not match its ledger");
  }
  const taxTreatments = new Set(snapshot.lines.flatMap((line) =>
    line.taxDecision.components.map((component) => component.treatment)));
  const taxAccountClasses: readonly AccountCombinationRow["account_class"][] | undefined =
    snapshot.kind === "SALES_INVOICE"
      ? ["LIABILITY"]
      : taxTreatments.has("SELF_ASSESSED_PAYABLE")
        ? ["LIABILITY"]
        : taxTreatments.has("RECOVERABLE")
          ? ["ASSET", "EXPENSE"]
          : undefined;
  const references: AccountCombinationValidationReference[] = [
    {
      field: "controlAccountCombinationId",
      combinationId: snapshot.controlAccountCombinationId,
      expectedAccountId: setup.control_account_id,
      expectedControlKinds: [policy.controlKind],
    },
    ...snapshot.lines.map((line) => ({
      field: "lines[" + (line.lineNumber - 1) + "].accountCombinationId",
      lineNumber: line.lineNumber,
      combinationId: line.accountCombinationId,
      expectedControlKinds: ["NONE" as const],
      expectedAccountClasses: snapshot.kind === "SALES_INVOICE"
        ? ["REVENUE" as const]
        : ["EXPENSE" as const, "ASSET" as const],
    })),
    ...(snapshot.taxAccountCombinationId ? [{
      field: "taxAccountCombinationId",
      combinationId: snapshot.taxAccountCombinationId,
      expectedControlKinds: ["NONE" as const],
      ...(taxAccountClasses ? { expectedAccountClasses: taxAccountClasses } : {}),
    }] : []),
    ...(snapshot.fxRoundingAccountCombinationId ? [{
      field: "fxRoundingAccountCombinationId",
      combinationId: snapshot.fxRoundingAccountCombinationId,
      expectedControlKinds: ["NONE" as const],
    }] : []),
  ];
  const combinations = await loadAccountCombinations(client, {
    organizationId: context.organizationId,
    ledgerId: snapshot.ledgerId,
    legalEntityId: snapshot.legalEntityId,
    accountingDate: snapshot.accountingDate,
    references,
  });
  assertBusinessAccountMappings(snapshot, setup, combinations);
  await assertBusinessDocumentTaxRegistrationBindings(client, context, snapshot);
  await loadTaxPackVersions(client, snapshot);
  return setup;
}

export async function loadTaxPackVersions(
  client: PoolClient,
  snapshot: BusinessDocumentSnapshot,
): Promise<Map<string, TaxPackVersionRow>> {
  const identities = [...new Map(snapshot.lines.map((line) => [
    `${line.taxDecision.packKey}:${line.taxDecision.packVersion}`,
    { key: line.taxDecision.packKey, version: line.taxDecision.packVersion },
  ])).values()];
  const result = await client.query<TaxPackVersionRow>(
    `SELECT id, pack_key, version, effective_from::text, effective_to::text
     FROM tax_pack_versions
     WHERE (pack_key, version) IN (
       SELECT * FROM unnest($1::text[], $2::text[])
     )`,
    [identities.map((identity) => identity.key), identities.map((identity) => identity.version)],
  );
  const versions = new Map(result.rows.map((row) => [`${row.pack_key}:${row.version}`, row]));
  if (versions.size !== identities.length) {
    throw new Error("One or more approved tax-pack versions are not installed in the database");
  }
  for (const line of snapshot.lines) {
    const version = versions.get(`${line.taxDecision.packKey}:${line.taxDecision.packVersion}`);
    if (!version || snapshot.documentDate < version.effective_from ||
        (version.effective_to !== null && snapshot.documentDate > version.effective_to)) {
      throw new Error(`Tax pack is not approved for source line ${line.lineNumber} on the document date`);
    }
  }
  return versions;
}

export function assertSettlementMappings(
  command: z.infer<typeof recordSettlementSchema>,
  setup: AccountingSetup,
  combinations: ReadonlyMap<string, AccountCombinationRow>,
): void {
  const policy = SETTLEMENT_KIND_POLICY[command.kind];
  const control = combinations.get(command.controlAccountCombinationId);
  const expectedControlKind = policy.partyRole === "CUSTOMER" ? "AR" : "AP";
  if (!control || control.account_id !== setup.control_account_id ||
      control.control_kind !== expectedControlKind) {
    throw new Error("Settlement control account combination does not match the party account");
  }
  const funding = resolveSettlementFunding(command);
  const account = combinations.get(funding.accountCombinationId);
  if (!account || account.control_kind !== "NONE" || account.account_class !== funding.accountClass) {
    throw new Error(funding.method === "BANK"
      ? "Settlement bank mapping requires a non-control asset account"
      : `Settlement ${funding.method} mapping requires a non-control liability account`);
  }
  const gain = combinations.get(command.realizedFxGainAccountCombinationId);
  if (!gain || gain.control_kind !== "NONE" || gain.account_class !== "REVENUE") {
    throw new Error("Realized FX gain mapping requires a non-control revenue account");
  }
  const loss = combinations.get(command.realizedFxLossAccountCombinationId);
  if (!loss || loss.control_kind !== "NONE" || loss.account_class !== "EXPENSE") {
    throw new Error("Realized FX loss mapping requires a non-control expense account");
  }
  if (command.fxRoundingAccountCombinationId &&
      combinations.get(command.fxRoundingAccountCombinationId)?.control_kind !== "NONE") {
    throw new Error("Settlement rounding mapping cannot use an AR or AP control account");
  }
}
