import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  principal: {
    sessionMode: "real" as const,
  },
  detail: {
    id: "30000000-0000-4000-8000-000000000020",
    number: "41",
    accountingDate: "2026-08-20",
    entityCode: "US01",
    ledgerCode: "US01-PRIMARY",
    functionalCurrency: "USD",
    description: "Posted invoice",
    typeKey: "receivables.sales-invoice",
    typeLabel: "Sales invoice",
    ownerModule: "receivables",
    origin: "USER",
    purpose: "ROUTINE",
    status: "POSTED",
    sourceNumber: "INV-1001",
    sourceHref: "/app/receivables/invoices?q=INV-1001",
    debitFunctional: "113",
    creditFunctional: "113",
    postedAt: "2026-08-20T16:00:00.000Z",
    lines: [{
      id: "30000000-0000-4000-8000-000000000021",
      lineNumber: 1,
      accountCode: "1100",
      accountName: "Accounts receivable",
      canonicalKey: "US01.1100.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000.0000",
      displayKey: "US01.1100.0000.0000",
      displaySegments: [
        { key: "entity", displayName: "Entity", code: "US01" },
        { key: "account", displayName: "Account", code: "1100" },
        { key: "department", displayName: "Cost center", code: "0000" },
        { key: "intercompany", displayName: "Intercompany", code: "0000" },
      ],
      memo: "Invoice control",
      transactionCurrency: "CAD",
      debitTransaction: "150",
      creditTransaction: "0",
      fxRate: "0.753333333333333333",
      fxRateSource: "manual-spot",
      fxRateEffectiveAt: "2026-08-20T12:00:00.000Z",
      debitFunctional: "113",
      creditFunctional: "0",
    }],
  },
}));

vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("@/modules/workspace/access", () => ({
  requireWorkspacePrincipal: vi.fn(async () => mocks.principal),
}));
vi.mock("@/modules/ledger/tenant-workspace", () => ({
  loadTenantJournalDetail: vi.fn(async () => mocks.detail),
}));

import JournalDetailPage from "@/app/(workspace)/journals/[journalId]/page";

describe("journal detail page", () => {
  it("renders separate transaction and functional sides with source and FX provenance", async () => {
    const page = await JournalDetailPage({
      params: Promise.resolve({ journalId: mocks.detail.id }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Journal 41");
    expect(markup).toContain("Accounts receivable");
    expect(markup).toContain("US01.1100.0000.0000");
    expect(markup).toContain("Cost center: 0000");
    expect(markup).not.toContain("US01.1100.0000.0000.0000.0000.0000.0000");
    expect(markup).toContain("CAD 150.00");
    expect(markup).toContain("USD 113.00");
    expect(markup).toContain("manual-spot");
    expect(markup).toContain("/app/receivables/invoices?q=INV-1001");
    expect(markup.toLowerCase()).not.toContain(">delete<");
  });
});
