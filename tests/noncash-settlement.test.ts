import { describe, expect, it } from "vitest";
import { recordSettlementSchema, settlementDocumentSnapshotSchema } from "@/modules/subledger/document-model";
import { normalizeSettlementFunding, resolveSettlementFunding, settlementMethodSchema } from "@/modules/subledger/settlement-funding";
import { assertSettlementMappings } from "@/modules/subledger/ar-ap-accounting";
import { buildSettlementJournalLines, buildSettlementSnapshot, calculateSettlementAllocations } from "@/modules/subledger/ar-ap-line-building";
import { subledgerCommandFingerprints } from "@/modules/subledger/ar-ap-idempotency";
import type { AccountCombinationRow, AccountingSetup, LockedOpenItemRow } from "@/modules/subledger/ar-ap-types";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = {
  kind: "SUPPLIER_PAYMENT" as const, sourceNumber: "PAID-PERSONALLY",
  ledgerId: id(1), legalEntityId: id(2), partyAccountId: id(3),
  controlAccountCombinationId: id(4), periodId: id(5),
  accountingDate: "2026-08-27", settlementDate: "2026-08-27",
  currency: "CAD", amount: "158.20",
  fx: { rate: "1", source: "FUNCTIONAL", effectiveAt: "2026-08-27T12:00:00Z" },
  settlementAccountCombinationId: id(6), settlementMethod: "SHAREHOLDER_ADVANCE" as const,
  realizedFxGainAccountCombinationId: id(7), realizedFxLossAccountCombinationId: id(8),
  description: "Supplier invoice paid personally by shareholder",
  allocations: [{ openItemId: id(9), transactionAmount: "158.20" }],
  idempotencyKey: "personal-payment-1",
};
const setup: AccountingSetup = { functional_currency: "CAD", period_state: "OPEN",
  starts_on: "2026-08-01", ends_on: "2026-08-31", party_role: "SUPPLIER",
  control_account_id: id(10), party_currency: null };
function mappings(fundingClass: AccountCombinationRow["account_class"] = "LIABILITY", controlKind: AccountCombinationRow["control_kind"] = "NONE") {
  return new Map<string, AccountCombinationRow>([
    [id(4), { id: id(4), account_id: id(10), account_class: "LIABILITY", control_kind: "AP" }],
    [id(6), { id: id(6), account_id: id(11), account_class: fundingClass, control_kind: controlKind }],
    [id(7), { id: id(7), account_id: id(12), account_class: "REVENUE", control_kind: "NONE" }],
    [id(8), { id: id(8), account_id: id(13), account_class: "EXPENSE", control_kind: "NONE" }],
  ]);
}
const item: LockedOpenItemRow = { id: id(9), ledger_id: id(1), party_account_id: id(3),
  transaction_currency: "CAD", original_transaction_amount: "158.20", original_functional_amount: "158.20",
  allocated_transaction_amount: "0", allocated_carrying_amount: "0", source_type: "payables.supplier-bill",
  source_fx_source: "FUNCTIONAL", source_fx_effective_at: "2026-08-27T12:00:00Z", void_event_id: null };

