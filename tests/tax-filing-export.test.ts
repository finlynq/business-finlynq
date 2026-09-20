import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/modules/identity/authorization", () => ({
  assertActorHasActivePermission: mocks.authorize,
}));
vi.mock("@/modules/workspace/tenant-read", () => ({
  withWorkspaceTenantRead: vi.fn(async (_context, _path, work) => work({ query: mocks.query })),
}));

import {
  exportTaxFilingWorkpaper,
  listTaxFilingWorkpapers,
  previewTaxFilingExport,
} from "@/modules/tax/filing-export";

const filingId = "10000000-0000-4000-8000-000000000010";
const principal: SessionPrincipal = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000004",
  organizationName: "Tax export test",
  roleLabel: "Owner",
  displayName: "Test owner",
  initials: "TO",
  sessionMode: "real",
  authMethod: "PASSWORD",
  expiresAt: new Date("2026-10-01T00:00:00Z"),
  mfaVerifiedAt: new Date("2026-09-20T00:00:00Z"),
  stepUpExpiresAt: new Date("2026-09-20T01:00:00Z"),
};

function rowsFor(sql: string) {
  if (sql.includes('filing.id AS "filingId"')) return [{ filingId, workpaperVersion: 1 }];
  if (sql.includes("FROM tax_filings filing")) return [{
    id: filingId,
    filingType: "PREPARED",
    status: "REVIEW_REQUIRED",
    periodStart: "2025-01-01",
    periodEnd: "2025-12-31",
    externalReference: null,
    sourceFileName: null,
    reportedValues: { line101: "13.00" },
    calculatedValues: { line101: "12.00" },
    reconciliation: [{ fieldKey: "line101", status: "VARIANCE" }],
    validations: [{ rule: "review", status: "WARN" }],
    template: { id: "template", mappingVersion: 2 },
    mappingSetId: "10000000-0000-4000-8000-000000000011",
    preparedBy: principal.userId,
    preparedAt: "2026-09-20T00:00:00Z",
    legalEntityId: "10000000-0000-4000-8000-000000000012",
    entityCode: "CA01",
    entityName: "Canada company",
    ledgerId: "10000000-0000-4000-8000-000000000013",
    ledgerCode: "CA01-PRIMARY",
    currency: "CAD",
  }];
  if (sql.includes("FROM entity_tax_registrations")) return [{
    id: "10000000-0000-4000-8000-000000000014",
    regimeKey: "ca.on.hst",
    destinationCountry: "CA",
    destinationRegion: "ON",
    destinationCity: null,
    locationCode: null,
    validFrom: "2024-01-01",
    validTo: null,
  }];
  if (sql.includes("WITH mapped_balances")) return [{
    mappingLineId: "10000000-0000-4000-8000-000000000015",
    fieldKey: "line101",
    glAccountId: "10000000-0000-4000-8000-000000000016",
    accountCode: "2200",
    accountName: "GST/HST payable",
    balanceBasis: "NET_CREDIT",
    multiplier: "1.000000",
    debits: "1.00",
    credits: "13.00",
    mappedBalance: "12.00",
  }];
  if (sql.includes("FROM tax_determination_snapshots")) return [{
    id: "10000000-0000-4000-8000-000000000017",
    status: "REVIEW_REQUIRED",
    ruleKey: "ca.on.hst",
    jurisdiction: "CA-ON",
    currency: "CAD",
    taxableBasis: "100.00",
    totalTax: "13.00",
    sourceDocumentId: "10000000-0000-4000-8000-000000000018",
    decisionHash: "a".repeat(64),
    createdAt: "2025-01-08T00:00:00Z",
    journalReferences: [{ journalEntryId: "10000000-0000-4000-8000-000000000019" }],
  }];
  if (sql.includes("FROM tax_filing_asset_adjustments")) return [{
    id: "10000000-0000-4000-8000-000000000020",
    assetTaxScheduleId: "10000000-0000-4000-8000-000000000021",
    snapshot: { bookDepreciation: "449.99", ccaClaimed: "1349.99" },
    reason: "Reviewed Canadian CCA adjustment",
    reviewedBy: principal.userId,
    reviewedAt: "2026-09-20T00:00:00Z",
  }];
  if (sql.includes("SELECT DISTINCT journal.id")) return [{
    journalEntryId: "10000000-0000-4000-8000-000000000019",
    journalNumber: 101,
    accountingDate: "2025-01-08",
    status: "POSTED",
    contentHash: "b".repeat(64),
    sourceDocumentId: "10000000-0000-4000-8000-000000000018",
    sourceType: "SUPPLIER_BILL",
    sourceNumber: "CA52WU53ACCUI",
    sourceVersion: 1,
    sourceContentHash: "c".repeat(64),
  }];
  throw new Error(`Unexpected export query: ${sql}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation(async (sql: string) => ({ rows: rowsFor(sql) }));
});

describe("tax filing workpaper export", () => {
  it("lists exact immutable workpaper versions under tax-read authorization", async () => {
    await expect(listTaxFilingWorkpapers(principal, { limit: 25 })).resolves.toEqual({
      workpapers: [{ filingId, workpaperVersion: 1 }],
    });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: "tax.read",
    }));
  });

  it("produces stable review-only JSON and CSV hashes without sensitive storage data", async () => {
    const first = await previewTaxFilingExport(principal, filingId);
    const second = await previewTaxFilingExport(principal, filingId);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      filingId,
      workpaperVersion: 1,
      unresolvedVarianceCount: 1,
      boundary: "REVIEW_ONLY_NO_SUBMISSION_NO_PAYMENT",
    });

    const json = await exportTaxFilingWorkpaper(principal, {
      filingId,
      format: "JSON",
      expectedContentHash: first.contentHash,
      allowDraftWithWarnings: true,
    });
    const csv = await exportTaxFilingWorkpaper(principal, {
      filingId,
      format: "CSV",
      expectedContentHash: first.contentHash,
      allowDraftWithWarnings: true,
    });
    expect(json.contentHash).toBe(first.contentHash);
    expect(csv.contentHash).toBe(first.contentHash);
    expect(json.exportId).toHaveLength(64);
    const decoded = Buffer.from(json.contentBase64, "base64").toString("utf8");
    expect(decoded).toContain('"mappedLedgerBalances"');
    expect(decoded).toContain('"registrations"');
    expect(decoded).toContain('"sourceJournalReferences"');
    expect(decoded).toContain('"assetBookToTaxAdjustments"');
    expect(decoded).not.toContain("ciphertext");
    expect(decoded).not.toContain("signedUrl");
    expect(decoded).not.toContain("rawDocument");
    expect(Buffer.from(csv.contentBase64, "base64").toString("utf8"))
      .toContain('"section","key","value"');
  });

  it("rejects export when the caller's preview hash is stale", async () => {
    await expect(exportTaxFilingWorkpaper(principal, {
      filingId,
      format: "JSON",
      expectedContentHash: "f".repeat(64),
    })).rejects.toMatchObject({ code: "TAX_EXPORT_HASH_CONFLICT" });
  });
});
