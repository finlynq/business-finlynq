import "server-only";

import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { exact, isQuantizedMoney, minorUnits, quantizeMoney } from "@/kernel/money";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";
import { assertPermission, withoutContext } from "./ar-ap-access";
import { assertRoutineSetup, loadAccountingSetup, loadAccountCombinations } from "./ar-ap-accounting";
import { acquireDocumentIdentityLock, acquireIdempotencyLock, assertIdempotentSource,
  currentSourceDocument, findSourceByIdempotency, subledgerCommandFingerprints, subledgerOperationKey } from "./ar-ap-idempotency";
import { appendSourceDocument, insertAndPostJournal, insertSettlementAllocations,
  insertSubledgerEvent, lockSettlementOpenItems, recordFromRow, settlementReplayResult } from "./ar-ap-persistence";
import { recordSettlementSchema, settlementDocumentSnapshotSchema } from "./document-model";
import { transactionLine } from "./journal-line-builders";
import type { CalculatedSettlementAllocation, LockedOpenItemRow, SettlementResult } from "./ar-ap-types";

export const applySupplierCreditSchema = z.object(recordSettlementSchema.shape).pick({
  sourceNumber: true, ledgerId: true, legalEntityId: true, partyAccountId: true,
  controlAccountCombinationId: true, periodId: true, accountingDate: true, currency: true,
  realizedFxGainAccountCombinationId: true, realizedFxLossAccountCombinationId: true,
  description: true, idempotencyKey: true,
}).extend({
  kind: z.literal("SUPPLIER_CREDIT_APPLICATION").default("SUPPLIER_CREDIT_APPLICATION"),
  creditOpenItemId: z.uuid(), billOpenItemId: z.uuid(),
  amount: recordSettlementSchema.shape.amount,
}).strict();

/** Consume the remaining carrying balance on the final application, including rounding. */
export function creditApplicationCarrying(item: LockedOpenItemRow, amount: string, functionalCurrency: string): CalculatedSettlementAllocation {
  const remaining = exact(item.original_transaction_amount).minus(item.allocated_transaction_amount);
  const remainingCarrying = exact(item.original_functional_amount).minus(item.allocated_carrying_amount);
  if (!exact(amount).greaterThan(0) || exact(amount).greaterThan(remaining) || !remainingCarrying.greaterThan(0)) {
    throw new Error("Credit application would exceed the current bill or credit balance");
  }
  const carrying = exact(amount).equals(remaining) ? remainingCarrying
    : quantizeMoney(exact(amount).times(item.original_functional_amount).div(item.original_transaction_amount), functionalCurrency);
  const rate = carrying.div(amount).toDecimalPlaces(18);
  if (!carrying.greaterThan(0) || !quantizeMoney(exact(amount).times(rate), functionalCurrency).equals(carrying)) {
    throw new Error("Credit application carrying amount cannot be represented at ledger precision");
  }
  if (!item.source_fx_effective_at) throw new Error("Credit application requires immutable carrying FX evidence");
  return {
    openItemId: item.id, transactionAmount: amount,
    carryingFunctionalAmount: carrying.toFixed(minorUnits(functionalCurrency)),
    settlementFunctionalAmount: carrying.toFixed(minorUnits(functionalCurrency)),
    realizedFxFunctional: "0", carryingFxRate: rate.toFixed(),
    carryingFxSource: item.source_fx_source ?? "OPEN_ITEM_CARRYING_SNAPSHOT",
    carryingFxEffectiveAt: item.source_fx_effective_at,
  };
}

