import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rows = new Map<string, readonly unknown[]>();
  function queryKey(sql: string): string {
    if (sql.includes("FROM organization_memberships membership")) return "membership";
    if (sql.includes("FROM legal_entities entity") && sql.includes("ledger.kind = 'PRIMARY'")) return "entities";
    if (sql.includes("FROM fiscal_periods period")) return "periods";
    if (sql.includes("FROM account_combinations combination")) return "accounts";
    if (sql.includes("FROM party_accounts account") && sql.includes("display_name_ciphertext")) return "partyAccounts";
    if (sql.includes("FROM entity_tax_registrations registration")) return "tax";
    if (sql.includes("FROM currency_definitions")) return "currencies";
    if (sql.includes("FROM source_documents current")) return "documents";
    if (sql.includes("FROM open_item_balances balance")) return "openItems";
    throw new Error(`Unexpected workspace query: ${sql}`);
  }
  const client = {
    query: vi.fn(async (sql: string) => ({ rows: [...(rows.get(queryKey(sql)) ?? [])] })),
  };
  return { rows, client };
});

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: async (_context: unknown, work: (client: typeof mocks.client) => Promise<unknown>) => work(mocks.client),
}));
vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: vi.fn(async () => true),
}));
vi.mock("@/modules/identity/session", () => ({
  transactionAuthMethod: vi.fn(() => "demo-link"),
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  principalCanWrite: vi.fn(() => true),
}));
vi.mock("@/security/organization-encryption", () => ({
  parseEncryptedField: vi.fn((value: string) => value),
  decryptField: vi.fn(() => "Harbour Dental Group"),
}));
vi.mock("@/security/organization-key-store", () => ({
  loadActiveOrganizationKey: vi.fn(async () => ({ dek: Buffer.alloc(32), keyVersion: 1 })),
}));

import { buildBusinessDocumentSnapshot } from "@/modules/subledger/document-model";
import { loadSubledgerWorkspace } from "@/modules/subledger/workspace";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  membership: "10000000-0000-4000-8000-000000000003",
  session: "10000000-0000-4000-8000-000000000004",
  entity: "10000000-0000-4000-8000-000000000005",
  ledger: "10000000-0000-4000-8000-000000000006",
  period: "10000000-0000-4000-8000-000000000007",
  party: "10000000-0000-4000-8000-000000000008",
  partyAccount: "10000000-0000-4000-8000-000000000009",
  control: "10000000-0000-4000-8000-000000000010",
  revenue: "10000000-0000-4000-8000-000000000011",
  expense: "10000000-0000-4000-8000-000000000012",
  tax: "10000000-0000-4000-8000-000000000013",
  cash: "10000000-0000-4000-8000-000000000014",
  registration: "10000000-0000-4000-8000-000000000015",
  document: "10000000-0000-4000-8000-000000000016",
  journal: "10000000-0000-4000-8000-000000000017",
  openItem: "10000000-0000-4000-8000-000000000018",
};

const principal = {
  sessionId: ids.session,
  userId: ids.user,
  organizationId: ids.organization,
  membershipId: ids.membership,
  organizationName: "Writable demo",
  roleLabel: "Demo accountant",
  displayName: "Demo viewer",
  initials: "DV",
  sessionMode: "demo" as const,
  authMethod: "DEMO_LINK" as const,
  expiresAt: new Date("2026-08-27T22:00:00Z"),
  mfaVerifiedAt: null,
  stepUpExpiresAt: null,
};