describe("non-cash supplier funding", () => {
  it.each(settlementMethodSchema.options.filter(method => method !== "BANK"))("accepts a non-control liability for %s", (settlementMethod) => {
    const command = recordSettlementSchema.parse({ ...base, settlementMethod });
    expect(() => assertSettlementMappings(command, setup, mappings())).not.toThrow();
  });
  it("credits shareholder liability and debits exact AP without a bank line", () => {
    const command = recordSettlementSchema.parse(base);
    const allocations = calculateSettlementAllocations(command, new Map([[id(9), item]]), "CAD");
    const snapshot = buildSettlementSnapshot(command, "CAD", allocations);
    expect(snapshot.settlementMethod).toBe("SHAREHOLDER_ADVANCE");
    expect(snapshot.bankAccountCombinationId).toBeUndefined();
    const lines = buildSettlementJournalLines(snapshot, allocations, id(14));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountCombinationId: id(6), debitFunctional: "0", creditFunctional: "158.20" });
    expect(lines[1]).toMatchObject({ accountCombinationId: id(4), debitFunctional: "158.20", creditFunctional: "0", partyAccountId: id(3), subledgerEventId: id(14) });
  });
  it("ties FX provenance as-of date to the settlement date", () => {
    const command = recordSettlementSchema.parse({
      ...base,
      currency: "USD",
      amount: "50.00",
      fx: { ...base.fx, rate: "1.35", source: "Bank of Canada Valet API daily exchange rates" },
      allocations: [{ openItemId: id(9), transactionAmount: "50.00" }],
    });
    const allocations = calculateSettlementAllocations(command, new Map([[id(9), {
      ...item,
      transaction_currency: "USD",
      original_transaction_amount: "100.00",
      original_functional_amount: "130.00",
    }]]), "CAD");
    const historical = buildSettlementSnapshot(command, "CAD", allocations);
    const providerSnapshot = {
      ...historical,
      fx: {
        ...historical.fx,
        effectiveAt: "2026-08-26T00:00:00.000Z",
        provenance: {
          mode: "PROVIDER_RATE" as const,
          asOfDate: "2026-08-27",
          resolvedAt: "2026-08-27T13:00:00.000Z",
          policyKey: "BANK_OF_CANADA_DAILY_REFERENCE_RATE",
          policyVersion: 2,
          providerKey: "BANK_OF_CANADA" as const,
          providerSymbol: "FXUSDCAD",
          providerSourceCurrency: "USD",
          providerTargetCurrency: "CAD",
          providerObservedAt: "2026-08-26T00:00:00.000Z",
          providerRetrievedAt: "2026-08-27T12:00:00.000Z",
          providerResponseSha256: "d".repeat(64),
          providerMaxLookbackDays: 7,
          providerCalculation: "DIRECT_TO_CAD" as const,
          providerFormula: "CAD_PER_SOURCE_UNIT" as const,
          providerLegs: [{
            currency: "USD",
            rate: "1.35",
            rateConvention: "CAD_PER_CURRENCY_UNIT" as const,
            observedDate: "2026-08-26",
            seriesKey: "FXUSDCAD",
          }],
        },
      },
    };
    expect(settlementDocumentSnapshotSchema.parse(providerSnapshot)).toEqual(providerSnapshot);
    expect(() => settlementDocumentSnapshotSchema.parse({
      ...providerSnapshot,
      settlementDate: "2026-08-28",
    })).toThrow(/as-of date must match/);
  });

  it("retains partial foreign-currency carrying value and realized FX", () => {
    const command = recordSettlementSchema.parse({ ...base, currency: "USD", amount: "50.00",
      fx: { ...base.fx, rate: "1.4", source: "BANK_RATE" },
      allocations: [{ openItemId: id(9), transactionAmount: "50.00" }] });
    const allocations = calculateSettlementAllocations(command, new Map([[id(9), { ...item,
      transaction_currency: "USD", original_transaction_amount: "100.00", original_functional_amount: "130.00" }]]), "CAD");
    expect(allocations[0]).toMatchObject({ carryingFunctionalAmount: "65.00", settlementFunctionalAmount: "70.00", realizedFxFunctional: "-5.00" });
    const lines = buildSettlementJournalLines(buildSettlementSnapshot(command, "CAD", allocations), allocations, id(14));
    expect(lines[0]).toMatchObject({ accountCombinationId: id(6), creditFunctional: "70.00" });
    expect(lines[1]).toMatchObject({ accountCombinationId: id(4), debitFunctional: "65.00" });
    expect(lines[2]).toMatchObject({ accountCombinationId: id(8), debitFunctional: "5.00" });
  });
  it.each(["ASSET", "EQUITY", "REVENUE", "EXPENSE"] as const)("rejects non-cash %s funding", (accountClass) => {
    expect(() => assertSettlementMappings(recordSettlementSchema.parse(base), setup, mappings(accountClass))).toThrow(/non-control liability/);
  });
  it.each(["AR", "AP"] as const)("rejects %s control funding", (kind) => {
    expect(() => assertSettlementMappings(recordSettlementSchema.parse(base), setup, mappings("LIABILITY", kind))).toThrow(/non-control liability/);
  });
  it("rejects an unavailable or cross-tenant funding ID", () => {
    const accounts = mappings(); accounts.delete(id(6));
    expect(() => assertSettlementMappings(recordSettlementSchema.parse(base), setup, accounts)).toThrow();
  });
  it.each([
    { ...base, kind: "CUSTOMER_RECEIPT" },
    { ...base, bankAccountCombinationId: id(6) },
    { ...base, bankAccountCombinationId: id(20), settlementMethod: "BANK" },
    { ...base, settlementAccountCombinationId: undefined },
    { ...base, settlementMethod: "ARBITRARY" },
  ])("rejects incompatible or ambiguous funding commands", (command) => {
    expect(recordSettlementSchema.safeParse(command).success).toBe(false);
  });
  it("keeps old and new BANK inputs fingerprint-equivalent and old snapshots unchanged", () => {
    const { settlementMethod: _method, settlementAccountCombinationId: _account, ...legacy } = base;
    void _method; void _account;
    const oldCommand = recordSettlementSchema.parse({ ...legacy, bankAccountCombinationId: id(6) });
    const newCommand = normalizeSettlementFunding(recordSettlementSchema.parse({ ...base, settlementMethod: "BANK" }));
    expect(newCommand).toEqual(oldCommand);
    expect(subledgerCommandFingerprints("payables", "settlement", newCommand))
      .toEqual(subledgerCommandFingerprints("payables", "settlement", oldCommand));
    expect(() => assertSettlementMappings(oldCommand, setup, mappings("ASSET"))).not.toThrow();
    expect(() => assertSettlementMappings(oldCommand, setup, mappings("LIABILITY"))).toThrow(/asset/);
    const allocations = calculateSettlementAllocations(oldCommand, new Map([[id(9), item]]), "CAD");
    const snapshot = buildSettlementSnapshot(oldCommand, "CAD", allocations);
    expect(snapshot.settlementMethod).toBeUndefined();
    expect(snapshot.settlementAccountCombinationId).toBeUndefined();
    expect(settlementDocumentSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(resolveSettlementFunding(snapshot).method).toBe("BANK");
  });
});
