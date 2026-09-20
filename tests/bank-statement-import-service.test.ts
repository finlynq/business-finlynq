import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { previewBankStatementExtraction } from "@/modules/banking/statement-import-model";

const mocks = vi.hoisted(() => ({
  actorHasActivePermission: vi.fn(),
  loadActiveOrganizationKey: vi.fn(),
  createBlindIndex: vi.fn((value: string, _dek: Buffer, _organizationId: string, purpose: string) => (
    "hmac-sha256-v1:" + purpose + ":" + value
  )),
  encryptField: vi.fn(() => ({ version: 1, nonce: "nonce", ciphertext: "cipher", tag: "tag" })),
  serializeEncryptedField: vi.fn(() => "encrypted"),
}));

vi.mock("@/modules/identity/authorization", () => ({
  actorHasActivePermission: mocks.actorHasActivePermission,
}));
vi.mock("@/security/organization-key-store", () => ({
  loadActiveOrganizationKey: mocks.loadActiveOrganizationKey,
}));
vi.mock("@/security/organization-encryption", () => ({
  createBlindIndex: mocks.createBlindIndex,
  encryptField: mocks.encryptField,
  serializeEncryptedField: mocks.serializeEncryptedField,
}));

import { importBankStatementInTransaction, normalizeStatementImportDatabaseError } from "@/modules/banking/statement-import-service";

const organizationId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000002";
const inboxItemId = "10000000-0000-4000-8000-000000000003";
const evidenceAssetId = "10000000-0000-4000-8000-000000000004";
const externalAccountId = "10000000-0000-4000-8000-000000000005";
const connectionId = "10000000-0000-4000-8000-000000000006";
const legalEntityId = "10000000-0000-4000-8000-000000000007";
const ledgerId = "10000000-0000-4000-8000-000000000008";
const combinationId = "10000000-0000-4000-8000-000000000009";
const observationId = "10000000-0000-4000-8000-000000000010";

const extraction = {
  extractionVersion: "finlynq.statement.v1" as const,
  institution: "Example Bank",
  maskedAccount: "****1234",
  accountKind: "CASH" as const,
  currency: "CAD",
  statementStartOn: "2026-08-01",
  statementEndOn: "2026-08-31",
  balanceConvention: "SIGNED_ACCOUNT_BALANCE" as const,
  openingBalance: "100",
  closingBalance: "110",
  rows: [
    { rowNumber: 1, postedOn: "2026-08-10", direction: "INCREASE" as const, sourceKind: "DEPOSIT" as const, amount: "10", reference: "TX-1" },
  ],
};

const context = {
  organizationId,
  actorId,
  sessionId: "10000000-0000-4000-8000-000000000011",
  sessionMode: "real" as const,
  requestId: "statement-test",
  authMethod: "session",
  sourceSurface: "MCP" as const,
};

function command(overrides: Record<string, unknown> = {}) {
  return {
    context,
    inboxItemId,
    evidenceAssetId,
    sourceSha256: "a".repeat(64),
    extraction,
    mapping: { mode: "EXISTING_ACCOUNT" as const, externalAccountId },
    previewHash: previewBankStatementExtraction(extraction).previewHash,
    expectedLegalEntityId: legalEntityId,
    ...overrides,
  };
}

