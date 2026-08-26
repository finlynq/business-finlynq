import type { PeriodState, PostingPurpose } from "@/modules/ledger/period-policy";
import type { TaxDecisionStatus } from "@/modules/tax/types";

export type DemoEntityCode = "CA01" | "US01";
export type DemoCurrency = "CAD" | "USD";
export type DemoAccountClass = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export type DemoTrialBalanceRow = Readonly<{
  id: string;
  entityCode: DemoEntityCode;
  currency: DemoCurrency;
  accountCode: string;
  accountKey: string;
  accountName: string;
  accountClass: DemoAccountClass;
  debit: string;
  credit: string;
}>;

export type DemoTrialBalanceReport = Readonly<{
  demoOnly: true;
  entityCode: DemoEntityCode;
  currency: DemoCurrency;
  rows: readonly DemoTrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}>;

export type DemoEntityDetail = Readonly<{
  id: string;
  code: DemoEntityCode;
  name: string;
  legalName: string;
  location: string;
  countryCode: "CA" | "US";
  regionCode: "ON" | "WA";
  profile: string;
  accountingProfile: "CAN_ASPE" | "US_GAAP_NONPUBLIC";
  currency: DemoCurrency;
  ledgerCode: "PRIMARY";
  ledgerName: string;
  period: string;
  periodState: "OPEN" | "ADJUSTMENT_ONLY";
  periodTone: "open" | "adjustment";
  periodStartsOn: string;
  periodEndsOn: string;
  yearEnd: string;
  trialBalance: string;
  trialBalanceAmount: string;
  openReceivables: string;
  openReceivablesAmount: string;
  openPayables: string;
  openPayablesAmount: string;
  closeProgress: number;
  taxRegistrations: readonly string[];
}>;

export type DemoPartyDetail = Readonly<{
  id: string;
  party: string;
  name: string;
  entity: string;
  roles: readonly string[];
  balance: string;
  status: "ACTIVE";
  email: string;
  phone: string;
  primaryAddress: Readonly<{
    line1: string;
    city: string;
    region: string;
    postalCode: string;
    country: "Canada" | "United States";
  }>;
  accounts: readonly Readonly<{
    entityCode: DemoEntityCode;
    role: "CUSTOMER" | "SUPPLIER" | "INTERCOMPANY";
    accountNumber: string;
    currency: DemoCurrency;
    openAmount: string;
  }>[];
}>;

export type DemoActor = Readonly<{
  id: string;
  displayName: string;
  initials: string;
  email: string;
  role: "VIEWER_AUDITOR";
  roleLabel: string;
  permissions: readonly string[];
  authMethod: "DEMO_SESSION";
  demoOnly: true;
}>;

export type DemoWriteState = Readonly<{
  mode: "READ_ONLY_DEMO";
  writesEnabled: false;
  persistentWrites: false;
  message: string;
}>;

export type DemoJournalLine = Readonly<{
  lineNumber: number;
  accountCode: string;
  accountKey: string;
  accountName: string;
  debitFunctional: string;
  creditFunctional: string;
  transactionCurrency: DemoCurrency;
  debitTransaction: string;
  creditTransaction: string;
  fxRate: string;
  memo: string;
}>;

export type DemoJournalStatus = "DRAFT" | "REVIEW" | "SUBMITTED" | "APPROVED" | "POSTED";

export type DemoJournalSummary = Readonly<{
  id: string;
  number: string;
  date: string;
  accountingDate: string;
  entity: DemoEntityCode;
  currency: DemoCurrency;
  type: string;
  typeKey: string;
  source: string;
  amount: string;
  status: DemoJournalStatus;
  owner: string;
  correctionRoute: string;
}>;

