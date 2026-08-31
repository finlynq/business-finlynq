import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const transactionMocks = vi.hoisted(() => ({
  assertActorHasActivePermission: vi.fn(async () => undefined),
  assertWritableOrganization: vi.fn(async () => undefined),
  postJournalInTransaction: vi.fn(async () => ({ journalNumber: 812 })),
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: transactionMocks.withTenantTransaction,
}));
vi.mock("@/modules/identity/authorization", () => ({
  assertActorHasActivePermission: transactionMocks.assertActorHasActivePermission,
}));
vi.mock("@/modules/ledger/posting-service", () => ({
  postJournalInTransaction: transactionMocks.postJournalInTransaction,
}));
vi.mock("@/modules/workspace/write-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/workspace/write-policy")>()),
  assertWritableOrganization: transactionMocks.assertWritableOrganization,
}));

import {
  assertBusinessDocumentTaxRegistrationBindings,
  buildIssueJournalLines,
  createBusinessDocumentDraft,
  issueBusinessDocument,
  recordCustomerReceiptOrSupplierPayment,
  subledgerOperationKey,
  voidIssuedBusinessDocument,
  voidSettlementAndReverseAllocations,
} from "@/modules/subledger/ar-ap-service";
import {
  buildBusinessDocumentSnapshot,
  canonicalHash,
} from "@/modules/subledger/document-model";

const previousWritesSetting = process.env.BUSINESS_WRITES_ENABLED;
const context = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000002",
  requestId: "ar-ap-service-unit",
  authMethod: "password+mfa",
  sourceSurface: "UI" as const,
};

const taxRegistrationId = "10000000-0000-4000-8000-000000000012";
const washingtonTaxRegistrationId = "10000000-0000-4000-8000-000000000013";

const settlement = {
  context,
  kind: "CUSTOMER_RECEIPT" as const,
  sourceNumber: "RCPT-1001",
  ledgerId: "10000000-0000-4000-8000-000000000003",
  legalEntityId: "10000000-0000-4000-8000-000000000004",
  partyAccountId: "10000000-0000-4000-8000-000000000005",
  controlAccountCombinationId: "10000000-0000-4000-8000-000000000006",
  periodId: "10000000-0000-4000-8000-000000000007",
  accountingDate: "2026-08-27",
  settlementDate: "2026-08-27",
  currency: "CAD",
  amount: "100.00",
  fx: {
    rate: "1",
    source: "FUNCTIONAL",
    effectiveAt: "2026-08-27T12:00:00.000Z",
    quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const,
  },
  bankAccountCombinationId: "10000000-0000-4000-8000-000000000008",
  realizedFxGainAccountCombinationId: "10000000-0000-4000-8000-000000000009",
  realizedFxLossAccountCombinationId: "10000000-0000-4000-8000-000000000010",
  description: "Customer receipt",
  allocations: [{
    openItemId: "10000000-0000-4000-8000-000000000011",
    transactionAmount: "100.00",
  }],
  idempotencyKey: "receipt-request-1",
};

function washingtonDocument(
  kind: "SALES_INVOICE" | "SUPPLIER_BILL",
  registrationId?: string,
) {
  return buildBusinessDocumentSnapshot({
    kind,
    sourceNumber: kind === "SALES_INVOICE" ? "INV-WA-1001" : "BILL-WA-1001",
    ledgerId: settlement.ledgerId,
    legalEntityId: settlement.legalEntityId,
    partyAccountId: settlement.partyAccountId,
    controlAccountCombinationId: settlement.controlAccountCombinationId,
    taxAccountCombinationId: settlement.realizedFxLossAccountCombinationId,
    documentDate: "2026-08-27",
    accountingDate: "2026-08-27",
    periodId: settlement.periodId,
    dueOn: "2026-09-26",
    currency: "USD",
    fx: {
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: "2026-08-27T12:00:00.000Z",
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
    },
    description: "Washington taxable services",
    lines: [{
      description: "Washington taxable services",
      accountCombinationId: settlement.realizedFxGainAccountCombinationId,
      netAmount: "100.00",
      tax: {
        packKey: "us.wa.sales-use",
        category: "STANDARD",
        destinationCountry: "US",
        destinationRegion: "WA",
        destinationCity: "Seattle",
        locationCode: "1726",
        ...(registrationId ? { registrationId } : {}),
      },
    }],
  }, "USD");
}

