import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  assertPermission: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: async (
    _context: unknown,
    work: (client: Readonly<{ query: typeof mocks.query }>) => Promise<unknown>,
  ) => work({ query: mocks.query }),
}));

vi.mock("@/modules/subledger/ar-ap-access", () => ({
  assertPermission: mocks.assertPermission,
  permissionForOwner: vi.fn(() => "payables.read"),
}));

import { listPayableOpenItems } from "@/modules/subledger/ar-ap-open-items";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  entity: "20000000-0000-4000-8000-000000000001",
  ledger: "20000000-0000-4000-8000-000000000002",
  partyAccount: "20000000-0000-4000-8000-000000000003",
  document: "20000000-0000-4000-8000-000000000004",
  openItem: "20000000-0000-4000-8000-000000000005",
  controlCombination: "20000000-0000-4000-8000-000000000006",
};

const context = {
  organizationId: ids.organization,
  actorId: ids.actor,
  requestId: "list-payable-open-items",
  authMethod: "password+mfa",
  sourceSurface: "MCP" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ rows: [] });
});

describe("payable open-item lookup", () => {
  it("returns settlement-safe identifiers and exact remaining amounts", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      open_item_id: ids.openItem,
      source_number: "BILL-928028",
      source_document_id: ids.document,
      source_document_version: 2,
      document_status: "POSTED",
      legal_entity_id: ids.entity,
      ledger_id: ids.ledger,
      party_account_id: ids.partyAccount,
      control_account_combination_id: ids.controlCombination,
      currency: "CAD",
      original_amount: "226.500000000",
      allocated_amount: "100.000000000",
      remaining_amount: "126.500000000",
      document_date: "2025-02-01",
      due_date: "2025-03-03",
      settlement_status: "PARTIALLY_SETTLED",
    }] });

    await expect(listPayableOpenItems({
      context,
      legalEntityId: ids.entity,
      ledgerId: ids.ledger,
      partyAccountId: ids.partyAccount,
      sourceDocumentId: ids.document,
      sourceNumber: " bill-928028 ",
      currency: "cad",
      statuses: ["PARTIALLY_SETTLED"],
      asOfDate: "2025-12-31",
      limit: 20,
    })).resolves.toEqual([{
      openItemId: ids.openItem,
      sourceNumber: "BILL-928028",
      sourceDocumentId: ids.document,
      sourceDocumentVersion: 2,
      documentStatus: "POSTED",
      legalEntityId: ids.entity,
      ledgerId: ids.ledger,
      partyAccountId: ids.partyAccount,
      controlAccountCombinationId: ids.controlCombination,
      currency: "CAD",
      originalAmount: "226.500000000",
      allocatedAmount: "100.000000000",
      remainingAmount: "126.500000000",
      documentDate: "2025-02-01",
      dueDate: "2025-03-03",
      settlementStatus: "PARTIALLY_SETTLED",
    }]);

    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), context, "payables.read");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("item.organization_id = $1");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("current_source.id = $5::uuid OR issued_source.id = $5::uuid");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("selected.effective_on <= $8::date");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("void_event.effective_on <= $8::date");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("issued_source.snapshot->>'accountingDate'");
    expect(mocks.query.mock.calls[0]?.[0]).not.toContain("item.created_at::date <= $8::date");
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      ids.organization,
      ids.entity,
      ids.ledger,
      ids.partyAccount,
      ids.document,
      "BILL-928028",
      "CAD",
      "2025-12-31",
      ["PARTIALLY_SETTLED"],
      20,
    ]);
  });

  it("excludes settled and reversed items by default", async () => {
    await listPayableOpenItems({ context });

    expect(mocks.query.mock.calls[0]?.[1]?.[8]).toEqual(["OPEN", "PARTIALLY_SETTLED"]);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("settlement_status = ANY($9::text[])");
  });
});
