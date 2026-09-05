import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { completeInboxSchema } from "@/modules/document-storage/model";

const extraction = {
  extractionVersion: "finlynq.statement.v1" as const,
  institution: "Example Bank",
  maskedAccount: "•••• 1234",
  accountKind: "CASH" as const,
  currency: "CAD",
  statementStartOn: "2026-08-01",
  statementEndOn: "2026-08-31",
  balanceConvention: "SIGNED_ACCOUNT_BALANCE" as const,
  openingBalance: "100.00",
  closingBalance: "90.00",
  namedBalances: [{ name: "Available balance", amount: "85.00" }],
  pageCount: 2,
  rows: [{
    rowNumber: 1,
    postedOn: "2026-08-15",
    direction: "DECREASE" as const,
    sourceKind: "PAYMENT" as const,
    amount: "10.00",
    description: "Outgoing bill payment",
  }],
};

function command() {
  return {
    itemId: randomUUID(),
    claimId: randomUUID(),
    sha256: "a".repeat(64),
    metadata: {
      documentType: "STATEMENT" as const,
      documentDate: extraction.statementEndOn,
      counterparty: extraction.institution,
      currency: extraction.currency,
    },
    action: {
      type: "IMPORT_STATEMENT" as const,
      extraction: structuredClone(extraction),
      mapping: { mode: "EXISTING_ACCOUNT" as const, externalAccountId: randomUUID() },
      previewHash: "b".repeat(64),
      confirmed: true as const,
    },
    reason: "Import the reviewed statement",
  };
}

describe("document inbox statement completion contract", () => {
  it("accepts only explicit confirmation with the reviewed extraction shape", () => {
    const parsed = completeInboxSchema.parse(command());

    expect(parsed.action).toMatchObject({
      type: "IMPORT_STATEMENT",
      confirmed: true,
      previewHash: "b".repeat(64),
      extraction: {
        currency: "CAD",
        statementEndOn: "2026-08-31",
        openingBalance: "100.00",
        closingBalance: "90.00",
        namedBalances: [{ name: "Available balance", amount: "85.00" }],
        pageCount: 2,
        rows: [{ direction: "DECREASE", sourceKind: "PAYMENT", amount: "10.00" }],
      },
    });

    expect(completeInboxSchema.safeParse({
      ...command(),
      action: { ...command().action, confirmed: false },
    }).success).toBe(false);

    const missingConfirmation = command() as unknown as { action: Record<string, unknown> };
    delete missingConfirmation.action.confirmed;
    expect(completeInboxSchema.safeParse(missingConfirmation).success).toBe(false);
  });

  it("requires an explicit economic direction independently of sourceKind", () => {
    expect(completeInboxSchema.safeParse(command()).success).toBe(true);

    const withoutDirection = command() as unknown as {
      action: { extraction: { rows: Array<Record<string, unknown>> } };
    };
    delete withoutDirection.action.extraction.rows[0]!.direction;
    expect(completeInboxSchema.safeParse(withoutDirection).success).toBe(false);

    const invalidDirection = command() as unknown as {
      action: { extraction: { rows: Array<Record<string, unknown>> } };
    };
    invalidDirection.action.extraction.rows[0]!.direction = "OUTFLOW";
    expect(completeInboxSchema.safeParse(invalidDirection).success).toBe(false);
  });

  it("rejects normalized preview fields substituted for the reviewed extraction", () => {
    const changedShape = command() as unknown as {
      action: { extraction: Record<string, unknown>; previewHash: string };
    };
    changedShape.action.extraction.currencyCode = changedShape.action.extraction.currency;
    delete changedShape.action.extraction.currency;
    expect(completeInboxSchema.safeParse(changedShape).success).toBe(false);

    const previewOutputMixedIntoExtraction = command() as unknown as {
      action: { extraction: Record<string, unknown> };
    };
    previewOutputMixedIntoExtraction.action.extraction.transactionTotal = "-10.000000000";
    expect(completeInboxSchema.safeParse(previewOutputMixedIntoExtraction).success).toBe(false);

    expect(completeInboxSchema.safeParse({
      ...command(),
      action: { ...command().action, previewHash: "changed" },
    }).success).toBe(false);
  });

  it("allows statement currency without a false total while retaining invoice pairs", () => {
    expect(completeInboxSchema.safeParse(command()).success).toBe(true);

    const invoiceWithoutTotal = command();
    expect(completeInboxSchema.safeParse({
      ...invoiceWithoutTotal,
      metadata: { ...invoiceWithoutTotal.metadata, documentType: "PURCHASE_INVOICE" },
    }).success).toBe(false);

    const metadataWithoutCurrency: Record<string, unknown> = {
      ...command().metadata,
      documentType: "PURCHASE_INVOICE",
      total: "10.00",
    };
    delete metadataWithoutCurrency.currency;
    expect(completeInboxSchema.safeParse({
      ...command(),
      metadata: metadataWithoutCurrency,
    }).success).toBe(false);
  });
});
