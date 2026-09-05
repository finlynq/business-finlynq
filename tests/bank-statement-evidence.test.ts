import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import { PERMISSIONS } from "@/modules/identity/permissions";

const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  otherOrganization: "22222222-2222-4222-8222-222222222222",
  actor: "33333333-3333-4333-8333-333333333333",
  session: "44444444-4444-4444-8444-444444444444",
  statementImport: "55555555-5555-4555-8555-555555555555",
  directAsset: "66666666-6666-4666-8666-666666666666",
  duplicateAsset: "77777777-7777-4777-8777-777777777777",
  mismatchedAsset: "88888888-8888-4888-8888-888888888888",
  connection: "99999999-9999-4999-8999-999999999999",
};

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  assertPermission: vi.fn(),
  itemProcessing: vi.fn(),
  metadata: vi.fn(),
  authorize: vi.fn(),
  resolve: vi.fn(),
  download: vi.fn(),
  reauthorize: vi.fn(),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: async (
    _context: TenantTransactionContext,
    callback: (client: PoolClient) => unknown,
  ) => {
    void _context;
    return callback({ query: mocks.query } as unknown as PoolClient);
  },
}));

vi.mock("@/modules/subledger/ar-ap-access", () => ({
  assertPermission: mocks.assertPermission,
  permissionForOwner: vi.fn(),
  withoutContext: ({ context: ignoredContext, ...value }: Record<string, unknown>) => {
    void ignoredContext;
    return value;
  },
}));

vi.mock("@/modules/document-storage/inbox-store", () => ({
  itemProcessing: mocks.itemProcessing,
}));

vi.mock("@/modules/document-storage/evidence", () => ({
  authorizeCloudEvidenceDownload: mocks.authorize,
  resolveCloudEvidenceDownload: mocks.resolve,
  downloadCloudEvidence: mocks.download,
  reauthorizeCloudEvidenceDownload: mocks.reauthorize,
}));

vi.mock("@/modules/subledger/evidence-store", () => ({
  EVIDENCE_METADATA_COLUMNS: "id, organization_id, owner_module, filename_ciphertext, key_version, mime_type, byte_size, sha256, uploaded_by, created_at, scanner_version, scanned_at, command_hash, storage_backend, storage_connection_id, provider_file_id",
  evidenceMetadata: mocks.metadata,
  decryptEvidenceContent: vi.fn(),
  loadDocumentEvidence: vi.fn(),
  evidenceEncryptionContext: vi.fn(),
}));

import { downloadBankStatementEvidence } from "@/modules/subledger/evidence-service";

const context: TenantTransactionContext = {
  organizationId: ids.organization,
  actorId: ids.actor,
  sessionId: ids.session,
  sessionMode: "real",
  requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  authMethod: "password+mfa",
  sourceSurface: "MCP",
};

function evidenceRow(assetId: string) {
  return {
    id: assetId,
    organization_id: ids.organization,
    owner_module: "payables",
    filename_ciphertext: "encrypted",
    key_version: 1,
    mime_type: "application/pdf",
    byte_size: 7,
    sha256: "a".repeat(64),
    uploaded_by: ids.actor,
    created_at: new Date("2026-09-05T00:00:00Z"),
    scanner_version: "test",
    scanned_at: new Date("2026-09-05T00:00:00Z"),
    command_hash: "b".repeat(64),
    storage_backend: "CLOUD",
    storage_connection_id: ids.connection,
    provider_file_id: "provider-file",
  };
}

function completion(assetId: string) {
  return {
    statementImportId: ids.statementImport,
    externalAccountId: "aaaaaaaa-0000-4000-8000-000000000001",
    reconciliationId: "aaaaaaaa-0000-4000-8000-000000000002",
    evidenceAssetId: assetId,
    importedRowCount: 0,
    duplicateRowCount: 1,
    excludedRowCount: 0,
    idempotentReplay: false,
    duplicateSource: true,
    transferCandidates: [],
    instruction: "The repeated source created no observations.",
  };
}

