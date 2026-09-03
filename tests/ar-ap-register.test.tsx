import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  SubledgerWorkspaceDocumentDto,
  SubledgerWorkspaceDto,
} from "@/modules/subledger/workspace";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { ArApWorkspace, DocumentDetails } from "@/app/_components/ar-ap-workspace.client";
import { filterSubledgerDocuments } from "@/modules/subledger/register-filter";

function invoice(overrides: Partial<SubledgerWorkspaceDocumentDto> = {}): SubledgerWorkspaceDocumentDto {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    sourceNumber: "INV-1001",
    sourceType: "receivables.sales-invoice",
    version: 1,
    status: "POSTED",
    snapshot: {
      kind: "SALES_INVOICE",
      currency: "CAD",
      description: "Implementation services",
      documentDate: "2026-08-01",
      dueOn: "2026-08-20",
      grossTotal: "113.00",
      taxTotal: "13.00",
      partyAccountId: "20000000-0000-4000-8000-000000000001",
    } as SubledgerWorkspaceDocumentDto["snapshot"],
    createdAt: "2026-08-01T12:00:00.000Z",
    voidReason: null,
    partyName: "Harbour Dental Group",
    entityCode: "CA01",
    journalId: "30000000-0000-4000-8000-000000000001",
    journalNumber: 42,
    openItemId: "40000000-0000-4000-8000-000000000001",
    openAmount: "113.00",
    openStatus: "OPEN",
    ...overrides,
  };
}

function receipt(): SubledgerWorkspaceDocumentDto {
  return {
    ...invoice(),
    id: "10000000-0000-4000-8000-000000000002",
    sourceNumber: "RCPT-1001",
    sourceType: "receivables.customer-receipt",
    snapshot: {
      kind: "CUSTOMER_RECEIPT",
      currency: "USD",
      description: "Customer payment",
      settlementDate: "2026-08-27",
      amount: "50.00",
      allocations: [{ openItemId: "40000000-0000-4000-8000-000000000001" }],
      partyAccountId: "20000000-0000-4000-8000-000000000001",
    } as SubledgerWorkspaceDocumentDto["snapshot"],
    partyName: "Rainier Creative Studio",
    entityCode: "US01",
    openItemId: null,
    openAmount: null,
    openStatus: null,
  };
}

const allFilter = {
  search: "",
  entityCode: "",
  status: "",
  currency: "",
  dateFrom: "",
  dateTo: "",
  due: "ALL" as const,
};

describe("scalable AR/AP transaction register", () => {
  it("combines text, entity, status, currency, date, and due-state filters", () => {
    const documents = [invoice(), receipt()];
    expect(filterSubledgerDocuments(documents, {
      ...allFilter,
      search: "Harbour",
      entityCode: "CA01",
      status: "POSTED",
      currency: "CAD",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      due: "OVERDUE",
    }, "2026-08-27").map((document) => document.sourceNumber)).toEqual(["INV-1001"]);

    expect(filterSubledgerDocuments(documents, {
      ...allFilter,
      due: "NOT_APPLICABLE",
    }, "2026-08-27").map((document) => document.sourceNumber)).toEqual(["RCPT-1001"]);
  });

  it("renders a semantic table and visible register filters instead of transaction cards", () => {
    const workspace = {
      ownerModule: "receivables",
      businessKind: "SALES_INVOICE",
      settlementKind: "CUSTOMER_RECEIPT",
      demoOnly: true,
      canRead: true,
      canManage: true,
      canPost: true,
      canSettle: true,
      canVoid: true,
      currentDate: "2026-08-27",
      currencies: [{ code: "CAD", minorUnits: 2 }, { code: "USD", minorUnits: 2 }],
      entities: [{
        id: "50000000-0000-4000-8000-000000000001",
        code: "CA01",
        displayName: "Northstar Canada",
        countryCode: "CA",
        regionCode: "ON",
        ledgerId: "50000000-0000-4000-8000-000000000002",
        functionalCurrency: "CAD",
        periods: [],
        partyAccounts: [],
        lineAccounts: [],
        taxAccounts: [],
        bankAccounts: [],
        liabilitySettlementAccounts: [],
        fxGainAccounts: [],
        fxLossAccounts: [],
        roundingAccounts: [],
        tax: {
          packKey: "ca.on.hst",
          registrationReference: null,
          destinationCountry: "CA",
          destinationRegion: "ON",
          destinationCity: null,
          locationCode: null,
          effectiveFrom: null,
          effectiveTo: null,
        },
      }],
      documents: [
        invoice(),
        invoice({
          id: "10000000-0000-4000-8000-000000000003",
          sourceNumber: "INV-UNNUMBERED",
          journalId: "30000000-0000-4000-8000-000000000003",
          journalNumber: null,
        }),
      ],
      openItems: [],
    } as unknown as SubledgerWorkspaceDto;

    const markup = renderToStaticMarkup(<ArApWorkspace workspace={workspace} />);
    expect(markup).toContain("Transaction register");
    expect(markup).toContain("Number or customer");
    expect(markup).toContain("Legal entity");
    expect(markup).toContain("Document status");
    expect(markup).toContain("Currency");
    expect(markup).toContain("Date from");
    expect(markup).toContain("Date to");
    expect(markup).toContain("Due state");
    expect(markup).toContain("<table>");
    expect(markup).toContain("INV-1001");
    expect(markup).toContain("View details");
    expect(markup).toContain("View entry #42");
    expect(markup).toContain(">View entry</a>");
    expect(markup).not.toContain("View entry #</a>");
    expect(markup).not.toContain("Edit draft");
    expect(markup).toContain("/app/journals/30000000-0000-4000-8000-000000000001");
    expect(markup).not.toContain("<article");
  });

  it("keeps settled allocation details readable after an item leaves the open-item list", () => {
    const source = invoice();
    const settlement = receipt();
    const workspace = {
      ownerModule: "receivables",
      canManage: true,
      entities: [{
        id: "50000000-0000-4000-8000-000000000001",
        code: "CA01",
        displayName: "Northstar Canada",
        lineAccounts: [],
        taxAccounts: [],
        bankAccounts: [],
        liabilitySettlementAccounts: [],
        fxGainAccounts: [],
        fxLossAccounts: [],
        roundingAccounts: [],
        partyAccounts: [],
      }],
      documents: [source, settlement],
      openItems: [],
    } as unknown as SubledgerWorkspaceDto;
    const completeSettlement = {
      ...settlement,
      snapshot: {
        ...settlement.snapshot,
        legalEntityId: "50000000-0000-4000-8000-000000000001",
        functionalCurrency: "CAD",
        accountingDate: "2026-08-27",
        settlementFunctionalAmount: "67.50",
        bankAccountCombinationId: "60000000-0000-4000-8000-000000000001",
        fx: { rate: "1.35", source: "Manual", effectiveAt: "2026-08-27T12:00:00.000Z" },
        allocations: [{
          openItemId: source.openItemId,
          transactionAmount: "50.00",
          settlementFunctionalAmount: "67.50",
          realizedFxFunctional: "0.00",
        }],
      },
    } as SubledgerWorkspaceDocumentDto;

    const markup = renderToStaticMarkup(
      <DocumentDetails workspace={workspace} document={completeSettlement} onClose={vi.fn()} onEdit={vi.fn()} />,
    );
    expect(markup).toContain("INV-1001");
    expect(markup).not.toContain(source.openItemId);
  });
});
