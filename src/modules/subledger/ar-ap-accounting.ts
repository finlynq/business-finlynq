import type { PoolClient } from "pg";
import { z } from "zod";
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

export async function loadAccountCombinations(
  client: PoolClient,
  input: Readonly<{
    organizationId: string;
    ledgerId: string;
    legalEntityId: string;
    accountingDate: string;
    ids: readonly string[];
  }>,
): Promise<Map<string, AccountCombinationRow>> {
  const uniqueIds = [...new Set(input.ids)];
  const result = await client.query<AccountCombinationRow>(
    `SELECT combination.id, account.id AS account_id,
       account.class AS account_class, account.control_kind
     FROM account_combinations combination
     JOIN gl_accounts account
       ON account.organization_id = combination.organization_id
      AND account.ledger_id = combination.ledger_id
      AND account.id = combination.account_id
     WHERE combination.organization_id = $1
       AND combination.ledger_id = $2
       AND combination.entity_id = $3
       AND combination.id = ANY($4::uuid[])
       AND combination.active AND account.active AND account.postable
       AND account.valid_from <= $5::date
       AND (account.valid_to IS NULL OR account.valid_to >= $5::date)`,
    [
      input.organizationId,
      input.ledgerId,
      input.legalEntityId,
      uniqueIds,
      input.accountingDate,
    ],
  );
  if (result.rows.length !== uniqueIds.length) {
    throw new Error("One or more account combinations are inactive, out of date, or outside the tenant ledger");
  }
  return new Map(result.rows.map((row) => [row.id, row]));
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
  const combinationIds = [
    snapshot.controlAccountCombinationId,
    ...snapshot.lines.map((line) => line.accountCombinationId),
    ...(snapshot.taxAccountCombinationId ? [snapshot.taxAccountCombinationId] : []),
    ...(snapshot.fxRoundingAccountCombinationId ? [snapshot.fxRoundingAccountCombinationId] : []),
  ];
  const combinations = await loadAccountCombinations(client, {
    organizationId: context.organizationId,
    ledgerId: snapshot.ledgerId,
    legalEntityId: snapshot.legalEntityId,
    accountingDate: snapshot.accountingDate,
    ids: combinationIds,
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
  const bank = combinations.get(command.bankAccountCombinationId);
  if (!bank || bank.control_kind !== "NONE" || bank.account_class !== "ASSET") {
    throw new Error("Settlement bank mapping requires a non-control asset account");
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