describe("bank-statement evidence authorization (mocked provider/database boundaries)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue(undefined);
    mocks.metadata.mockImplementation(async (_client: PoolClient, row: { id: string }) => ({
      assetId: row.id,
      filename: "statement.pdf",
      mimeType: "application/pdf",
      byteSize: 7,
      sha256: "a".repeat(64),
      uploadedBy: ids.actor,
      uploadedAt: "2026-09-05T00:00:00.000Z",
      scannerVersion: "test",
      scannedAt: "2026-09-05T00:00:00.000Z",
    }));
    mocks.authorize.mockResolvedValue({ authorizationAccess: "banking" });
    mocks.resolve.mockResolvedValue({ drive: {}, location: {} });
    mocks.download.mockImplementation(async () => Buffer.from("invoice"));
    mocks.reauthorize.mockResolvedValue(undefined);
    mocks.itemProcessing.mockResolvedValue({ statementImport: completion(ids.duplicateAsset) });
    mocks.query.mockImplementation(async (statement: string, parameters: readonly unknown[]) => {
      if (statement.includes("FROM document_evidence_assets")) {
        const organizationId = parameters[0];
        const assetId = parameters[1];
        const exists = organizationId === ids.organization
          && [ids.directAsset, ids.duplicateAsset, ids.mismatchedAsset].includes(String(assetId));
        return { rows: exists ? [evidenceRow(String(assetId))] : [] };
      }
      if (statement.includes("FROM bank_statement_imports")) {
        return {
          rows: parameters[0] === ids.organization && parameters[1] === ids.statementImport
            ? [{ evidence_asset_id: ids.directAsset }]
            : [],
        };
      }
      if (statement.includes("FROM document_inbox_items")) {
        return {
          rows: parameters[0] === ids.organization && parameters[1] === ids.duplicateAsset
            ? [{ id: "inbox", organization_id: ids.organization }]
            : [],
        };
      }
      throw new Error("Unexpected SQL: " + statement);
    });
  });

  it("downloads only the asset directly linked by the tenant-owned import", async () => {
    const result = await downloadBankStatementEvidence({
      context,
      statementImportId: ids.statementImport,
      assetId: ids.directAsset,
    });
    expect(result.bytes.toString()).toBe("invoice");
    expect(mocks.assertPermission).toHaveBeenCalledTimes(2);
    expect(mocks.assertPermission).toHaveBeenCalledWith(
      expect.anything(),
      context,
      PERMISSIONS.readBanking,
    );
    expect(mocks.authorize).toHaveBeenCalledWith(
      expect.anything(),
      context,
      expect.objectContaining({ id: ids.directAsset }),
      "banking",
    );
    expect(mocks.reauthorize).toHaveBeenCalledWith(
      expect.anything(),
      context,
      expect.objectContaining({ id: ids.directAsset }),
      "banking",
    );
    result.bytes.fill(0);
  });

  it("retains a newly archived duplicate source through its exact encrypted completion association", async () => {
    const result = await downloadBankStatementEvidence({
      context,
      statementImportId: ids.statementImport,
      assetId: ids.duplicateAsset,
    });
    expect(result.metadata.assetId).toBe(ids.duplicateAsset);
    expect(mocks.itemProcessing).toHaveBeenCalledTimes(2);
    result.bytes.fill(0);
  });

  it("rejects cross-organization, mismatched, and forged completion associations before provider transfer", async () => {
    await expect(downloadBankStatementEvidence({
      context: { ...context, organizationId: ids.otherOrganization },
      statementImportId: ids.statementImport,
      assetId: ids.directAsset,
    })).rejects.toThrow("Evidence is unavailable");

    await expect(downloadBankStatementEvidence({
      context,
      statementImportId: ids.statementImport,
      assetId: ids.mismatchedAsset,
    })).rejects.toThrow("Evidence is unavailable");

    mocks.itemProcessing.mockResolvedValueOnce({
      statementImport: completion(ids.mismatchedAsset),
    });
    await expect(downloadBankStatementEvidence({
      context,
      statementImportId: ids.statementImport,
      assetId: ids.duplicateAsset,
    })).rejects.toThrow("Evidence is unavailable");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("zeroes downloaded bytes when live banking permission is revoked before post-authorization", async () => {
    const transferred = Buffer.from("invoice");
    mocks.download.mockResolvedValueOnce(transferred);
    mocks.assertPermission
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Permission denied"));

    await expect(downloadBankStatementEvidence({
      context,
      statementImportId: ids.statementImport,
      assetId: ids.directAsset,
    })).rejects.toThrow("Permission denied");
    expect(transferred).toEqual(Buffer.alloc(transferred.length));
    expect(mocks.reauthorize).not.toHaveBeenCalled();
  });
});