function ontarioDocument(registrationId?: string) {
  return buildBusinessDocumentSnapshot({
    kind: "SALES_INVOICE",
    sourceNumber: "INV-ON-1001",
    ledgerId: settlement.ledgerId,
    legalEntityId: settlement.legalEntityId,
    partyAccountId: settlement.partyAccountId,
    controlAccountCombinationId: settlement.controlAccountCombinationId,
    taxAccountCombinationId: settlement.realizedFxLossAccountCombinationId,
    documentDate: "2026-08-27",
    accountingDate: "2026-08-27",
    periodId: settlement.periodId,
    dueOn: "2026-09-26",
    currency: "CAD",
    fx: {
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: "2026-08-27T12:00:00.000Z",
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
    },
    description: "Ontario taxable services",
    lines: [{
      description: "Ontario taxable services",
      accountCombinationId: settlement.realizedFxGainAccountCombinationId,
      netAmount: "100.00",
      tax: {
        packKey: "ca.on.hst",
        category: "STANDARD",
        destinationCountry: "CA",
        destinationRegion: "ON",
        ...(registrationId ? { registrationId } : {}),
      },
    }],
  }, "CAD");
}

function registrationClient(rows: readonly Readonly<{
  id: string;
  regime_key: string;
  destination_country: string | null;
  destination_region: string | null;
  destination_city: string | null;
  location_code: string | null;
  valid_from: string;
  valid_to: string | null;
}>[]) {
  const query = vi.fn(async (statement: string) => ({
    rows: statement.includes("FROM entity_tax_registrations") ? rows : [],
  }));
  return { client: { query } as unknown as PoolClient, query };
}

const validOntarioRegistration = {
  id: taxRegistrationId,
  regime_key: "ca.on.hst",
  destination_country: "CA",
  destination_region: "ON",
  destination_city: null,
  location_code: null,
  valid_from: "2026-01-01",
  valid_to: null,
} as const;

const draftCommand = {
  context,
  kind: "SALES_INVOICE" as const,
  sourceNumber: "INV-ON-1001",
  ledgerId: settlement.ledgerId,
  legalEntityId: settlement.legalEntityId,
  partyAccountId: settlement.partyAccountId,
  controlAccountCombinationId: settlement.controlAccountCombinationId,
  taxAccountCombinationId: settlement.realizedFxLossAccountCombinationId,
  documentDate: "2026-08-27",
  accountingDate: "2026-08-27",
  periodId: settlement.periodId,
  dueOn: "2026-09-26",
  currency: "CAD",
  fx: settlement.fx,
  description: "Ontario taxable services",
  lines: [{
    description: "Ontario taxable services",
    accountCombinationId: settlement.realizedFxGainAccountCombinationId,
    netAmount: "100.00",
    tax: {
      packKey: "ca.on.hst",
      category: "STANDARD" as const,
      destinationCountry: "CA",
      destinationRegion: "ON",
    },
  }],
  idempotencyKey: "draft-create-legacy-1",
};

function legacyDraftFingerprint(): string {
  const { context: _context, ...command } = draftCommand;
  void _context;
  return canonicalHash({ operation: "draft-create", command });
}

function draftReplayRow(commandHash: string) {
  return {
    id: "10000000-0000-4000-8000-000000000014",
    organization_id: context.organizationId,
    legal_entity_id: draftCommand.legalEntityId,
    owner_module: "receivables",
    source_type: "receivables.sales-invoice",
    source_number: draftCommand.sourceNumber,
    version: 1,
    status: "DRAFT",
    snapshot: ontarioDocument(),
    content_hash: "legacy-content-hash",
    command_hash: commandHash,
    supersedes_source_document_id: null,
    void_reason: null,
    created_by: context.actorId,
    created_at: "2026-08-27T12:00:00.000Z",
  };
}

beforeEach(() => {
  process.env.BUSINESS_WRITES_ENABLED = "true";
  transactionMocks.withTenantTransaction.mockReset();
  transactionMocks.postJournalInTransaction.mockClear();
});