beforeEach(() => {
  mocks.rows.clear();
  mocks.client.query.mockClear();
  const snapshot = buildBusinessDocumentSnapshot({
    kind: "SALES_INVOICE",
    sourceNumber: "INV-1001",
    ledgerId: ids.ledger,
    legalEntityId: ids.entity,
    partyAccountId: ids.partyAccount,
    controlAccountCombinationId: ids.control,
    taxAccountCombinationId: ids.tax,
    documentDate: "2026-08-27",
    accountingDate: "2026-08-27",
    periodId: ids.period,
    dueOn: "2026-09-26",
    currency: "CAD",
    fx: {
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: "2026-08-27T12:00:00.000Z",
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
    },
    description: "Implementation services",
    lines: [{
      description: "Implementation services",
      accountCombinationId: ids.revenue,
      netAmount: "100.00",
      tax: {
        packKey: "ca.on.hst",
        category: "STANDARD",
        destinationCountry: "CA",
        destinationRegion: "ON",
        registrationId: ids.registration,
      },
    }],
  }, "CAD");

  mocks.rows.set("membership", [{ is_demo: true }]);
  mocks.rows.set("entities", [{
    id: ids.entity,
    code: "CA01",
    display_name: "Northstar Canada",
    country_code: "CA",
    region_code: "ON",
    ledger_id: ids.ledger,
    functional_currency: "CAD",
  }]);
  mocks.rows.set("periods", [{
    id: ids.period,
    ledger_id: ids.ledger,
    label: "August 2026",
    starts_on: "2026-08-01",
    ends_on: "2026-08-31",
  }]);
  mocks.rows.set("accounts", [
    { legal_entity_id: ids.entity, combination_id: ids.revenue, code: "4100", display_name: "Service revenue", account_class: "REVENUE" },
    { legal_entity_id: ids.entity, combination_id: ids.expense, code: "6100", display_name: "Operating expense", account_class: "EXPENSE" },
    { legal_entity_id: ids.entity, combination_id: ids.tax, code: "2200", display_name: "Tax payable", account_class: "LIABILITY" },
    { legal_entity_id: ids.entity, combination_id: ids.cash, code: "1000", display_name: "Cash", account_class: "ASSET" },
  ]);
  mocks.rows.set("partyAccounts", [{
    id: ids.partyAccount,
    legal_entity_id: ids.entity,
    party_id: ids.party,
    party_number: "P-000184",
    display_name_ciphertext: "encrypted",
    display_name_key_version: 1,
    account_number: "C-CA-0001",
    transaction_currency: "CAD",
    control_combination_id: ids.control,
  }]);
  mocks.rows.set("tax", [{
    legal_entity_id: ids.entity,
    registration_id: ids.registration,
    regime_key: "ca.on.hst",
    effective_from: "2016-07-01",
    effective_to: null,
  }]);
  mocks.rows.set("currencies", [{ code: "CAD", minor_units: 2 }, { code: "USD", minor_units: 2 }]);
  mocks.rows.set("documents", [{
    id: ids.document,
    source_type: "receivables.sales-invoice",
    source_number: "INV-1001",
    version: 2,
    status: "POSTED",
    snapshot,
    created_at: "2026-08-27T12:00:00.000Z",
    void_reason: null,
    journal_id: ids.journal,
    journal_number: 18,
    open_item_id: ids.openItem,
    open_amount: "113.000000000",
    open_status: "OPEN",
  }]);
  mocks.rows.set("openItems", [{
    id: ids.openItem,
    source_number: "INV-1001",
    party_account_id: ids.partyAccount,
    entity_code: "CA01",
    ledger_id: ids.ledger,
    transaction_currency: "CAD",
    original_amount: "113.000000000",
    open_amount: "113.000000000",
    carrying_functional_amount: "113.000000000",
    due_on: "2026-09-26",
    derived_status: "OPEN",
  }]);
});

describe("AR/AP tenant workspace loader", () => {
  it("returns decrypted parties, persisted current documents, derived balances, and valid AR mappings", async () => {
    const workspace = await loadSubledgerWorkspace(principal, "receivables");

    expect(workspace).toMatchObject({
      ownerModule: "receivables",
      businessKind: "SALES_INVOICE",
      settlementKind: "CUSTOMER_RECEIPT",
      demoOnly: true,
      canManage: true,
      canPost: true,
      canSettle: true,
      canVoid: true,
    });
    expect(workspace.entities[0]?.partyAccounts[0]?.partyName).toBe("Harbour Dental Group");
    expect(workspace.entities[0]?.lineAccounts.map((account) => account.code)).toEqual(["4100"]);
    expect(workspace.entities[0]?.taxAccounts.map((account) => account.code)).toEqual(["2200"]);
    expect(workspace.documents[0]).toMatchObject({
      sourceNumber: "INV-1001",
      version: 2,
      status: "POSTED",
      journalNumber: 18,
      openAmount: "113.000000000",
      partyName: "Harbour Dental Group",
    });
    expect(workspace.openItems[0]).toMatchObject({
      sourceNumber: "INV-1001",
      openAmount: "113.000000000",
      status: "OPEN",
    });
  });

  it("filters the current register without hiding allocation candidates", async () => {
    const workspace = await loadSubledgerWorkspace(principal, "receivables", "does-not-match");
    expect(workspace.documents).toEqual([]);
    expect(workspace.openItems).toHaveLength(1);
  });
});
