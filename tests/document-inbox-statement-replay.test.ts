import { describe, expect, it } from "vitest";
import {
  processingSchema,
  statementCompletionSchema,
} from "@/modules/document-storage/inbox-store";
import {
  replayedStatementCompletion,
  statementCompletionResponse,
} from "@/modules/document-storage/inbox";

const ids = {
  statementImport: "11111111-1111-4111-8111-111111111111",
  account: "22222222-2222-4222-8222-222222222222",
  reconciliation: "33333333-3333-4333-8333-333333333333",
  evidence: "44444444-4444-4444-8444-444444444444",
  sourceVersion: "55555555-5555-4555-8555-555555555555",
  counterpartVersion: "66666666-6666-4666-8666-666666666666",
  counterpartAccount: "77777777-7777-4777-8777-777777777777",
};

function normalCompletion() {
  return statementCompletionSchema.parse({
    statementImportId: ids.statementImport,
    externalAccountId: ids.account,
    reconciliationId: ids.reconciliation,
    evidenceAssetId: ids.evidence,
    reconciliationReused: false,
    importedRowCount: 1,
    duplicateRowCount: 0,
    excludedRowCount: 1,
    idempotentReplay: false,
    duplicateSource: false,
    transferCandidates: [{
      sourceObservationVersionId: ids.sourceVersion,
      counterpartObservationVersionId: ids.counterpartVersion,
      sourceAccountId: ids.account,
      counterpartAccountId: ids.counterpartAccount,
      postedOn: "2026-09-01",
      amount: "-10.000000000",
      currencyCode: "CAD",
      instruction: "Review this pair; no match was created.",
    }],
    instruction: "Review the draft reconciliation. No journal was posted.",
  });
}

describe("bank-statement inbox completion replay", () => {
  it("reconstructs the full normal outcome for an exact retry after a lost response", () => {
    const saved = normalCompletion();
    const processing = processingSchema.parse({
      name: "statement.pdf",
      folders: ["2026", "09", "Statements"],
      statementImport: saved,
    });

    expect(replayedStatementCompletion(processing)).toEqual({
      ...saved,
      idempotentReplay: true,
      evidenceDownloadUrl:
        `/api/banking/statement-imports/${ids.statementImport}/evidence/${ids.evidence}`,
    });
  });

  it("reconstructs a duplicate-source outcome with the newly dropped evidence asset", () => {
    const duplicateEvidence = "88888888-8888-4888-8888-888888888888";
    const saved = statementCompletionSchema.parse({
      ...normalCompletion(),
      evidenceAssetId: duplicateEvidence,
      reconciliationReused: undefined,
      importedRowCount: 0,
      duplicateRowCount: 1,
      excludedRowCount: 0,
      duplicateSource: true,
      transferCandidates: [],
      instruction: "The repeated source created no observations.",
    });
    const replay = replayedStatementCompletion(
      processingSchema.parse({ statementImport: saved }),
    );

    expect(replay).toMatchObject({
      statementImportId: ids.statementImport,
      evidenceAssetId: duplicateEvidence,
      importedRowCount: 0,
      duplicateRowCount: 1,
      duplicateSource: true,
      idempotentReplay: true,
      evidenceDownloadUrl:
        `/api/banking/statement-imports/${ids.statementImport}/evidence/${duplicateEvidence}`,
    });
  });

  it("keeps legacy invoice processing payloads compatible and omits a statement replay", () => {
    const legacy = processingSchema.parse({
      name: "invoice.pdf",
      folders: ["2026", "09", "Purchase Invoices"],
      destinationId: "archive",
      reason: "Filed",
    });
    expect(replayedStatementCompletion(legacy)).toBeNull();
    expect(statementCompletionResponse(normalCompletion())).toMatchObject({
      idempotentReplay: false,
    });
  });
});