afterAll(() => {
  if (previousWritesSetting === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousWritesSetting;
});

describe("AR/AP service command boundary", () => {
  it("accepts the exact legacy AR draft fingerprint during replay transition", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM source_documents") && statement.includes("idempotency_key")) {
        return { rows: [draftReplayRow(legacyDraftFingerprint())] };
      }
      throw new Error(`Unexpected legacy AR replay SQL: ${statement}`);
    });
    transactionMocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(createBusinessDocumentDraft(draftCommand)).resolves.toMatchObject({
      idempotentReplay: true,
      document: {
        ownerModule: "receivables",
        sourceNumber: draftCommand.sourceNumber,
        status: "DRAFT",
      },
    });
  });

  it("rejects an AR draft replay with a conflicting fingerprint", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM source_documents") && statement.includes("idempotency_key")) {
        return { rows: [draftReplayRow("f".repeat(64))] };
      }
      throw new Error(`Unexpected conflicting AR replay SQL: ${statement}`);
    });
    transactionMocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    await expect(createBusinessDocumentDraft(draftCommand)).rejects.toThrow(
      "Idempotency key is already bound to a different subledger command",
    );
  });

  it("namespaces otherwise identical idempotency keys across AR and AP", () => {
    expect(subledgerOperationKey("receivables", "issue", "same-client-key")).not.toBe(
      subledgerOperationKey("payables", "issue", "same-client-key"),
    );
  });

  it("persists a multi-item settlement and its journal lines with one batch insert each", async () => {
    const secondOpenItemId = "10000000-0000-4000-8000-000000000014";
    const controlAccountId = "10000000-0000-4000-8000-000000000015";
    const batchedSettlement = {
      ...settlement,
      allocations: [
        { openItemId: settlement.allocations[0].openItemId, transactionAmount: "50.00" },
        { openItemId: secondOpenItemId, transactionAmount: "50.00" },
      ],
      idempotencyKey: "receipt-batch-1",
    };
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM source_documents") && statement.includes("idempotency_key")) {
        return { rows: [] };
      }
      if (statement.includes("FROM source_documents") && statement.includes("ORDER BY version DESC")) {
        return { rows: [] };
      }
      if (statement.includes("FROM ledgers ledger")) {
        return { rows: [{
          functional_currency: "CAD",
          period_state: "OPEN",
          starts_on: "2026-08-01",
          ends_on: "2026-08-31",
          party_role: "CUSTOMER",
          control_account_id: controlAccountId,
          party_currency: "CAD",
        }] };
      }
      if (statement.includes("FROM account_combinations combination")) {
        return { rows: [
          {
            id: batchedSettlement.controlAccountCombinationId,
            account_id: controlAccountId,
            account_class: "ASSET",
            control_kind: "AR",
          },
          {
            id: batchedSettlement.bankAccountCombinationId,
            account_id: "10000000-0000-4000-8000-000000000016",
            account_class: "ASSET",
            control_kind: "NONE",
          },
          {
            id: batchedSettlement.realizedFxGainAccountCombinationId,
            account_id: "10000000-0000-4000-8000-000000000017",
            account_class: "REVENUE",
            control_kind: "NONE",
          },
          {
            id: batchedSettlement.realizedFxLossAccountCombinationId,
            account_id: "10000000-0000-4000-8000-000000000018",
            account_class: "EXPENSE",
            control_kind: "NONE",
          },
        ] };
      }
      if (statement.includes("FROM open_items item")) {
        return { rows: batchedSettlement.allocations.map((allocation) => ({
          id: allocation.openItemId,
          ledger_id: batchedSettlement.ledgerId,
          party_account_id: batchedSettlement.partyAccountId,
          transaction_currency: "CAD",
          original_transaction_amount: "50.00",
          original_functional_amount: "50.00",
          allocated_transaction_amount: "0",
          allocated_carrying_amount: "0",
          source_type: "receivables.sales-invoice",
          source_fx_source: "FUNCTIONAL",
          source_fx_effective_at: "2026-08-27T12:00:00.000Z",
          void_event_id: null,
        })) };
      }
      if (statement.includes("INSERT INTO source_documents")) {
        return { rows: [{
          id: parameters?.[0],
          organization_id: parameters?.[1],
          legal_entity_id: parameters?.[2],
          owner_module: parameters?.[3],
          source_type: parameters?.[4],
          source_number: parameters?.[5],
          version: parameters?.[6],
          status: parameters?.[7],
          snapshot: JSON.parse(String(parameters?.[8])),
          content_hash: parameters?.[9],
          command_hash: parameters?.[11],
          supersedes_source_document_id: parameters?.[12],
          void_reason: parameters?.[14],
          created_by: parameters?.[13],
          created_at: "2026-08-27T12:00:00.000Z",
        }] };
      }
      if (statement.includes("INSERT INTO subledger_events")) {
        return { rows: [{ id: parameters?.[0] }] };
      }
      if (statement.includes("INSERT INTO document_settlement_allocations")) {
        return { rows: (parameters?.[9] as readonly string[]).map((id) => ({ id })) };
      }
      if (statement.includes("FROM journal_type_definitions")) {
        return { rows: [{ id: "10000000-0000-4000-8000-000000000019", version: 1 }] };
      }
      if (statement.includes("INSERT INTO journal_entries")) {
        return { rows: [{ id: parameters?.[0] }] };
      }
      if (statement.includes("INSERT INTO journal_lines")) return { rows: [] };
      throw new Error(`Unexpected batched settlement SQL: ${statement}`);
    });
    transactionMocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    const result = await recordCustomerReceiptOrSupplierPayment(batchedSettlement);

    const allocationInserts = query.mock.calls.filter(([statement]) => (
      statement.includes("INSERT INTO document_settlement_allocations")
    ));
    expect(allocationInserts).toHaveLength(1);
    expect(allocationInserts[0]?.[0]).toContain("FROM unnest(");
    expect(allocationInserts[0]?.[1]?.[10]).toEqual(
      batchedSettlement.allocations.map((allocation) => allocation.openItemId),
    );
    expect(allocationInserts[0]?.[1]?.[11]).toEqual(["50.00", "50.00"]);
    expect(allocationInserts[0]?.[1]?.[15]).toEqual([
      expect.stringMatching(/:1$/),
      expect.stringMatching(/:2$/),
    ]);
    expect(result.allocationIds).toEqual(allocationInserts[0]?.[1]?.[9]);

    const journalLineInserts = query.mock.calls.filter(([statement]) => (
      statement.includes("INSERT INTO journal_lines")
    ));
    expect(journalLineInserts).toHaveLength(1);
    expect(journalLineInserts[0]?.[0]).toContain("FROM unnest(");
    expect(journalLineInserts[0]?.[1]?.[4]).toEqual([1, 2, 3]);
    expect(journalLineInserts[0]?.[1]?.[5]).toEqual([
      batchedSettlement.bankAccountCombinationId,
      batchedSettlement.controlAccountCombinationId,
      batchedSettlement.controlAccountCombinationId,
    ]);
    expect(transactionMocks.postJournalInTransaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ idempotentReplay: false, journalNumber: 812 });
  });

  it("persists every issued-document tax decision in one batch and keeps its journal line linkage", async () => {
    const snapshot = buildBusinessDocumentSnapshot({
      kind: "SALES_INVOICE",
      sourceNumber: "INV-ON-BATCH-1",
      ledgerId: settlement.ledgerId,
      legalEntityId: settlement.legalEntityId,
      partyAccountId: settlement.partyAccountId,
      controlAccountCombinationId: settlement.controlAccountCombinationId,
      taxAccountCombinationId: settlement.realizedFxLossAccountCombinationId,
      documentDate: "2026-08-27",
      accountingDate: "2026-08-27",
      periodId: settlement.periodId,
      dueOn: "2026-09-26",
      currency: "CAD",
      fx: settlement.fx,
      description: "Ontario two-line invoice",
      lines: [
        {
          description: "Implementation",
          accountCombinationId: settlement.realizedFxGainAccountCombinationId,
          netAmount: "40.00",
          tax: {
            packKey: "ca.on.hst",
            category: "STANDARD",
            destinationCountry: "CA",
            destinationRegion: "ON",
            registrationId: taxRegistrationId,
          },
        },
        {
          description: "Support",
          accountCombinationId: settlement.realizedFxGainAccountCombinationId,
          netAmount: "60.00",
          tax: {
            packKey: "ca.on.hst",
            category: "STANDARD",
            destinationCountry: "CA",
            destinationRegion: "ON",
            registrationId: taxRegistrationId,
          },
        },
      ],
    }, "CAD");
    const draftRow = {
      id: "10000000-0000-4000-8000-000000000020",
      organization_id: context.organizationId,
      legal_entity_id: snapshot.legalEntityId,
      owner_module: "receivables",
      source_type: "receivables.sales-invoice",
      source_number: snapshot.sourceNumber,
      version: 1,
      status: "DRAFT",
      snapshot,
      content_hash: "draft-content-hash",
      command_hash: null,
      supersedes_source_document_id: null,
      void_reason: null,
      created_by: context.actorId,
      created_at: "2026-08-27T12:00:00.000Z",
    };
    const controlAccountId = "10000000-0000-4000-8000-000000000021";
    const packVersion = snapshot.lines[0]!.taxDecision;
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM source_documents") && statement.includes("idempotency_key")) {
        return { rows: [] };
      }
      if (statement.includes("FROM source_documents") && statement.includes("ORDER BY version DESC")) {
        return { rows: [draftRow] };
      }
      if (statement.includes("FROM ledgers ledger")) {
        return { rows: [{
          functional_currency: "CAD",
          period_state: "OPEN",
          starts_on: "2026-08-01",
          ends_on: "2026-08-31",
          party_role: "CUSTOMER",
          control_account_id: controlAccountId,
          party_currency: "CAD",
        }] };
      }
      if (statement.includes("FROM account_combinations combination")) {
        return { rows: [
          {
            id: snapshot.controlAccountCombinationId,
            account_id: controlAccountId,
            account_class: "ASSET",
            control_kind: "AR",
          },
          {
            id: snapshot.lines[0]!.accountCombinationId,
            account_id: "10000000-0000-4000-8000-000000000022",
            account_class: "REVENUE",
            control_kind: "NONE",
          },
          {
            id: snapshot.taxAccountCombinationId,
            account_id: "10000000-0000-4000-8000-000000000023",
            account_class: "LIABILITY",
            control_kind: "NONE",
          },
        ] };
      }
      if (statement.includes("FROM entity_tax_registrations")) {
        return { rows: [validOntarioRegistration] };
      }
      if (statement.includes("FROM tax_pack_versions")) {
        return { rows: [{
          id: "10000000-0000-4000-8000-000000000024",
          pack_key: packVersion.packKey,
          version: packVersion.packVersion,
          effective_from: "2026-01-01",
          effective_to: null,
        }] };
      }
      if (statement.includes("INSERT INTO source_documents")) {
        return { rows: [{
          id: parameters?.[0],
          organization_id: parameters?.[1],
          legal_entity_id: parameters?.[2],
          owner_module: parameters?.[3],
          source_type: parameters?.[4],
          source_number: parameters?.[5],
          version: parameters?.[6],
          status: parameters?.[7],
          snapshot: JSON.parse(String(parameters?.[8])),
          content_hash: parameters?.[9],
          command_hash: parameters?.[11],
          supersedes_source_document_id: parameters?.[12],
          void_reason: parameters?.[14],
          created_by: parameters?.[13],
          created_at: "2026-08-27T12:00:00.000Z",
        }] };
      }
      if (statement.includes("INSERT INTO tax_determination_snapshots")) {
        return { rows: (parameters?.[5] as readonly string[]).map((id) => ({ id })) };
      }
      if (statement.includes("INSERT INTO subledger_events") ||
          statement.includes("INSERT INTO open_items")) {
        return { rows: [{ id: parameters?.[0] }] };
      }
      if (statement.includes("FROM journal_type_definitions")) {
        return { rows: [{ id: "10000000-0000-4000-8000-000000000025", version: 1 }] };
      }
      if (statement.includes("INSERT INTO journal_entries")) {
        return { rows: [{ id: parameters?.[0] }] };
      }
      if (statement.includes("INSERT INTO journal_lines")) return { rows: [] };
      throw new Error(`Unexpected batched document-issue SQL: ${statement}`);
    });
    transactionMocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    const result = await issueBusinessDocument({
      context,
      kind: "SALES_INVOICE",
      sourceNumber: snapshot.sourceNumber,
      expectedVersion: 1,
      idempotencyKey: "invoice-issue-batch-1",
    });

    const taxInserts = query.mock.calls.filter(([statement]) => (
      statement.includes("INSERT INTO tax_determination_snapshots")
    ));
    expect(taxInserts).toHaveLength(1);
    expect(taxInserts[0]?.[0]).toContain("FROM unnest(");
    expect(taxInserts[0]?.[1]?.[5]).toHaveLength(2);
    expect(taxInserts[0]?.[1]?.[10]).toEqual(["40.00", "60.00"]);
    expect(taxInserts[0]?.[1]?.[16]).toEqual([
      JSON.stringify({
        sourceAccountCombinationId: snapshot.lines[0]!.accountCombinationId,
        taxAccountCombinationId: snapshot.taxAccountCombinationId,
      }),
      JSON.stringify({
        sourceAccountCombinationId: snapshot.lines[1]!.accountCombinationId,
        taxAccountCombinationId: snapshot.taxAccountCombinationId,
      }),
    ]);

    const journalLineInserts = query.mock.calls.filter(([statement]) => (
      statement.includes("INSERT INTO journal_lines")
    ));
    expect(journalLineInserts).toHaveLength(1);
    expect(journalLineInserts[0]?.[1]?.[4]).toEqual([1, 2, 3, 4, 5]);
    const taxSnapshotIds = taxInserts[0]?.[1]?.[5] as readonly string[];
    expect(journalLineInserts[0]?.[1]?.[16]).toEqual([
      null,
      null,
      taxSnapshotIds[0],
      null,
      taxSnapshotIds[1],
    ]);
    expect(result).toMatchObject({
      idempotentReplay: false,
      journalNumber: 812,
      document: { status: "POSTED", sourceNumber: snapshot.sourceNumber },
    });
  });

  it("reverses every settlement allocation in one exact ordered batch", async () => {
    const secondOpenItemId = "10000000-0000-4000-8000-000000000026";
    const postedSourceId = "10000000-0000-4000-8000-000000000027";
    const originalJournalId = "10000000-0000-4000-8000-000000000028";
    const reason = "Customer receipt was recorded against the wrong invoices";
    const snapshot = {
      schemaVersion: 1 as const,
      kind: "CUSTOMER_RECEIPT" as const,
      ownerModule: "receivables" as const,
      sourceType: "receivables.customer-receipt" as const,
      sourceNumber: "RCPT-BATCH-VOID-1",
      ledgerId: settlement.ledgerId,
      legalEntityId: settlement.legalEntityId,
      partyAccountId: settlement.partyAccountId,
      controlAccountCombinationId: settlement.controlAccountCombinationId,
      periodId: settlement.periodId,
      accountingDate: settlement.accountingDate,
      settlementDate: settlement.settlementDate,
      currency: "CAD",
      functionalCurrency: "CAD",
      amount: "100.00",
      settlementFunctionalAmount: "100.00",
      fx: settlement.fx,
      bankAccountCombinationId: settlement.bankAccountCombinationId,
      realizedFxGainAccountCombinationId: settlement.realizedFxGainAccountCombinationId,
      realizedFxLossAccountCombinationId: settlement.realizedFxLossAccountCombinationId,
      fxRoundingAccountCombinationId: null,
      description: "Original customer receipt",
      allocations: [
        {
          openItemId: settlement.allocations[0].openItemId,
          transactionAmount: "50.00",
          carryingFunctionalAmount: "50.00",
          settlementFunctionalAmount: "50.00",
          realizedFxFunctional: "0.00",
          carryingFxRate: "1",
        },
        {
          openItemId: secondOpenItemId,
          transactionAmount: "50.00",
          carryingFunctionalAmount: "50.00",
          settlementFunctionalAmount: "50.00",
          realizedFxFunctional: "0.00",
          carryingFxRate: "1",
        },
      ],
    };
    const postedSource = {
      id: postedSourceId,
      organization_id: context.organizationId,
      legal_entity_id: snapshot.legalEntityId,
      owner_module: snapshot.ownerModule,
      source_type: snapshot.sourceType,
      source_number: snapshot.sourceNumber,
      version: 1,
      status: "POSTED",
      snapshot,
      content_hash: "posted-content-hash",
      command_hash: "a".repeat(64),
      supersedes_source_document_id: null,
      void_reason: null,
      created_by: context.actorId,
      created_at: "2026-08-27T12:00:00.000Z",
    };
    const originals = snapshot.allocations.map((allocation, index) => ({
      id: `10000000-0000-4000-8000-${String(29 + index).padStart(12, "0")}`,
      open_item_id: allocation.openItemId,
      transaction_currency: snapshot.currency,
      transaction_amount: allocation.transactionAmount,
      carrying_functional_amount: allocation.carryingFunctionalAmount,
      settlement_functional_amount: allocation.settlementFunctionalAmount,
      realized_fx_functional: allocation.realizedFxFunctional,
      settlement_fx_rate: snapshot.fx.rate,
      fx_rate_source: snapshot.fx.source,
      fx_rate_effective_at: snapshot.fx.effectiveAt,
    }));
    const originalJournalLines = [
      {
        account_combination_id: snapshot.bankAccountCombinationId,
        debit_functional: "100.00",
        credit_functional: "0",
        transaction_currency: "CAD",
        debit_transaction: "100.00",
        credit_transaction: "0",
        fx_rate: "1",
        fx_rate_source: "FUNCTIONAL",
        fx_rate_effective_at: snapshot.fx.effectiveAt,
        party_account_id: null,
        subledger_event_id: null,
        tax_snapshot_id: null,
        memo: "Receipt bank settlement",
      },
      {
        account_combination_id: snapshot.controlAccountCombinationId,
        debit_functional: "0",
        credit_functional: "100.00",
        transaction_currency: "CAD",
        debit_transaction: "0",
        credit_transaction: "100.00",
        fx_rate: "1",
        fx_rate_source: "FUNCTIONAL",
        fx_rate_effective_at: snapshot.fx.effectiveAt,
        party_account_id: snapshot.partyAccountId,
        subledger_event_id: "10000000-0000-4000-8000-000000000031",
        tax_snapshot_id: null,
        memo: "Receipt control settlement",
      },
    ];
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM source_documents") && statement.includes("idempotency_key")) {
        return { rows: [] };
      }
      if (statement.includes("FROM source_documents") && statement.includes("ORDER BY version DESC")) {
        return { rows: [postedSource] };
      }
      if (statement.includes("FROM ledgers ledger")) {
        return { rows: [{
          functional_currency: "CAD",
          period_state: "OPEN",
          starts_on: "2026-08-01",
          ends_on: "2026-08-31",
          party_role: "CUSTOMER",
          control_account_id: "10000000-0000-4000-8000-000000000032",
          party_currency: "CAD",
        }] };
      }
      if (statement.includes("FROM document_settlement_allocations") &&
          statement.includes("allocation_type = 'APPLY'")) {
        return { rows: originals };
      }
      if (statement.includes("FROM journal_entries") && statement.includes("source_document_id")) {
        return { rows: [{
          id: originalJournalId,
          status: "POSTED",
          functional_currency: "CAD",
        }] };
      }
      if (statement.includes("FROM journal_lines")) return { rows: originalJournalLines };
      if (statement.includes("INSERT INTO source_documents")) {
        return { rows: [{
          id: parameters?.[0],
          organization_id: parameters?.[1],
          legal_entity_id: parameters?.[2],
          owner_module: parameters?.[3],
          source_type: parameters?.[4],
          source_number: parameters?.[5],
          version: parameters?.[6],
          status: parameters?.[7],
          snapshot: JSON.parse(String(parameters?.[8])),
          content_hash: parameters?.[9],
          command_hash: parameters?.[11],
          supersedes_source_document_id: parameters?.[12],
          void_reason: parameters?.[14],
          created_by: parameters?.[13],
          created_at: "2026-08-27T12:00:00.000Z",
        }] };
      }
      if (statement.includes("INSERT INTO document_settlement_allocations")) {
        return { rows: (parameters?.[5] as readonly string[]).map((id) => ({ id })) };
      }
      if (statement.includes("FROM journal_type_definitions")) {
        return { rows: [{ id: "10000000-0000-4000-8000-000000000033", version: 1 }] };
      }
      if (statement.includes("INSERT INTO journal_entries")) {
        return { rows: [{ id: parameters?.[0] }] };
      }
      if (statement.includes("INSERT INTO journal_lines") ||
          statement.includes("INSERT INTO journal_entry_relations")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected batched settlement-void SQL: ${statement}`);
    });
    transactionMocks.withTenantTransaction.mockImplementation(async (
      _context: unknown,
      work: (client: PoolClient) => Promise<unknown>,
    ) => work({ query } as unknown as PoolClient));

    const result = await voidSettlementAndReverseAllocations({
      context: { ...context, reason },
      kind: "CUSTOMER_RECEIPT",
      sourceNumber: snapshot.sourceNumber,
      expectedVersion: 1,
      periodId: settlement.periodId,
      accountingDate: "2026-08-27",
      reason,
      description: "Reverse receipt and exact allocations",
      idempotencyKey: "receipt-void-batch-1",
    });

    const reversalInserts = query.mock.calls.filter(([statement]) => (
      statement.includes("INSERT INTO document_settlement_allocations")
    ));
    expect(reversalInserts).toHaveLength(1);
    expect(reversalInserts[0]?.[0]).toContain("FROM unnest(");
    expect(reversalInserts[0]?.[0]).toContain("'REVERSAL'");
    expect(reversalInserts[0]?.[1]?.[6]).toEqual(originals.map((row) => row.open_item_id));
    expect(reversalInserts[0]?.[1]?.[7]).toEqual(originals.map((row) => row.id));
    expect(reversalInserts[0]?.[1]?.[9]).toEqual(originals.map((row) => row.transaction_amount));
    expect(reversalInserts[0]?.[1]?.[15]).toEqual([
      "2026-08-27T12:00:00.000Z",
      "2026-08-27T12:00:00.000Z",
    ]);
    expect(result.reversedAllocationIds).toEqual(reversalInserts[0]?.[1]?.[5]);
    expect(result).toMatchObject({
      idempotentReplay: false,
      journalNumber: 812,
      document: { status: "VOIDED", voidReason: reason },
    });
  });

  it("posts seller-collected sales tax to AR gross and buyer-remitted use tax outside AP gross", () => {
    const taxSnapshotId = "10000000-0000-4000-8000-000000000012";
    const sale = washingtonDocument("SALES_INVOICE");
    const purchase = washingtonDocument("SUPPLIER_BILL");
    const saleLines = buildIssueJournalLines(sale, settlement.allocations[0].openItemId, new Map([[1, taxSnapshotId]]));
    const purchaseLines = buildIssueJournalLines(purchase, settlement.allocations[0].openItemId, new Map([[1, taxSnapshotId]]));

    expect(sale.grossTotal).toBe("110.55");
    expect(saleLines.find((line) => line.partyAccountId)?.debitTransaction).toBe("110.55");
    expect(purchase.grossTotal).toBe("100.00");
    expect(purchaseLines.find((line) => line.partyAccountId)?.creditTransaction).toBe("100.00");
    expect(purchaseLines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountCombinationId: settlement.realizedFxGainAccountCombinationId,
        debitTransaction: "110.55",
        creditTransaction: "0",
      }),
      expect.objectContaining({
        accountCombinationId: settlement.realizedFxLossAccountCombinationId,
        debitTransaction: "0",
        creditTransaction: "10.55",
        taxSnapshotId,
      }),
    ]));
  });

  it("rejects a settlement that is not exactly allocated before opening a transaction", async () => {
    await expect(recordCustomerReceiptOrSupplierPayment({
      ...settlement,
      allocations: [{ ...settlement.allocations[0], transactionAmount: "99.99" }],
    })).rejects.toThrow("fully allocated");
    expect(transactionMocks.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("rejects transaction-currency fractions beyond configured precision before persistence", async () => {
    await expect(recordCustomerReceiptOrSupplierPayment({
      ...settlement,
      amount: "100.001",
      allocations: [{ ...settlement.allocations[0], transactionAmount: "100.001" }],
    })).rejects.toThrow("exceeds CAD precision");
    expect(transactionMocks.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("binds a business-document void reason to the audit transaction context", async () => {
    await expect(voidIssuedBusinessDocument({
      context: { ...context, reason: "A different reason" },
      kind: "SALES_INVOICE",
      sourceNumber: "INV-1001",
      expectedVersion: 2,
      periodId: settlement.periodId,
      accountingDate: "2026-08-27",
      reason: "Customer contract was cancelled",
      description: "Void invoice INV-1001",
      idempotencyKey: "invoice-void-1",
    })).rejects.toThrow("bound to the transaction audit context");
    expect(transactionMocks.withTenantTransaction).not.toHaveBeenCalled();
  });
});

describe("AR/AP tax-registration binding", () => {
  it("rejects a supported tax pack when the draft omits its registration", async () => {
    const { client, query } = registrationClient([]);

    await expect(assertBusinessDocumentTaxRegistrationBindings(
      client,
      context,
      ontarioDocument(),
    )).rejects.toThrow("Tax registration is required for source line 1");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a registration missing from the active organization and entity", async () => {
    const { client, query } = registrationClient([]);

    await expect(assertBusinessDocumentTaxRegistrationBindings(
      client,
      context,
      ontarioDocument(taxRegistrationId),
    )).rejects.toThrow("missing or belongs to another organization or entity");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects registration facts that do not match the persisted destination", async () => {
    const { client } = registrationClient([{
      ...validOntarioRegistration,
      destination_region: "QC",
    }]);

    await expect(assertBusinessDocumentTaxRegistrationBindings(
      client,
      context,
      ontarioDocument(taxRegistrationId),
    )).rejects.toThrow("Tax registration destination does not match source line 1");
  });

  it("rejects a registration that expired before the document date", async () => {
    const { client } = registrationClient([{
      ...validOntarioRegistration,
      valid_to: "2026-08-26",
    }]);

    await expect(assertBusinessDocumentTaxRegistrationBindings(
      client,
      context,
      ontarioDocument(taxRegistrationId),
    )).rejects.toThrow("Tax registration is not active on the document date");
  });

  it("accepts an exact active registration and locks it in tenant scope", async () => {
    const { client, query } = registrationClient([validOntarioRegistration]);
    const snapshot = ontarioDocument(taxRegistrationId);

    await expect(assertBusinessDocumentTaxRegistrationBindings(
      client,
      context,
      snapshot,
    )).resolves.toBeUndefined();
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${context.organizationId}|tax-registration|${snapshot.legalEntityId}|ca.on.hst`],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/organization_id = \$1[\s\S]*legal_entity_id = \$2/),
      [context.organizationId, snapshot.legalEntityId, [taxRegistrationId]],
    );
  });

  it("locks every referenced tax regime in deterministic lexical order", async () => {
    const ontario = ontarioDocument(taxRegistrationId);
    const washington = washingtonDocument("SALES_INVOICE", washingtonTaxRegistrationId);
    const snapshot = {
      ...ontario,
      lines: [
        ontario.lines[0],
        { ...washington.lines[0], lineNumber: 2 },
      ],
    };
    const { client, query } = registrationClient([
      validOntarioRegistration,
      {
        id: washingtonTaxRegistrationId,
        regime_key: "us.wa.sales-use",
        destination_country: "US",
        destination_region: "WA",
        destination_city: "Seattle",
        location_code: "1726",
        valid_from: "2026-01-01",
        valid_to: null,
      },
    ]);

    await expect(assertBusinessDocumentTaxRegistrationBindings(
      client,
      context,
      snapshot,
    )).resolves.toBeUndefined();
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${context.organizationId}|tax-registration|${snapshot.legalEntityId}|ca.on.hst`],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${context.organizationId}|tax-registration|${snapshot.legalEntityId}|us.wa.sales-use`],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringMatching(/organization_id = \$1[\s\S]*legal_entity_id = \$2/),
      [
        context.organizationId,
        snapshot.legalEntityId,
        [taxRegistrationId, washingtonTaxRegistrationId],
      ],
    );
  });

  it("preserves the registration-free generic unsupported review path", async () => {
    const { client, query } = registrationClient([]);
    const snapshot = buildBusinessDocumentSnapshot({
      kind: "SALES_INVOICE",
      sourceNumber: "INV-GENERIC-1001",
      ledgerId: settlement.ledgerId,
      legalEntityId: settlement.legalEntityId,
      partyAccountId: settlement.partyAccountId,
      controlAccountCombinationId: settlement.controlAccountCombinationId,
      documentDate: "2026-08-27",
      accountingDate: "2026-08-27",
      periodId: settlement.periodId,
      dueOn: "2026-09-26",
      currency: "CAD",
      fx: settlement.fx,
      description: "Unsupported jurisdiction review",
      lines: [{
        description: "Unsupported jurisdiction review",
        accountCombinationId: settlement.realizedFxGainAccountCombinationId,
        netAmount: "100.00",
        tax: {
          packKey: "generic.unsupported",
          category: "STANDARD",
          destinationCountry: "FR",
          destinationRegion: "IDF",
        },
      }],
    }, "CAD");

    await expect(assertBusinessDocumentTaxRegistrationBindings(
      client,
      context,
      snapshot,
    )).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
