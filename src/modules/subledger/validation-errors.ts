export const ACCOUNT_COMBINATION_REMEDIATION =
  "Select a tenant-owned combination for the requested ledger and legal entity that is active, postable, valid on the accounting date, and permitted for the request field. Update the accounting configuration when no such combination exists; do not change the accounting date merely to bypass configuration.";

export type AccountCombinationFailureCode =
  | "NOT_FOUND_OR_UNAUTHORIZED"
  | "WRONG_LEDGER"
  | "WRONG_ENTITY"
  | "COMBINATION_INACTIVE"
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_NOT_POSTABLE"
  | "FUTURE_DATED"
  | "EXPIRED"
  | "WRONG_CONTROL_KIND"
  | "WRONG_ACCOUNT_CLASS"
  | "PARTY_CONTROL_ACCOUNT_MISMATCH";

export type AccountCombinationFailure = Readonly<{
  field: string;
  lineNumber?: number;
  combinationId: string;
  accountCode: string | null;
  accountName: string | null;
  active: boolean | null;
  combinationActive: boolean | null;
  accountActive: boolean | null;
  postable: boolean | null;
  validFrom: string | null;
  validTo: string | null;
  ledgerMismatch: boolean | null;
  entityMismatch: boolean | null;
  evaluatedAccountingDate: string;
  failureCodes: readonly AccountCombinationFailureCode[];
  remediation: string;
}>;

export class AccountCombinationValidationError extends Error {
  readonly code = "ACCOUNT_COMBINATION_INVALID";

  constructor(readonly failures: readonly AccountCombinationFailure[]) {
    super("One or more account combinations are invalid for the requested accounting date or posting role.");
    this.name = "AccountCombinationValidationError";
  }
}

export type BusinessDocumentValidationCode =
  | "SIGNED_LINE_REQUIRES_ADJUSTMENT"
  | "NEGATIVE_SALES_LINE_UNSUPPORTED"
  | "SUPPLIER_CREDIT_NOTE_REQUIRED"
  | "ZERO_GROSS_UNSUPPORTED";

const BUSINESS_DOCUMENT_REMEDIATION: Readonly<Record<BusinessDocumentValidationCode, string>> = {
  SIGNED_LINE_REQUIRES_ADJUSTMENT:
    "Mark the negative supplier-bill line as ADJUSTMENT and retain its source description, account, tax facts, and evidence reference.",
  NEGATIVE_SALES_LINE_UNSUPPORTED:
    "Use the dedicated customer credit-note workflow when available; sales-invoice lines must remain positive.",
  SUPPLIER_CREDIT_NOTE_REQUIRED:
    "Record a net supplier credit through the dedicated supplier credit-note workflow when available; do not coerce it into a supplier bill.",
  ZERO_GROSS_UNSUPPORTED:
    "Remove or correct offsetting lines. FinLynQ does not create zero-gross AR/AP open items.",
};

export class BusinessDocumentValidationError extends Error {
  readonly remediation: string;

  constructor(
    readonly code: BusinessDocumentValidationCode,
    message: string,
    readonly lineNumber?: number,
  ) {
    super(message);
    this.name = "BusinessDocumentValidationError";
    this.remediation = BUSINESS_DOCUMENT_REMEDIATION[code];
  }
}

export type SafeSubledgerValidationDetails = Readonly<{
  code: "ACCOUNT_COMBINATION_INVALID" | BusinessDocumentValidationCode;
  message: string;
  remediation: string;
  lineNumber?: number;
  accountCombinationFailures?: readonly AccountCombinationFailure[];
}>;

export function safeSubledgerValidationDetails(
  error: unknown,
): SafeSubledgerValidationDetails | undefined {
  if (error instanceof AccountCombinationValidationError) {
    return {
      code: error.code,
      message: error.message,
      remediation: ACCOUNT_COMBINATION_REMEDIATION,
      accountCombinationFailures: error.failures,
    };
  }
  if (error instanceof BusinessDocumentValidationError) {
    return {
      code: error.code,
      message: error.message,
      remediation: error.remediation,
      ...(error.lineNumber === undefined ? {} : { lineNumber: error.lineNumber }),
    };
  }
  return undefined;
}
