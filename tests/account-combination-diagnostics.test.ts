import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  loadAccountCombinations,
  type AccountCombinationValidationReference,
} from "@/modules/subledger/ar-ap-accounting";
import {
  AccountCombinationValidationError,
  safeSubledgerValidationDetails,
} from "@/modules/subledger/validation-errors";
import { mcpToolFailureResult } from "@/modules/mcp/tool-types";

const id = (value: number) =>
  "92000000-0000-4000-8000-" + String(value).padStart(12, "0");

type DetailRow = Readonly<{
  id: string;
  ledger_id: string;
  entity_id: string;
  combination_active: boolean;
  account_id: string;
  account_code: string | null;
  account_name: string | null;
  account_active: boolean | null;
  account_postable: boolean | null;
  valid_from: string | null;
  valid_to: string | null;
  account_class: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE" | null;
  control_kind: "NONE" | "AR" | "AP" | null;
}>;

const ledgerId = id(1);
const legalEntityId = id(2);
const accountingDate = "2025-12-15";

function row(
  value: number,
  patch: Partial<DetailRow> = {},
): DetailRow {
  return {
    id: id(value),
    ledger_id: ledgerId,
    entity_id: legalEntityId,
    combination_active: true,
    account_id: id(value + 100),
    account_code: String(6000 + value),
    account_name: "Tenant account " + value,
    account_active: true,
    account_postable: true,
    valid_from: accountingDate,
    valid_to: accountingDate,
    account_class: "EXPENSE",
    control_kind: "NONE",
    ...patch,
  };
}

function client(rows: readonly DetailRow[]) {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as PoolClient;
}

