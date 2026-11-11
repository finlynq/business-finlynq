import { businessDocumentMatchesMetadata } from "@/modules/document-storage/source-metadata";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildBusinessDocumentSnapshot, assertSnapshotTaxDecisionsCurrent } from "@/modules/subledger/document-model";
import { buildIssueJournalLines } from "@/modules/subledger/journal-line-builders";
import { businessDocumentLineDraftsFromSnapshot } from "@/app/_components/ar-ap-workspace.client";
import { creditApplicationCarrying } from "@/modules/subledger/supplier-credit-application";
import type { LockedOpenItemRow } from "@/modules/subledger/ar-ap-types";
const input = {
  kind: "SUPPLIER_CREDIT_NOTE" as const, sourceNumber: "CREDIT-SYNTHETIC", ledgerId: randomUUID(), legalEntityId: randomUUID(),
  partyAccountId: randomUUID(), controlAccountCombinationId: randomUUID(), taxAccountCombinationId: randomUUID(),
  documentDate: "2026-11-11", accountingDate: "2026-11-11", periodId: randomUUID(), dueOn: "2026-11-11", currency: "CAD",
  fx: { rate: "1", source: "FUNCTIONAL", effectiveAt: "2026-11-11T00:00:00Z" }, description: "Synthetic supplier credit",
  lines: [{ description: "Credited service", accountCombinationId: randomUUID(), netAmount: "100.00",
    tax: { packKey: "ca.on.hst", category: "STANDARD" as const, destinationCountry: "CA", destinationRegion: "ON", registrationId: randomUUID(), recoverablePercent: "100" } }],
};
describe("supplier credit-note accounting", () => {
  it("stores reversing purchase tax facts and posts AP, expense and recoverable tax on the correct sides", () => {
    const snapshot = buildBusinessDocumentSnapshot(input, "CAD");
    expect(snapshot).toMatchObject({ grossTotal: "-113.00", grossFunctional: "-113.00", taxTotal: "-13.00" });
    expect(snapshot.lines[0].taxDecision.facts.taxableBasis).toBe("-100.00");
    expect(() => assertSnapshotTaxDecisionsCurrent(snapshot)).not.toThrow();
    const lines = buildIssueJournalLines(snapshot, randomUUID(), new Map([[1, randomUUID()]]));
    expect(lines.map(line => [line.debitFunctional, line.creditFunctional])).toEqual([["113.00", "0"], ["0", "100.00"], ["0", "13.00"]]);
    expect(input.lines[0].netAmount).toBe("100.00");
    expect(businessDocumentLineDraftsFromSnapshot(snapshot)[0]).toMatchObject({ netAmount: "100.00", recoverablePercent: "100" });
  });
  it("reverses reviewed source-tax rounding and converts the saved snapshot back to positive entry amounts", () => {
    const snapshot = buildBusinessDocumentSnapshot({ ...input, lines: [{ ...input.lines[0], tax: { ...input.lines[0].tax,
      sourceTaxRounding: { amount: "13.01", reason: "Synthetic rounding evidence", evidenceReference: "credit.pdf", reviewed: true } } }] }, "CAD");
    expect(snapshot.taxTotal).toBe("-13.01");
    expect(() => assertSnapshotTaxDecisionsCurrent(snapshot)).not.toThrow();
    expect(businessDocumentLineDraftsFromSnapshot(snapshot)[0].sourceTaxAmount).toBe("13.01");
  });
  it("rejects negative credit entry and preserves rejection of a net-negative supplier bill", () => {
    expect(() => buildBusinessDocumentSnapshot({ ...input, lines: [{ ...input.lines[0], netAmount: "-100.00" }] }, "CAD")).toThrow(/positive credit/);
    expect(() => buildBusinessDocumentSnapshot({ ...input, kind: "SUPPLIER_BILL", lines: [{ ...input.lines[0], netAmount: "-100.00", lineType: "ADJUSTMENT" }] }, "CAD")).toThrow(/net supplier credit/);
  });
  it("matches positive or signed credit-note source totals without accepting the wrong document type or amount", () => {
    const snapshot = buildBusinessDocumentSnapshot(input, "CAD");
    const metadata = { documentType: "CREDIT_NOTE", documentDate: input.documentDate, currency: "CAD", total: "113.00" };
    expect(businessDocumentMatchesMetadata(snapshot, metadata)).toBe(true);
    expect(businessDocumentMatchesMetadata(snapshot, { ...metadata, total: "-113.00" })).toBe(true);
    expect(businessDocumentMatchesMetadata(snapshot, { ...metadata, documentType: "PURCHASE_INVOICE" })).toBe(false);
    expect(businessDocumentMatchesMetadata(snapshot, { ...metadata, total: "112.00" })).toBe(false);
  });
  it("uses the exact remaining carrying balance on a final partial application and rejects over-application", () => {
    const item: LockedOpenItemRow = { id: randomUUID(), ledger_id: input.ledgerId, party_account_id: input.partyAccountId,
      transaction_currency: "USD", original_transaction_amount: "3.00", original_functional_amount: "4.00",
      allocated_transaction_amount: "2.00", allocated_carrying_amount: "2.67", source_type: "payables.supplier-credit-note",
      control_account_combination_id: input.controlAccountCombinationId, source_accounting_date: input.accountingDate,
      source_fx_source: "SYNTHETIC", source_fx_effective_at: input.fx.effectiveAt, void_event_id: null };
    expect(creditApplicationCarrying(item, "1.00", "CAD").carryingFunctionalAmount).toBe("1.33");
    expect(() => creditApplicationCarrying(item, "1.01", "CAD")).toThrow(/exceed/);
  });
});