export type DemoJournalDetail = Readonly<{
  id: string;
  number: string;
  entityCode: DemoEntityCode;
  currency: DemoCurrency;
  accountingDate: string;
  description: string;
  typeKey: string;
  typeLabel: string;
  ownerModule: "ledger" | "receivables" | "payables";
  sourceDocument: string | null;
  status: DemoJournalStatus;
  origin: "USER" | "SYSTEM" | "MCP";
  purpose: PostingPurpose;
  editableInGeneralLedger: boolean;
  correctionRoute: string;
  relation: Readonly<{
    kind: "REVERSAL_OF" | "REPLACEMENT_OF";
    journalNumber: string;
  }> | null;
  lines: readonly DemoJournalLine[];
}>;

export type DemoReceivableInvoice = Readonly<{
  id: string;
  number: string;
  entityCode: DemoEntityCode;
  currency: DemoCurrency;
  customerPartyId: string;
  customerName: string;
  issuedOn: string;
  dueOn: string;
  subtotal: string;
  tax: string;
  total: string;
  openAmount: string;
  status: "DRAFT_REVIEW" | "ISSUED" | "PARTIALLY_PAID" | "PAID";
  taxDecisionStatus: TaxDecisionStatus;
  journalId: string | null;
}>;

export type DemoPayableBill = Readonly<{
  id: string;
  number: string;
  entityCode: DemoEntityCode;
  currency: DemoCurrency;
  supplierPartyId: string;
  supplierName: string;
  billDate: string;
  dueOn: string;
  subtotal: string;
  tax: string;
  total: string;
  openAmount: string;
  status: "DRAFT_REVIEW" | "APPROVED" | "PARTIALLY_PAID" | "PAID";
  journalId: string | null;
}>;

export type DemoTaxException = Readonly<{
  id: string;
  entityCode: DemoEntityCode;
  sourceDocument: string;
  jurisdiction: string;
  packKey: string;
  packVersion: string;
  status: "MANUAL_REVIEW_REQUIRED";
  reviewReason: string;
  blocksClose: true;
}>;

export type DemoCloseCheck = Readonly<{
  key: string;
  label: string;
  status: "PASS" | "BLOCKED" | "UNAVAILABLE";
  detail: string;
}>;

export type DemoClosePackage = Readonly<{
  id: string;
  entityCode: DemoEntityCode;
  currency: DemoCurrency;
  periodLabel: string;
  periodState: PeriodState;
  generatedAt: string;
  readinessPercent: number;
  demoOnly: true;
  checks: readonly DemoCloseCheck[];
  blockers: readonly Readonly<{
    key: string;
    label: string;
    detail: string;
    route: string;
  }>[];
}>;

export type DemoSearchKind =
  | "entity"
  | "journal"
  | "invoice"
  | "bill"
  | "party"
  | "tax-exception"
  | "report"
  | "control";

export type DemoSearchEntry = Readonly<{
  id: string;
  kind: DemoSearchKind;
  title: string;
  subtitle: string;
  keywords: readonly string[];
  href: string;
  entityCode: DemoEntityCode | null;
}>;

export type DemoSearchOptions = Readonly<{
  kinds?: readonly DemoSearchKind[];
  entityCode?: DemoEntityCode;
  limit?: number;
}>;

export type DemoManualJournalPreviewLine = Readonly<{
  accountCode: string;
  accountName?: string;
  debitFunctional: string;
  creditFunctional: string;
  memo?: string;
}>;

export type DemoManualJournalPreviewInput = Readonly<{
  entityCode: string;
  accountingDate: string;
  description: string;
  purpose: PostingPurpose;
  canPostAdjustment: boolean;
  lines: readonly DemoManualJournalPreviewLine[];
}>;

export type DemoPreviewIssue = Readonly<{
  code: string;
  message: string;
  line?: number;
}>;

export type DemoManualJournalPreviewResult = Readonly<{
  valid: boolean;
  demoOnly: true;
  wouldPersist: false;
  entityCode: string;
  currency: DemoCurrency | null;
  periodState: PeriodState | null;
  totalDebit: string;
  totalCredit: string;
  issues: readonly DemoPreviewIssue[];
}>;
