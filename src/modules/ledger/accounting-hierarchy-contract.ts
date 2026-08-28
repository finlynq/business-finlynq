/** Client-safe identifiers and DTOs for presentation-only accounting trees. */
export const accountingHierarchyDimensionKeys = [
  "entity",
  "account",
  "subaccount",
  "department",
  "intercompany",
  "custom1",
  "custom2",
  "custom3",
  "custom4",
  "custom5",
  "custom6",
  "custom7",
  "custom8",
] as const;

export type AccountingHierarchyDimensionKey =
  (typeof accountingHierarchyDimensionKeys)[number];

export const financialStatementClasses = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "EXPENSE",
] as const;

export type FinancialStatementClass = (typeof financialStatementClasses)[number];

export const defaultFinancialStatementGroups = [
  { code: "CURRENT_ASSETS", displayName: "Current assets", statementClass: "ASSET" },
  { code: "CURRENT_LIABILITIES", displayName: "Current liabilities", statementClass: "LIABILITY" },
  { code: "OWNER_EQUITY", displayName: "Owner equity", statementClass: "EQUITY" },
  { code: "OPERATING_REVENUE", displayName: "Operating revenue", statementClass: "REVENUE" },
  { code: "OTHER_INCOME", displayName: "Other income", statementClass: "REVENUE" },
  { code: "OPERATING_EXPENSES", displayName: "Operating expenses", statementClass: "EXPENSE" },
  { code: "OTHER_LOSSES", displayName: "Other losses", statementClass: "EXPENSE" },
] as const;

export function defaultFinancialStatementGroupCode(
  accountClass: string,
  accountCode: string,
): string {
  if (accountClass === "ASSET") return "CURRENT_ASSETS";
  if (accountClass === "LIABILITY") return "CURRENT_LIABILITIES";
  if (accountClass === "EQUITY") return "OWNER_EQUITY";
  if (accountClass === "REVENUE") {
    return accountCode.startsWith("49") ? "OTHER_INCOME" : "OPERATING_REVENUE";
  }
  return accountCode.startsWith("71") ? "OTHER_LOSSES" : "OPERATING_EXPENSES";
}

export type AccountingHierarchyMemberType = "ACCOUNT" | "SEGMENT_VALUE" | "ENTITY";

export type AccountingHierarchyNodeDto = Readonly<{
  id: string;
  parentId: string | null;
  code: string;
  displayName: string;
  sortOrder: number;
  statementClass: FinancialStatementClass | null;
  memberType: AccountingHierarchyMemberType | null;
  memberId: string | null;
}>;

export type AccountingHierarchyDto = Readonly<{
  id: string;
  dimensionKey: AccountingHierarchyDimensionKey;
  ledgerId: string | null;
  code: string;
  displayName: string;
  version: number;
  revision: number;
  status: "DRAFT" | "PUBLISHED";
  basedOnHierarchyId: string | null;
  effectiveFrom: string | null;
  createdAt: string;
  publishedAt: string | null;
  nodes: readonly AccountingHierarchyNodeDto[];
}>;
