import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantTransactionContext } from "@/db/transaction";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  item: "10000000-0000-4000-8000-000000000003",
  asset: "10000000-0000-4000-8000-000000000004",
  source: "10000000-0000-4000-8000-000000000005",
  connection: "10000000-0000-4000-8000-000000000006",
  entity: "10000000-0000-4000-8000-000000000007",
  account: "10000000-0000-4000-8000-000000000008",
};
const csv = Buffer.from("posted,amount\n2026-10-01,12.00\n");
const sha256 = createHash("sha256").update(csv).digest("hex");
const identity = { itemId: ids.item, assetId: ids.asset, sourceDocumentId: ids.source, sha256 };
const context = {
  organizationId: ids.organization,
  actorId: ids.actor,
  sessionId: "10000000-0000-4000-8000-000000000009",
  sessionMode: "real",
  requestId: "filed-evidence-test",
  authMethod: "password+mfa",
  sourceSurface: "MCP",
  reason: "Review an already-filed bank export",
} as TenantTransactionContext;

const mocks = vi.hoisted(() => ({
  withTenantTransaction: vi.fn(),
  assertActorHasActivePermission: vi.fn(async () => undefined),
  assertWritableOrganization: vi.fn(async () => undefined),
  assertTenantWritesEnabled: vi.fn(),
  loadInboxItem: vi.fn(),
  downloadDocumentEvidence: vi.fn(),
  reauthorizeDocumentEvidenceLinkInTransaction: vi.fn(),
  importBankStatementInTransaction: vi.fn(),
  documentPage: vi.fn(async () => ({ mimeType: "text/csv", text: "posted,amount", pageCount: 1, contentKind: "DELIMITED_TEXT" })),
}));

vi.mock("@/db/transaction", () => ({ withTenantTransaction: mocks.withTenantTransaction }));
vi.mock("@/modules/identity/authorization", () => ({ assertActorHasActivePermission: mocks.assertActorHasActivePermission }));
vi.mock("@/modules/workspace/write-policy", () => ({
  assertWritableOrganization: mocks.assertWritableOrganization,
  assertTenantWritesEnabled: mocks.assertTenantWritesEnabled,
}));
vi.mock("@/modules/document-storage/inbox-store", () => ({ loadInboxItem: mocks.loadInboxItem }));
vi.mock("@/modules/subledger/evidence-service", () => ({
  downloadDocumentEvidence: mocks.downloadDocumentEvidence,
  reauthorizeDocumentEvidenceLinkInTransaction: mocks.reauthorizeDocumentEvidenceLinkInTransaction,
}));
vi.mock("@/modules/banking/statement-import-service", () => ({
  importBankStatementInTransaction: mocks.importBankStatementInTransaction,
  normalizeStatementImportDatabaseError: (error: unknown) => error,
}));
vi.mock("@/modules/document-storage/content", () => ({ documentPage: mocks.documentPage }));

import { importFiledStatement, readFiledStatement } from "@/modules/document-storage/filed-statement";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTenantTransaction.mockImplementation(async (_context, work) => work({
    query: async (statement: string) => {
      if (statement.includes("FROM source_documents")) return { rows: [{ legal_entity_id: ids.entity }] };
      throw new Error(`Unexpected SQL: ${statement}`);
    },
  }));
  mocks.loadInboxItem.mockResolvedValue({
    row: { status: "FILED", asset_id: ids.asset, source_document_id: ids.source, sha256 },
    connection: { id: ids.connection, legal_entity_id: ids.entity, owner_module: "payables" },
  });
  mocks.downloadDocumentEvidence.mockImplementation(async () => ({
    metadata: { filename: "original-bank-export.csv", mimeType: "text/csv", sha256 },
    bytes: Buffer.from(csv),
  }));
  mocks.reauthorizeDocumentEvidenceLinkInTransaction.mockResolvedValue({
    sha256, storage_backend: "CLOUD", storage_connection_id: ids.connection,
  });
  mocks.importBankStatementInTransaction.mockResolvedValue({
    statementImportId: "10000000-0000-4000-8000-000000000010",
    externalAccountId: ids.account,
    evidenceAssetId: ids.asset,
    importedRowCount: 1,
  });
});

describe("already-filed statement evidence", () => {
  it("reads a bounded page through the existing linked cloud asset", async () => {
    const result = await readFiledStatement(context, { ...identity, page: 1 });
    expect(result).toMatchObject({ itemId: ids.item, assetId: ids.asset, sha256, page: 1, pageCount: 1 });
    expect(mocks.downloadDocumentEvidence).toHaveBeenCalledWith({
      context, assetId: ids.asset, sourceDocumentId: ids.source,
    });
    expect(mocks.documentPage).toHaveBeenCalledWith(expect.any(Buffer), "text/csv", 1, "CSV");
  });

  it("rejects a mismatched filed asset before touching the cloud file", async () => {
    mocks.loadInboxItem.mockResolvedValueOnce({
      row: { status: "FILED", asset_id: "10000000-0000-4000-8000-000000000011", source_document_id: ids.source, sha256 },
      connection: { id: ids.connection, legal_entity_id: ids.entity, owner_module: "payables" },
    });
    await expect(readFiledStatement(context, { ...identity, page: 1 })).rejects.toMatchObject({
      code: "STORAGE_FILED_EVIDENCE_MISMATCH",
    });
    expect(mocks.downloadDocumentEvidence).not.toHaveBeenCalled();
  });

  it("imports using the original inbox and evidence IDs after a second authorization check", async () => {
    const extraction = {
      extractionVersion: "finlynq.statement.v1" as const,
      importMode: "TRANSACTION_EXPORT" as const,
      institution: "Example bank",
      maskedAccount: "••1234",
      accountKind: "CASH" as const,
      currency: "CAD",
      statementStartOn: "2026-10-01",
      statementEndOn: "2026-10-01",
      rows: [{ rowNumber: 1, postedOn: "2026-10-01", direction: "INCREASE" as const,
        sourceKind: "DEPOSIT" as const, amount: "12.00" }],
    };
    await importFiledStatement(context, {
      ...identity, extraction, mapping: { mode: "EXISTING_ACCOUNT", externalAccountId: ids.account },
      previewHash: "a".repeat(64), confirmed: true,
      reason: "Import this reviewed original bank export without another upload",
    });
    expect(mocks.reauthorizeDocumentEvidenceLinkInTransaction).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), ids.asset, ids.source,
    );
    expect(mocks.importBankStatementInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      inboxItemId: ids.item, evidenceAssetId: ids.asset, sourceSha256: sha256,
      expectedLegalEntityId: ids.entity,
    }));
  });
});
