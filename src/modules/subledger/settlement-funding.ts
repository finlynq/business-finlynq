import { z } from "zod";

export const settlementMethodSchema = z.enum([
  "BANK", "CORPORATE_CARD", "SHAREHOLDER_ADVANCE", "EMPLOYEE_REIMBURSEMENT", "OTHER_NON_CASH",
]);
export type SettlementMethod = z.infer<typeof settlementMethodSchema>;

export const SETTLEMENT_METHOD_LABELS: Readonly<Record<SettlementMethod, string>> = {
  BANK: "Bank / cash",
  CORPORATE_CARD: "Corporate card",
  SHAREHOLDER_ADVANCE: "Shareholder advance",
  EMPLOYEE_REIMBURSEMENT: "Employee reimbursement",
  OTHER_NON_CASH: "Other non-cash liability",
};

type FundingSelection = Readonly<{
  kind?: string;
  bankAccountCombinationId?: string;
  settlementAccountCombinationId?: string;
  settlementMethod?: SettlementMethod;
}>;

export function resolveSettlementFunding(input: FundingSelection): Readonly<{
  method: SettlementMethod;
  accountCombinationId: string;
  accountClass: "ASSET" | "LIABILITY";
}> {
  const method = input.settlementMethod ?? "BANK";
  const accountCombinationId = input.settlementAccountCombinationId ?? input.bankAccountCombinationId;
  if (!accountCombinationId) throw new Error("A settlement funding account is required");
  if (input.bankAccountCombinationId && input.settlementAccountCombinationId &&
      input.bankAccountCombinationId !== input.settlementAccountCombinationId) {
    throw new Error("Bank and settlement funding accounts must not conflict");
  }
  if (method !== "BANK" && (input.kind === "CUSTOMER_RECEIPT" || input.bankAccountCombinationId)) {
    throw new Error("Non-cash methods require a supplier settlementAccountCombinationId, not a bank mapping");
  }
  return { method, accountCombinationId, accountClass: method === "BANK" ? "ASSET" : "LIABILITY" };
}

export function validateSettlementFunding(input: FundingSelection, context: z.RefinementCtx): void {
  try {
    resolveSettlementFunding(input);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["settlementAccountCombinationId"], message: (error as Error).message });
  }
}

/** Preserve the exact pre-extension bank fingerprint, including legacy replays. */
export function normalizeSettlementFunding<T extends FundingSelection>(input: T): T {
  const funding = resolveSettlementFunding(input);
  if (funding.method !== "BANK") return input;
  const { settlementMethod: _method, settlementAccountCombinationId: _account, ...rest } = input;
  void _method;
  void _account;
  return { ...rest, bankAccountCombinationId: funding.accountCombinationId } as T;
}