describe("bank statement import service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actorHasActivePermission.mockResolvedValue(true);
    mocks.loadActiveOrganizationKey.mockResolvedValue({ keyVersion: 1, dek: Buffer.alloc(32, 7) });
  });

  it.each([
    ["42501", "STATEMENT_IMPORT_AUTHORIZATION_REJECTED"],
    ["23503", "STATEMENT_IMPORT_LINEAGE_REJECTED"],
    ["23514", "STATEMENT_IMPORT_INTEGRITY_REJECTED"],
    ["23505", "STATEMENT_IMPORT_STATE_CONFLICT"],
  ])("maps PostgreSQL %s to a safe statement-import category", (databaseCode, expectedCode) => {
    const normalized = normalizeStatementImportDatabaseError(Object.assign(new Error("sensitive SQL details"), { code: databaseCode }));
    expect(normalized).toMatchObject({ code: expectedCode });
    expect(normalized.message).not.toContain("sensitive SQL details");
  });

  it("fails before database mutation when either required organization permission is absent", async () => {
    mocks.actorHasActivePermission.mockResolvedValueOnce(false);
    const query = vi.fn();
    await expect(importBankStatementInTransaction(
      { query } as unknown as PoolClient,
      command(),
    )).rejects.toMatchObject({ code: "BANK_STATEMENT_PERMISSION_REQUIRED", status: 403 });
    expect(query).not.toHaveBeenCalled();
  });

  it("requires the unchanged reviewed preview hash", async () => {
    const query = vi.fn();
    await expect(importBankStatementInTransaction(
      { query } as unknown as PoolClient,
      command({ previewHash: "b".repeat(64) }),
    )).rejects.toMatchObject({ code: "STATEMENT_PREVIEW_CHANGED", status: 409 });
    expect(query).not.toHaveBeenCalled();
  });

  it("replays an existing import only inside the current organization boundary", async () => {
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM bank_statement_imports")) {
        expect(parameters?.[0]).toBe(organizationId);
        expect(parameters?.[1]).toBe(inboxItemId);
        return { rows: [{
          id: "10000000-0000-4000-8000-000000000012",
          external_account_id: externalAccountId,
          reconciliation_session_id: "10000000-0000-4000-8000-000000000013",
          evidence_asset_id: evidenceAssetId,
          source_sha256: "a".repeat(64),
          preview_hash: previewBankStatementExtraction(extraction).previewHash,
          included_row_count: 1,
          excluded_row_count: 0,
          duplicate_row_count: 0,
        }] };
      }
      throw new Error("Unexpected SQL: " + statement);
    });
    const result = await importBankStatementInTransaction(
      { query } as unknown as PoolClient,
      command(),
    );

    expect(result.idempotentReplay).toBe(true);
    expect(result.evidenceAssetId).toBe(evidenceAssetId);
    expect(result.importedRowCount).toBe(1);
    expect(mocks.loadActiveOrganizationKey).not.toHaveBeenCalled();
  });

  it("does not add observations to a submitted or finalized reconciliation period", async () => {
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM bank_statement_imports")) return { rows: [] };
      if (statement.includes("FROM bank_external_accounts external") && statement.includes("external.id = $2")) {
        expect(parameters?.[0]).toBe(organizationId);
        expect(parameters?.[2]).toBe(legalEntityId);
        return { rows: [{
          id: externalAccountId,
          connection_id: connectionId,
          credential_version: 1,
          active: true,
          account_kind: "CASH",
          currency_code: "CAD",
          legal_entity_id: legalEntityId,
          ledger_id: ledgerId,
          cash_account_combination_id: combinationId,
        }] };
      }
      if (statement.includes("FROM account_combinations combination")) return { rows: [{ allowed: true }] };
      if (statement.includes("FROM bank_reconciliation_sessions") && statement.includes("statement_start_on <=")) {
        return { rows: [{
          id: "10000000-0000-4000-8000-000000000013",
          statement_start_on: "2026-08-01",
          statement_end_on: "2026-08-31",
          opening_balance: "100.000000000",
          closing_balance: "110.000000000",
          currency_code: "CAD",
          status: "FINALIZED",
        }] };
      }
      throw new Error("Unexpected SQL: " + statement);
    });

    await expect(importBankStatementInTransaction(
      { query } as unknown as PoolClient,
      command(),
    )).rejects.toMatchObject({ code: "RECONCILIATION_PERIOD_LOCKED", status: 409 });

    const statements = query.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((statement) => statement.includes("INSERT INTO bank_observations"))).toBe(false);
    expect(statements.some((statement) => statement.includes("INSERT INTO bank_sync_runs"))).toBe(false);
  });

  it("rejects a new account mapping outside the inbox company before any banking mutation", async () => {
    const otherEntityId = "10000000-0000-4000-8000-000000000099";
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM bank_statement_imports")) return { rows: [] };
      throw new Error("Unexpected SQL: " + statement);
    });

    await expect(importBankStatementInTransaction(
      { query } as unknown as PoolClient,
      command({
        mapping: {
          mode: "CREATE_OR_REUSE_ACCOUNT",
          legalEntityId: otherEntityId,
          ledgerId,
          accountCombinationId: combinationId,
        },
      }),
    )).rejects.toMatchObject({ code: "STATEMENT_ACCOUNT_ENTITY_MISMATCH", status: 400 });

    const statements = query.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((statement) => statement.includes("INSERT INTO bank_"))).toBe(false);
    expect(mocks.loadActiveOrganizationKey).toHaveBeenCalledTimes(1);
  });

  it("rejects an inactive retained file-import account before creating observations", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("FROM account_combinations combination")) return { rows: [{ allowed: true }] };
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM bank_statement_imports")) return { rows: [] };
      if (statement.includes("FROM bank_connections") && statement.includes("provider = 'FILE_IMPORT'")) {
        return { rows: [{ id: connectionId, credential_version: 1, status: "ACTIVE" }] };
      }
      if (statement.includes("provider_account_id_hash = $3")) {
        return { rows: [{
          id: externalAccountId,
          connection_id: connectionId,
          credential_version: 1,
          active: false,
          account_kind: "CASH",
          currency_code: "CAD",
          legal_entity_id: legalEntityId,
          ledger_id: ledgerId,
          cash_account_combination_id: combinationId,
        }] };
      }
      throw new Error("Unexpected SQL: " + statement);
    });

    await expect(importBankStatementInTransaction(
      { query } as unknown as PoolClient,
      command({
        mapping: {
          mode: "CREATE_OR_REUSE_ACCOUNT",
          legalEntityId,
          ledgerId,
          accountCombinationId: combinationId,
        },
      }),
    )).rejects.toMatchObject({ code: "STATEMENT_ACCOUNT_INACTIVE", status: 409 });

    expect(query.mock.calls.some(([statement]) => String(statement).includes("INSERT INTO bank_observations"))).toBe(false);
  });

  it("returns the newly dropped evidence for a duplicate source without creating observations", async () => {
    const originalEvidenceAssetId = "10000000-0000-4000-8000-000000000099";
    const existingImportId = "10000000-0000-4000-8000-000000000098";
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM bank_statement_imports")
        && statement.includes("inbox_item_id = $2")) {
        return { rows: [] };
      }
      if (statement.includes("FROM bank_external_accounts external")
        && statement.includes("external.id = $2")) {
        return { rows: [{
          id: externalAccountId,
          connection_id: connectionId,
          credential_version: 1,
          active: true,
          account_kind: "CASH",
          currency_code: "CAD",
          legal_entity_id: legalEntityId,
          ledger_id: ledgerId,
          cash_account_combination_id: combinationId,
        }] };
      }
      if (statement.includes("FROM account_combinations combination")) {
        return { rows: [{ allowed: true }] };
      }
      if (statement.includes("FROM bank_statement_imports")
        && statement.includes("external_account_id = $2")) {
        return { rows: [{
          id: existingImportId,
          reconciliation_session_id: "10000000-0000-4000-8000-000000000013",
          evidence_asset_id: originalEvidenceAssetId,
          included_row_count: 1,
        }] };
      }
      throw new Error("Unexpected SQL: " + statement);
    });

    const result = await importBankStatementInTransaction(
      { query } as unknown as PoolClient,
      command(),
    );
    expect(result).toMatchObject({
      statementImportId: existingImportId,
      evidenceAssetId,
      importedRowCount: 0,
      duplicateRowCount: 1,
      duplicateSource: true,
    });
    expect(result.evidenceAssetId).not.toBe(originalEvidenceAssetId);
    expect(query.mock.calls.some(([statement]) =>
      String(statement).includes("INSERT INTO bank_observations"))).toBe(false);
  });

  it("creates immutable observations and a draft reconciliation without posting a journal", async () => {
    let statementImportLookup = 0;
    let observationLookup = 0;
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (statement.includes("FROM bank_statement_imports")) {
        statementImportLookup += 1;
        return { rows: [] };
      }
      if (statement.includes("FROM bank_external_accounts external") && statement.includes("external.id = $2")) {
        return { rows: [{
          id: externalAccountId,
          connection_id: connectionId,
          credential_version: 1,
          active: true,
          account_kind: "CASH",
          currency_code: "CAD",
          legal_entity_id: legalEntityId,
          ledger_id: ledgerId,
          cash_account_combination_id: combinationId,
        }] };
      }
      if (statement.includes("FROM account_combinations combination")) return { rows: [{ allowed: true }] };
      if (statement.includes("FROM bank_reconciliation_sessions") && statement.includes("statement_start_on <=")) return { rows: [] };
      if (statement.includes("FROM bank_reconciliation_sessions") && statement.includes("statement_end_on <")) return { rows: [] };
      if (statement.includes("FROM bank_reconciliation_sessions") && statement.includes("statement_start_on >")) return { rows: [] };
      if (statement.includes("FROM bank_sync_runs")) return { rows: [] };
      if (statement.includes("SELECT id FROM bank_observations")) {
        observationLookup += 1;
        return { rows: observationLookup === 1 ? [] : [{ id: observationId }] };
      }
      if (statement.includes("FROM bank_observation_versions") && statement.includes("content_hash")) return { rows: [] };
      if (statement.includes("coalesce(max(version_number)")) return { rows: [{ next_version: 1 }] };
      if (statement.includes("SELECT source.id AS source_version_id")) return { rows: [] };
      return { rows: [] };
    });

    const result = await importBankStatementInTransaction(
      { query } as unknown as PoolClient,
      command(),
    );
    const statements = query.mock.calls.map(([statement]) => String(statement));

    expect(statementImportLookup).toBe(2);
    expect(result.importedRowCount).toBe(1);
    expect(result.duplicateRowCount).toBe(0);
    expect(statements.some((statement) => statement.includes("INSERT INTO bank_observations"))).toBe(true);
    expect(statements.some((statement) => statement.includes("INSERT INTO bank_statement_import_rows"))).toBe(true);
    const rowInsert = query.mock.calls.find(([statement]) => String(statement).includes("INSERT INTO bank_statement_import_rows"));
    expect(rowInsert?.[1]?.[4]).not.toBe(previewBankStatementExtraction(extraction).rows[0]?.fingerprint);
    expect(statements.some((statement) => statement.includes("INSERT INTO bank_reconciliation_sessions"))).toBe(true);
    expect(statements.some((statement) => statement.includes("journal_entries") || statement.includes("journal_lines"))).toBe(false);
    const mappingValidation = statements.find((statement) => statement.includes("FROM account_combinations combination"));
    expect(mappingValidation).not.toContain("FOR SHARE");
  });

  it.each([
    {
      label: "RBC Mastercard 6256",
      accountKind: "CREDIT_CARD" as const,
      balanceConvention: "POSITIVE_AMOUNT_OWED" as const,
      combination: combinationId,
      count: 53,
      closingBalance: "16.39",
      smallAmount: "0.01",
      finalAmount: "15.87",
      direction: "DECREASE" as const,
      sourceKind: "PURCHASE" as const,
    },
    {
      label: "RBC Current Account",
      accountKind: "CASH" as const,
      balanceConvention: "SIGNED_ACCOUNT_BALANCE" as const,
      combination: combinationId,
      count: 38,
      closingBalance: "35.05",
      smallAmount: "0.05",
      finalAmount: "33.20",
      direction: "INCREASE" as const,
      sourceKind: "DEPOSIT" as const,
    },
  ])("imports the exact balanced $label row count through CREATE_OR_REUSE_ACCOUNT", async (scenario) => {
    const productionExtraction = {
      extractionVersion: "finlynq.statement.v1" as const,
      institution: "Royal Bank of Canada",
      maskedAccount: scenario.accountKind === "CASH" ? "Current Account" : "****6256",
      accountKind: scenario.accountKind,
      currency: "CAD",
      statementStartOn: scenario.accountKind === "CASH" ? "2025-01-30" : "2025-02-10",
      statementEndOn: "2026-07-21",
      balanceConvention: scenario.balanceConvention,
      openingBalance: "0.00",
      closingBalance: scenario.closingBalance,
      rows: Array.from({ length: scenario.count }, (_, index) => ({
        rowNumber: index + 1,
        postedOn: "2026-07-01",
        direction: scenario.direction,
        sourceKind: scenario.sourceKind,
        amount: index === scenario.count - 1 ? scenario.finalAmount : scenario.smallAmount,
        reference: `RBC-${index + 1}`,
      })),
    };
    const preview = previewBankStatementExtraction(productionExtraction);
    expect(preview).toMatchObject({ readyToImport: true, includedRowCount: scenario.count, movementDifference: "0.000000000" });

    let connection = connectionId;
    let external = externalAccountId;
    let observationLookup = 0;
    const query = vi.fn(async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("FROM account_combinations combination")) return { rows: [{ allowed: true }] };
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM bank_statement_imports")) return { rows: [] };
      if (statement.includes("FROM bank_connections") && statement.includes("provider = 'FILE_IMPORT'")) return { rows: [] };
      if (statement.includes("INSERT INTO bank_connections(")) {
        connection = String(parameters?.[0]);
        return { rows: [] };
      }
      if (statement.includes("provider_account_id_hash = $3")) return { rows: [] };
      if (statement.includes("INSERT INTO bank_external_accounts(")) {
        external = String(parameters?.[0]);
        return { rows: [] };
      }
      if (statement.includes("FROM bank_external_accounts external") && statement.includes("external.id = $2")) {
        return { rows: [{
          id: external,
          connection_id: connection,
          credential_version: 1,
          active: true,
          account_kind: scenario.accountKind,
          currency_code: "CAD",
          legal_entity_id: legalEntityId,
          ledger_id: ledgerId,
          cash_account_combination_id: scenario.combination,
        }] };
      }
      if (statement.includes("FROM bank_reconciliation_sessions")) return { rows: [] };
      if (statement.includes("FROM bank_sync_runs")) return { rows: [] };
      if (statement.includes("SELECT id FROM bank_observations")) {
        observationLookup += 1;
        return { rows: observationLookup % 2 === 1 ? [] : [{ id: observationId }] };
      }
      if (statement.includes("FROM bank_observation_versions") && statement.includes("content_hash")) return { rows: [] };
      if (statement.includes("coalesce(max(version_number)")) return { rows: [{ next_version: 1 }] };
      if (statement.includes("SELECT source.id AS source_version_id")) return { rows: [] };
      return { rows: [] };
    });

    const result = await importBankStatementInTransaction(
      { query } as unknown as PoolClient,
      command({
        extraction: productionExtraction,
        previewHash: preview.previewHash,
        mapping: {
          mode: "CREATE_OR_REUSE_ACCOUNT",
          legalEntityId,
          ledgerId,
          accountCombinationId: scenario.combination,
        },
      }),
    );
    const statements = query.mock.calls.map(([statement]) => String(statement));
    expect(result).toMatchObject({ importedRowCount: scenario.count, duplicateRowCount: 0 });
    expect(statements.filter((statement) => statement.includes("INSERT INTO bank_observations"))).toHaveLength(scenario.count);
    expect(statements.filter((statement) => statement.includes("INSERT INTO bank_statement_import_rows"))).toHaveLength(scenario.count);
    expect(statements.filter((statement) => statement.includes("INSERT INTO bank_connections("))).toHaveLength(1);
    expect(statements.filter((statement) => statement.includes("INSERT INTO bank_external_accounts("))).toHaveLength(1);
    expect(statements.filter((statement) => statement.includes("INSERT INTO bank_reconciliation_sessions"))).toHaveLength(1);
    expect(statements.some((statement) => statement.includes("journal_entries") || statement.includes("journal_lines"))).toBe(false);
    expect(statements.find((statement) => statement.includes("FROM account_combinations combination"))).not.toContain("FOR SHARE");
  });
});