async function rejection(
  rows: readonly DetailRow[],
  references: readonly AccountCombinationValidationReference[],
): Promise<AccountCombinationValidationError> {
  try {
    await loadAccountCombinations(client(rows), {
      organizationId: id(900),
      ledgerId,
      legalEntityId,
      accountingDate,
      references,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(AccountCombinationValidationError);
    return error as AccountCombinationValidationError;
  }
  throw new Error("Expected validation to fail");
}

describe("account-combination diagnostics", () => {
  it("accepts exact valid-from and valid-to boundaries", async () => {
    const account = row(10);
    const result = await loadAccountCombinations(client([account]), {
      organizationId: id(900),
      ledgerId,
      legalEntityId,
      accountingDate,
      references: [{
        field: "lines[0].accountCombinationId",
        lineNumber: 1,
        combinationId: account.id,
        expectedControlKinds: ["NONE"],
        expectedAccountClasses: ["EXPENSE", "ASSET"],
      }],
    });

    expect(result.get(account.id)).toEqual({
      id: account.id,
      account_id: account.account_id,
      account_class: "EXPENSE",
      control_kind: "NONE",
    });
  });

  it("returns every field failure with safe tenant-authorized metadata", async () => {
    const futureControl = row(11, {
      valid_from: "2026-01-01",
      valid_to: null,
      account_class: "LIABILITY",
      control_kind: "AP",
    });
    const expiredInactive = row(12, {
      combination_active: false,
      account_active: false,
      account_postable: false,
      valid_from: "2025-01-01",
      valid_to: "2025-12-14",
    });
    const wrongScope = row(13, {
      ledger_id: id(50),
      entity_id: id(51),
    });
    const missingOrForeignId = id(14);

    const error = await rejection(
      [futureControl, expiredInactive, wrongScope],
      [
        {
          field: "lines[0].accountCombinationId",
          lineNumber: 1,
          combinationId: futureControl.id,
          expectedControlKinds: ["NONE"],
          expectedAccountClasses: ["EXPENSE", "ASSET"],
        },
        {
          field: "taxAccountCombinationId",
          combinationId: expiredInactive.id,
          expectedControlKinds: ["NONE"],
          expectedAccountClasses: ["ASSET", "EXPENSE"],
        },
        {
          field: "fxRoundingAccountCombinationId",
          combinationId: wrongScope.id,
          expectedControlKinds: ["NONE"],
        },
        {
          field: "lines[1].accountCombinationId",
          lineNumber: 2,
          combinationId: missingOrForeignId,
          expectedControlKinds: ["NONE"],
        },
      ],
    );

    expect(error.failures).toHaveLength(4);
    expect(error.failures[0]).toMatchObject({
      field: "lines[0].accountCombinationId",
      lineNumber: 1,
      accountCode: futureControl.account_code,
      accountName: futureControl.account_name,
      active: true,
      validFrom: "2026-01-01",
      validTo: null,
      ledgerMismatch: false,
      entityMismatch: false,
      evaluatedAccountingDate: accountingDate,
      failureCodes: ["FUTURE_DATED", "WRONG_CONTROL_KIND", "WRONG_ACCOUNT_CLASS"],
    });
    expect(error.failures[1]?.failureCodes).toEqual([
      "COMBINATION_INACTIVE",
      "ACCOUNT_INACTIVE",
      "ACCOUNT_NOT_POSTABLE",
      "EXPIRED",
    ]);
    expect(error.failures[2]).toMatchObject({
      ledgerMismatch: true,
      entityMismatch: true,
      failureCodes: ["WRONG_LEDGER", "WRONG_ENTITY"],
    });
    expect(error.failures[3]).toMatchObject({
      combinationId: missingOrForeignId,
      accountCode: null,
      accountName: null,
      active: null,
      combinationActive: null,
      accountActive: null,
      postable: null,
      validFrom: null,
      validTo: null,
      ledgerMismatch: null,
      entityMismatch: null,
      failureCodes: ["NOT_FOUND_OR_UNAUTHORIZED"],
    });
  });

  it("distinguishes a same-tenant party-control mismatch without exposing foreign IDs", async () => {
    const control = row(20, {
      account_class: "LIABILITY",
      control_kind: "AR",
    });
    const error = await rejection([control], [{
      field: "controlAccountCombinationId",
      combinationId: control.id,
      expectedAccountId: id(999),
      expectedControlKinds: ["AP"],
    }]);

    expect(error.failures[0]).toMatchObject({
      accountCode: control.account_code,
      failureCodes: ["WRONG_CONTROL_KIND", "PARTY_CONTROL_ACCOUNT_MISMATCH"],
    });
    expect(safeSubledgerValidationDetails(error)).toMatchObject({
      code: "ACCOUNT_COMBINATION_INVALID",
      remediation: expect.stringContaining("do not change the accounting date"),
      accountCombinationFailures: error.failures,
    });
  });

  it("preserves reviewed failures in the MCP structured error envelope", async () => {
    const error = await rejection([], [{
      field: "lines[0].accountCombinationId",
      lineNumber: 1,
      combinationId: id(70),
    }]);
    const result = mcpToolFailureResult(error);

    expect(result.structuredContent).toMatchObject({
      status: "failed",
      error: {
        code: "ACCOUNT_COMBINATION_INVALID",
        message: expect.stringContaining("account combinations"),
        remediation: expect.stringContaining("do not change the accounting date"),
        accountCombinationFailures: [{
          field: "lines[0].accountCombinationId",
          lineNumber: 1,
          combinationId: id(70),
          accountCode: null,
          failureCodes: ["NOT_FOUND_OR_UNAUTHORIZED"],
        }],
      },
    });
  });

  it("scopes the diagnostic lookup to the current organization", async () => {
    const database = client([]);
    const foreignId = id(77);
    await expect(loadAccountCombinations(database, {
      organizationId: id(900),
      ledgerId,
      legalEntityId,
      accountingDate,
      references: [{
        field: "lines[0].accountCombinationId",
        lineNumber: 1,
        combinationId: foreignId,
      }],
    })).rejects.toBeInstanceOf(AccountCombinationValidationError);

    expect((database.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[1])
      .toEqual([id(900), [foreignId]]);
  });
});