export async function applySupplierCredit(unparsed: { context: TenantTransactionContext } & z.input<typeof applySupplierCreditSchema>): Promise<SettlementResult> {
  assertTenantWritesEnabled(unparsed.context);
  const command = applySupplierCreditSchema.parse(withoutContext(unparsed));
  if (!isQuantizedMoney(command.amount, command.currency)) throw new Error("Credit application exceeds currency precision");
  const key = subledgerOperationKey("payables", "credit-application", command.idempotencyKey);
  const fingerprints = subledgerCommandFingerprints("payables", "settlement", command);
  const sourceType = "payables.supplier-credit-application";
  return withTenantTransaction(unparsed.context, async (client) => {
    await assertWritableOrganization(client, unparsed.context);
    await assertPermission(client, unparsed.context, PERMISSIONS.settlePayables);
    await assertPermission(client, unparsed.context, PERMISSIONS.postJournal);
    await acquireIdempotencyLock(client, unparsed.context.organizationId, key);
    const replay = await findSourceByIdempotency(client, unparsed.context.organizationId, key);
    if (replay) { assertIdempotentSource(replay, fingerprints, "POSTED"); return settlementReplayResult(client, replay); }
    await acquireDocumentIdentityLock(client, unparsed.context.organizationId, sourceType, command.sourceNumber);
    if (await currentSourceDocument(client, unparsed.context.organizationId, sourceType, command.sourceNumber, false)) {
      throw new Error("Credit application source number already exists");
    }
    const setup = await loadAccountingSetup(client, { organizationId: unparsed.context.organizationId, ...command });
    assertRoutineSetup(setup, { accountingDate: command.accountingDate, currency: command.currency, partyRole: "SUPPLIER" });
    await loadAccountCombinations(client, { organizationId: unparsed.context.organizationId, ...command, references: [
      { field: "controlAccountCombinationId", combinationId: command.controlAccountCombinationId,
        expectedAccountId: setup.control_account_id, expectedControlKinds: ["AP"] },
      { field: "realizedFxGainAccountCombinationId", combinationId: command.realizedFxGainAccountCombinationId,
        expectedControlKinds: ["NONE"], expectedAccountClasses: ["REVENUE"] },
      { field: "realizedFxLossAccountCombinationId", combinationId: command.realizedFxLossAccountCombinationId,
        expectedControlKinds: ["NONE"], expectedAccountClasses: ["EXPENSE"] },
    ] });
    const items = await lockSettlementOpenItems(client, { organizationId: unparsed.context.organizationId,
      ids: [command.creditOpenItemId, command.billOpenItemId] });
    const credit = items.get(command.creditOpenItemId);
    const bill = items.get(command.billOpenItemId);
    for (const [item, type] of [[credit, "payables.supplier-credit-note"], [bill, "payables.supplier-bill"]] as const) {
      if (!item || item.source_type !== type || item.void_event_id !== null
        || item.ledger_id !== command.ledgerId || item.party_account_id !== command.partyAccountId
        || item.transaction_currency !== command.currency || item.control_account_combination_id !== command.controlAccountCombinationId
        || !item.source_accounting_date || item.source_accounting_date > command.accountingDate) {
        throw new Error("Credit and bill must be posted, eligible items for the same supplier, ledger, currency and AP control, dated on or before application");
      }
    }
    const creditAllocation = creditApplicationCarrying(credit!, command.amount, setup.functional_currency);
    const billAllocation = creditApplicationCarrying(bill!, command.amount, setup.functional_currency);
    const allocations = [creditAllocation, billAllocation];
    const snapshot = settlementDocumentSnapshotSchema.parse({
      schemaVersion: 1, ...Object.fromEntries(Object.entries(command).filter(([key]) => !["idempotencyKey", "billOpenItemId"].includes(key))), ownerModule: "payables", sourceType,
      functionalCurrency: setup.functional_currency, settlementDate: command.accountingDate,
      settlementFunctionalAmount: creditAllocation.carryingFunctionalAmount,
      fx: { rate: creditAllocation.carryingFxRate, source: "SUPPLIER_CREDIT_CARRYING",
        effectiveAt: creditAllocation.carryingFxEffectiveAt, quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" },
      fxRoundingAccountCombinationId: null,
      allocations: allocations.map(({ openItemId, transactionAmount, carryingFunctionalAmount,
        settlementFunctionalAmount, realizedFxFunctional, carryingFxRate }) => ({ openItemId, transactionAmount,
        carryingFunctionalAmount, settlementFunctionalAmount, realizedFxFunctional, carryingFxRate })),
    });
    const source = await appendSourceDocument(client, { context: unparsed.context, ownerModule: "payables", sourceType,
      sourceNumber: command.sourceNumber, legalEntityId: command.legalEntityId, version: 1, status: "POSTED",
      snapshot, idempotencyKey: key, commandHash: fingerprints.current });
    const eventId = await insertSubledgerEvent(client, { context: unparsed.context, ledgerId: command.ledgerId,
      partyAccountId: command.partyAccountId, sourceDocumentId: source.id, eventType: "SUPPLIER_CREDIT_APPLIED", eventVersion: "1" });
    const allocationIds = await insertSettlementAllocations(client, { context: unparsed.context, sourceDocumentId: source.id,
      snapshot, allocations, baseIdempotencyKey: key, commandHash: fingerprints.current });
    const controlLine = (allocation: CalculatedSettlementAllocation, side: "DEBIT" | "CREDIT") => transactionLine({
      side, accountCombinationId: command.controlAccountCombinationId, transactionAmount: command.amount,
      transactionCurrency: command.currency, functionalCurrency: setup.functional_currency,
      functionalAmount: allocation.carryingFunctionalAmount, fxRate: allocation.carryingFxRate,
      fxRateSource: allocation.carryingFxSource, fxRateEffectiveAt: allocation.carryingFxEffectiveAt,
      partyAccountId: command.partyAccountId, subledgerEventId: eventId, memo: command.description,
    });
    const lines = [controlLine(billAllocation, "DEBIT"), controlLine(creditAllocation, "CREDIT")];
    const gain = exact(billAllocation.carryingFunctionalAmount).minus(creditAllocation.carryingFunctionalAmount);
    if (!gain.isZero()) lines.push(transactionLine({ side: gain.isPositive() ? "CREDIT" : "DEBIT",
      accountCombinationId: gain.isPositive() ? command.realizedFxGainAccountCombinationId : command.realizedFxLossAccountCombinationId,
      transactionAmount: gain.abs(), transactionCurrency: setup.functional_currency, functionalCurrency: setup.functional_currency,
      fxRate: "1", fxRateSource: "SYSTEM_REALIZED_FX", fxRateEffectiveAt: command.accountingDate + "T00:00:00Z",
      memo: command.description + " realized FX" }));
    const journal = await insertAndPostJournal(client, { context: unparsed.context, ledgerId: command.ledgerId,
      legalEntityId: command.legalEntityId, periodId: command.periodId, journalTypeKey: sourceType, ownerModule: "payables",
      sourceDocumentId: source.id, sourceEventKey: `${sourceType}:${source.id}:applied`, idempotencyKey: key,
      commandHash: fingerprints.current, purpose: "ROUTINE", accountingDate: command.accountingDate,
      functionalCurrency: setup.functional_currency, description: command.description, lines });
    return { document: recordFromRow(source), idempotentReplay: false, journalId: journal.journalId,
      journalNumber: journal.journalNumber, subledgerEventId: eventId, allocationIds };
  });
}
