import { describe, expect, it } from "vitest";
import { sumExact } from "@/kernel/money";
import {
  demoClosePackages,
  demoCurrentActor,
  demoDashboard,
  demoEntityDetails,
  demoJournalDetails,
  demoJournals,
  demoPartyDetails,
  demoPayableBills,
  demoReceivableInvoices,
  demoSearchIndex,
  demoTaxExceptions,
  demoTrialBalanceRows,
  demoWriteState,
} from "@/modules/demo/dashboard-data";

describe("demo data contract", () => {
  it("balances each entity and currency independently", () => {
    for (const entity of demoEntityDetails) {
      const rows = demoTrialBalanceRows.filter((row) => row.entityCode === entity.code);
      const currencies = new Set(rows.map((row) => row.currency));
      const debit = sumExact(rows.map((row) => row.debit));
      const credit = sumExact(rows.map((row) => row.credit));

      expect(rows.length).toBeGreaterThan(0);
      expect(currencies).toEqual(new Set([entity.currency]));
      expect(debit.equals(credit)).toBe(true);
      expect(debit.toFixed(2)).toBe(entity.trialBalanceAmount);
    }
  });

  it("provides a balanced detail for every journal summary", () => {
    expect(new Set(demoJournalDetails.map((journal) => journal.id))).toEqual(
      new Set(demoJournals.map((journal) => journal.id)),
    );

    for (const journal of demoJournalDetails) {
      const debit = sumExact(journal.lines.map((line) => line.debitFunctional));
      const credit = sumExact(journal.lines.map((line) => line.creditFunctional));

      expect(journal.lines.length).toBeGreaterThanOrEqual(2);
      expect(debit.equals(credit), journal.id).toBe(true);
      expect(new Set(journal.lines.map((line) => line.transactionCurrency))).toEqual(
        new Set([journal.currency]),
      );
    }
  });

  it("reconciles demo subledger balances and all referenced parties", () => {
    const partyIds = new Set(demoPartyDetails.map((party) => party.id));

    for (const entity of demoEntityDetails) {
      const receivables = sumExact(
        demoReceivableInvoices
          .filter((invoice) => invoice.entityCode === entity.code)
          .map((invoice) => invoice.openAmount),
      );
      const payables = sumExact(
        demoPayableBills
          .filter((bill) => bill.entityCode === entity.code)
          .map((bill) => bill.openAmount),
      );

      expect(receivables.toFixed(2)).toBe(entity.openReceivablesAmount);
      expect(payables.toFixed(2)).toBe(entity.openPayablesAmount);
    }

    for (const invoice of demoReceivableInvoices) {
      expect(partyIds.has(invoice.customerPartyId), invoice.number).toBe(true);
    }
    for (const bill of demoPayableBills) {
      expect(partyIds.has(bill.supplierPartyId), bill.number).toBe(true);
    }
  });

  it("contains exactly two explicit close-blocking manual tax reviews", () => {
    expect(demoTaxExceptions).toHaveLength(2);
    expect(demoTaxExceptions.map((exception) => exception.status)).toEqual([
      "MANUAL_REVIEW_REQUIRED",
      "MANUAL_REVIEW_REQUIRED",
    ]);
    expect(demoTaxExceptions.every((exception) => exception.blocksClose)).toBe(true);

    for (const exception of demoTaxExceptions) {
      const closePackage = demoClosePackages.find(
        (candidate) => candidate.entityCode === exception.entityCode,
      );
      expect(closePackage?.blockers.some((blocker) => blocker.key === exception.id)).toBe(true);
    }
  });

  it("is honest, read-only, serializable demo state", () => {
    expect(demoCurrentActor).toMatchObject({
      displayName: "Demo viewer",
      initials: "DV",
      role: "VIEWER_AUDITOR",
      permissions: [],
      demoOnly: true,
    });
    expect(demoWriteState).toMatchObject({
      mode: "READ_ONLY_DEMO",
      writesEnabled: false,
      persistentWrites: false,
    });
    expect(demoSearchIndex.every((entry) => entry.href.startsWith("/"))).toBe(true);
    expect(demoSearchIndex.some((entry) => entry.href.startsWith("#"))).toBe(false);

    const roundTrip = JSON.parse(JSON.stringify(demoDashboard)) as typeof demoDashboard;
    expect(roundTrip.organization.slug).toBe("northstar-demo");
    expect(roundTrip.writeState.writesEnabled).toBe(false);
    expect(roundTrip.searchIndex).toHaveLength(demoSearchIndex.length);
  });
});
