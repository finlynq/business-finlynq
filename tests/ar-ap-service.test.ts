import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const transactionMocks = vi.hoisted(() => ({
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: transactionMocks.withTenantTransaction,
}));

import {
  assertBusinessDocumentTaxRegistrationBindings,
  buildIssueJournalLines,
  recordCustomerReceiptOrSupplierPayment,
  subledgerOperationKey,
  voidIssuedBusinessDocument,
} from "@/modules/subledger/ar-ap-service";
import { buildBusinessDocumentSnapshot } from "@/modules/subledger/document-model";

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

beforeEach(() => {
  process.env.BUSINESS_WRITES_ENABLED = "true";
  transactionMocks.withTenantTransaction.mockReset();
});

afterAll(() => {
  if (previousWritesSetting === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
  else process.env.BUSINESS_WRITES_ENABLED = previousWritesSetting;
});

describe("AR/AP service command boundary", () => {
  it("namespaces otherwise identical idempotency keys across AR and AP", () => {
    expect(subledgerOperationKey("receivables", "issue", "same-client-key")).not.toBe(
      subledgerOperationKey("payables", "issue", "same-client-key"),
    );
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
