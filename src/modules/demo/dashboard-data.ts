import { renderAccountKey } from "@/modules/ledger/account-segments";
import { decideTax } from "@/modules/tax/engine";
import type { TaxDecision } from "@/modules/tax/types";
import type {
  DemoActor,
  DemoClosePackage,
  DemoCurrency,
  DemoEntityCode,
  DemoEntityDetail,
  DemoJournalDetail,
  DemoJournalLine,
  DemoJournalSummary,
  DemoPartyDetail,
  DemoPayableBill,
  DemoReceivableInvoice,
  DemoSearchEntry,
  DemoTaxException,
  DemoTrialBalanceRow,
  DemoWriteState,
} from "./types";

const DEMO_GENERATED_AT = "2026-08-26T14:00:00.000Z";

function accountKey(entity: DemoEntityCode, account: string): string {
  return renderAccountKey({
    entity,
    account,
    subaccount: null,
    department: null,
    intercompany: null,
    custom1: null,
    custom2: null,
    custom3: null,
    custom4: null,
    custom5: null,
    custom6: null,
    custom7: null,
    custom8: null,
  });
}

function journalLine(
  lineNumber: number,
  entity: DemoEntityCode,
  currency: DemoCurrency,
  accountCode: string,
  accountName: string,
  debit: string,
  credit: string,
  memo: string,
): DemoJournalLine {
  return {
    lineNumber,
    accountCode,
    accountKey: accountKey(entity, accountCode),
    accountName,
    debitFunctional: debit,
    creditFunctional: credit,
    transactionCurrency: currency,
    debitTransaction: debit,
    creditTransaction: credit,
    fxRate: "1.000000000000000000",
    memo,
  };
}

const ontarioTax = decideTax("ca.on.hst", {
  direction: "SALE",
  taxPointDate: "2026-08-26",
  currency: "CAD",
  taxableBasis: "100.00",
  destinationCountry: "CA",
  destinationRegion: "ON",
  category: "STANDARD",
  registrationId: "demo-ca-registration",
});

const seattleTax = decideTax("us.wa.sales-use", {
  direction: "SALE",
  taxPointDate: "2026-08-26",
  currency: "USD",
  taxableBasis: "100.00",
  destinationCountry: "US",
  destinationRegion: "WA",
  destinationCity: "Seattle",
  locationCode: "1726",
  category: "STANDARD",
});

const ontarioReview = decideTax("ca.on.hst", {
  direction: "SALE",
  taxPointDate: "2026-08-26",
  currency: "CAD",
  taxableBasis: "2400.00",
  destinationCountry: "CA",
  destinationRegion: "ON",
  category: "STANDARD",
});

const washingtonReview = decideTax("us.wa.sales-use", {
  direction: "SALE",
  taxPointDate: "2026-08-26",
  currency: "USD",
  taxableBasis: "3200.00",
  destinationCountry: "US",
  destinationRegion: "WA",
  destinationCity: "Bellevue",
  locationCode: "UNVERIFIED",
  category: "STANDARD",
});

function taxException(
  id: string,
  entityCode: DemoEntityCode,
  sourceDocument: string,
  jurisdiction: string,
  decision: TaxDecision,
): DemoTaxException {
  if (decision.status !== "MANUAL_REVIEW_REQUIRED" || !decision.reviewReason) {
    throw new Error(`Demo tax exception ${id} must remain a manual-review decision`);
  }

  return {
    id,
    entityCode,
    sourceDocument,
    jurisdiction,
    packKey: decision.packKey,
    packVersion: decision.packVersion,
    status: decision.status,
    reviewReason: decision.reviewReason,
    blocksClose: true,
  };
}

export const demoCurrentActor: DemoActor = {
  id: "demo-user-viewer",
  displayName: "Demo viewer",
  initials: "DV",
  email: "viewer@northstar.demo.invalid",
  role: "VIEWER_AUDITOR",
  roleLabel: "Read-only viewer and auditor",
  permissions: [],
  authMethod: "DEMO_SESSION",
  demoOnly: true,
};

export const demoWriteState: DemoWriteState = {
  mode: "READ_ONLY_DEMO",
  writesEnabled: false,
  persistentWrites: false,
  message: "Demo interactions never write accounting records or change period state.",
};

export const demoEntityDetails: readonly DemoEntityDetail[] = [
  {
    id: "demo-entity-ca01",
    code: "CA01",
    name: "Northstar Services Canada Inc.",
    legalName: "Northstar Services Canada Inc.",
    location: "Ontario, Canada",
    countryCode: "CA",
    regionCode: "ON",
    profile: "Canadian ASPE",
    accountingProfile: "CAN_ASPE",
    currency: "CAD",
    ledgerCode: "PRIMARY",
    ledgerName: "CA primary ledger",
    period: "Aug 2026",
    periodState: "OPEN",
    periodTone: "open",
    periodStartsOn: "2026-08-01",
    periodEndsOn: "2026-08-31",
    yearEnd: "December 31",
    trialBalance: "$252,710.35",
    trialBalanceAmount: "252710.35",
    openReceivables: "$84,210.35",
    openReceivablesAmount: "84210.35",
    openPayables: "$41,870.12",
    openPayablesAmount: "41870.12",
    closeProgress: 68,
    taxRegistrations: ["Ontario GST/HST - demo registration"],
  },
  {
    id: "demo-entity-us01",
    code: "US01",
    name: "Northstar Services USA LLC",
    legalName: "Northstar Services USA LLC",
    location: "Washington, United States",
    countryCode: "US",
    regionCode: "WA",
    profile: "U.S. GAAP - non-public",
    accountingProfile: "US_GAAP_NONPUBLIC",
    currency: "USD",
    ledgerCode: "PRIMARY",
    ledgerName: "US primary ledger",
    period: "Aug 2026",
    periodState: "ADJUSTMENT_ONLY",
    periodTone: "adjustment",
    periodStartsOn: "2026-08-01",
    periodEndsOn: "2026-08-31",
    yearEnd: "December 31",
    trialBalance: "$235,940.20",
    trialBalanceAmount: "235940.20",
    openReceivables: "$65,590.20",
    openReceivablesAmount: "65590.20",
    openPayables: "$37,430.48",
    openPayablesAmount: "37430.48",
    closeProgress: 72,
    taxRegistrations: ["Washington sales tax - demo registration"],
  },
];

export const demoTrialBalanceRows: readonly DemoTrialBalanceRow[] = [
  { id: "tb-ca-1000", entityCode: "CA01", currency: "CAD", accountCode: "1000", accountKey: accountKey("CA01", "1000"), accountName: "Cash", accountClass: "ASSET", debit: "146500.00", credit: "0.00" },
  { id: "tb-ca-1100", entityCode: "CA01", currency: "CAD", accountCode: "1100", accountKey: accountKey("CA01", "1100"), accountName: "Accounts receivable", accountClass: "ASSET", debit: "84210.35", credit: "0.00" },
  { id: "tb-ca-2100", entityCode: "CA01", currency: "CAD", accountCode: "2100", accountKey: accountKey("CA01", "2100"), accountName: "Accounts payable", accountClass: "LIABILITY", debit: "0.00", credit: "41870.12" },
  { id: "tb-ca-2210", entityCode: "CA01", currency: "CAD", accountCode: "2210", accountKey: accountKey("CA01", "2210"), accountName: "HST payable", accountClass: "LIABILITY", debit: "0.00", credit: "12840.23" },
  { id: "tb-ca-3100", entityCode: "CA01", currency: "CAD", accountCode: "3100", accountKey: accountKey("CA01", "3100"), accountName: "Retained earnings", accountClass: "EQUITY", debit: "0.00", credit: "100000.00" },
  { id: "tb-ca-4100", entityCode: "CA01", currency: "CAD", accountCode: "4100", accountKey: accountKey("CA01", "4100"), accountName: "Service revenue", accountClass: "REVENUE", debit: "0.00", credit: "98000.00" },
  { id: "tb-ca-6100", entityCode: "CA01", currency: "CAD", accountCode: "6100", accountKey: accountKey("CA01", "6100"), accountName: "Operating expenses", accountClass: "EXPENSE", debit: "22000.00", credit: "0.00" },
  { id: "tb-us-1000", entityCode: "US01", currency: "USD", accountCode: "1000", accountKey: accountKey("US01", "1000"), accountName: "Cash", accountClass: "ASSET", debit: "128350.00", credit: "0.00" },
  { id: "tb-us-1100", entityCode: "US01", currency: "USD", accountCode: "1100", accountKey: accountKey("US01", "1100"), accountName: "Accounts receivable", accountClass: "ASSET", debit: "65590.20", credit: "0.00" },
  { id: "tb-us-1400", entityCode: "US01", currency: "USD", accountCode: "1400", accountKey: accountKey("US01", "1400"), accountName: "Prepaid expenses", accountClass: "ASSET", debit: "5000.00", credit: "0.00" },
  { id: "tb-us-2100", entityCode: "US01", currency: "USD", accountCode: "2100", accountKey: accountKey("US01", "2100"), accountName: "Accounts payable", accountClass: "LIABILITY", debit: "0.00", credit: "37430.48" },
  { id: "tb-us-2220", entityCode: "US01", currency: "USD", accountCode: "2220", accountKey: accountKey("US01", "2220"), accountName: "Sales tax payable", accountClass: "LIABILITY", debit: "0.00", credit: "8509.72" },
  { id: "tb-us-3100", entityCode: "US01", currency: "USD", accountCode: "3100", accountKey: accountKey("US01", "3100"), accountName: "Members' equity", accountClass: "EQUITY", debit: "0.00", credit: "90000.00" },
  { id: "tb-us-4100", entityCode: "US01", currency: "USD", accountCode: "4100", accountKey: accountKey("US01", "4100"), accountName: "Service revenue", accountClass: "REVENUE", debit: "0.00", credit: "100000.00" },
  { id: "tb-us-6100", entityCode: "US01", currency: "USD", accountCode: "6100", accountKey: accountKey("US01", "6100"), accountName: "Operating expenses", accountClass: "EXPENSE", debit: "37000.00", credit: "0.00" },
];

export const demoJournals: readonly DemoJournalSummary[] = [
  { id: "journal-ca-291", number: "CA-000291", date: "Aug 26", accountingDate: "2026-08-26", entity: "CA01", currency: "CAD", type: "Sales invoice", typeKey: "receivables.sales-invoice", source: "INV-1048", amount: "CAD 11,300.00", status: "POSTED", owner: "Receivables", correctionRoute: "/receivables/invoices/INV-1048" },
  { id: "journal-us-188", number: "US-000188", date: "Aug 26", accountingDate: "2026-08-26", entity: "US01", currency: "USD", type: "Supplier bill", typeKey: "payables.supplier-bill", source: "BILL-0882", amount: "USD 4,850.00", status: "POSTED", owner: "Payables", correctionRoute: "/payables/bills/BILL-0882" },
  { id: "journal-draft-17", number: "Draft", date: "Aug 26", accountingDate: "2026-08-26", entity: "CA01", currency: "CAD", type: "Manual journal", typeKey: "ledger.manual", source: "MCP-DRAFT-17", amount: "CAD 1,250.00", status: "REVIEW", owner: "General ledger", correctionRoute: "/journals/journal-draft-17" },
  { id: "journal-ca-290", number: "CA-000290", date: "Aug 25", accountingDate: "2026-08-25", entity: "CA01", currency: "CAD", type: "Full reversal", typeKey: "ledger.manual", source: "Reverses CA-000284", amount: "CAD 730.25", status: "POSTED", owner: "Ledger kernel", correctionRoute: "/journals/journal-ca-290" },
  { id: "journal-ca-289", number: "CA-000289", date: "Aug 25", accountingDate: "2026-08-25", entity: "CA01", currency: "CAD", type: "Supplier bill", typeKey: "payables.supplier-bill", source: "BILL-CA-0312", amount: "CAD 18,400.00", status: "POSTED", owner: "Payables", correctionRoute: "/payables/bills/BILL-CA-0312" },
  { id: "journal-us-187", number: "US-000187", date: "Aug 24", accountingDate: "2026-08-24", entity: "US01", currency: "USD", type: "Sales invoice", typeKey: "receivables.sales-invoice", source: "INV-US-0734", amount: "USD 15,540.00", status: "POSTED", owner: "Receivables", correctionRoute: "/receivables/invoices/INV-US-0734" },
  { id: "journal-ca-288", number: "CA-000288", date: "Aug 23", accountingDate: "2026-08-23", entity: "CA01", currency: "CAD", type: "Manual journal", typeKey: "ledger.manual", source: "PREPAID-AUG", amount: "CAD 6,000.00", status: "POSTED", owner: "General ledger", correctionRoute: "/journals/journal-ca-288" },
  { id: "journal-us-186", number: "US-000186", date: "Aug 22", accountingDate: "2026-08-22", entity: "US01", currency: "USD", type: "Adjusting journal", typeKey: "ledger.manual", source: "ACCRUAL-AUG", amount: "USD 2,400.00", status: "POSTED", owner: "General ledger", correctionRoute: "/journals/journal-us-186" },
];

export const demoJournalDetails: readonly DemoJournalDetail[] = [
  {
    id: "journal-ca-291", number: "CA-000291", entityCode: "CA01", currency: "CAD", accountingDate: "2026-08-26", description: "Professional services invoice INV-1048", typeKey: "receivables.sales-invoice", typeLabel: "Sales invoice", ownerModule: "receivables", sourceDocument: "INV-1048", status: "POSTED", origin: "USER", purpose: "ROUTINE", editableInGeneralLedger: false, correctionRoute: "/receivables/invoices/INV-1048", relation: null,
    lines: [
      journalLine(1, "CA01", "CAD", "1100", "Accounts receivable", "11300.00", "0.00", "Customer balance"),
      journalLine(2, "CA01", "CAD", "4100", "Service revenue", "0.00", "10000.00", "Professional services"),
      journalLine(3, "CA01", "CAD", "2210", "HST payable", "0.00", "1300.00", "Ontario HST"),
    ],
  },
  {
    id: "journal-us-188", number: "US-000188", entityCode: "US01", currency: "USD", accountingDate: "2026-08-26", description: "Office supply bill BILL-0882", typeKey: "payables.supplier-bill", typeLabel: "Supplier bill", ownerModule: "payables", sourceDocument: "BILL-0882", status: "POSTED", origin: "USER", purpose: "ROUTINE", editableInGeneralLedger: false, correctionRoute: "/payables/bills/BILL-0882", relation: null,
    lines: [
      journalLine(1, "US01", "USD", "6100", "Operating expenses", "4850.00", "0.00", "Office supplies"),
      journalLine(2, "US01", "USD", "2100", "Accounts payable", "0.00", "4850.00", "Supplier balance"),
    ],
  },
  {
    id: "journal-draft-17", number: "Draft", entityCode: "CA01", currency: "CAD", accountingDate: "2026-08-26", description: "Draft software accrual prepared through MCP", typeKey: "ledger.manual", typeLabel: "Manual journal", ownerModule: "ledger", sourceDocument: null, status: "REVIEW", origin: "MCP", purpose: "ADJUSTING", editableInGeneralLedger: true, correctionRoute: "/journals/journal-draft-17", relation: null,
    lines: [
      journalLine(1, "CA01", "CAD", "6200", "Software expense", "1250.00", "0.00", "August software services"),
      journalLine(2, "CA01", "CAD", "2300", "Accrued liabilities", "0.00", "1250.00", "Unbilled accrual"),
    ],
  },
  {
    id: "journal-ca-290", number: "CA-000290", entityCode: "CA01", currency: "CAD", accountingDate: "2026-08-25", description: "Full reversal of duplicate invoice CA-000284", typeKey: "ledger.manual", typeLabel: "Full reversal", ownerModule: "ledger", sourceDocument: null, status: "POSTED", origin: "SYSTEM", purpose: "REVERSAL", editableInGeneralLedger: false, correctionRoute: "/journals/journal-ca-290", relation: { kind: "REVERSAL_OF", journalNumber: "CA-000284" },
    lines: [
      journalLine(1, "CA01", "CAD", "4100", "Service revenue", "646.24", "0.00", "Reverse revenue"),
      journalLine(2, "CA01", "CAD", "2210", "HST payable", "84.01", "0.00", "Reverse HST"),
      journalLine(3, "CA01", "CAD", "1100", "Accounts receivable", "0.00", "730.25", "Reverse customer balance"),
    ],
  },
  {
    id: "journal-ca-289", number: "CA-000289", entityCode: "CA01", currency: "CAD", accountingDate: "2026-08-25", description: "Consulting bill BILL-CA-0312", typeKey: "payables.supplier-bill", typeLabel: "Supplier bill", ownerModule: "payables", sourceDocument: "BILL-CA-0312", status: "POSTED", origin: "USER", purpose: "ROUTINE", editableInGeneralLedger: false, correctionRoute: "/payables/bills/BILL-CA-0312", relation: null,
    lines: [
      journalLine(1, "CA01", "CAD", "6100", "Operating expenses", "16283.19", "0.00", "Consulting services"),
      journalLine(2, "CA01", "CAD", "1410", "Recoverable HST", "2116.81", "0.00", "Input tax credit"),
      journalLine(3, "CA01", "CAD", "2100", "Accounts payable", "0.00", "18400.00", "Supplier balance"),
    ],
  },
  {
    id: "journal-us-187", number: "US-000187", entityCode: "US01", currency: "USD", accountingDate: "2026-08-24", description: "Seattle services invoice INV-US-0734", typeKey: "receivables.sales-invoice", typeLabel: "Sales invoice", ownerModule: "receivables", sourceDocument: "INV-US-0734", status: "POSTED", origin: "USER", purpose: "ROUTINE", editableInGeneralLedger: false, correctionRoute: "/receivables/invoices/INV-US-0734", relation: null,
    lines: [
      journalLine(1, "US01", "USD", "1100", "Accounts receivable", "15540.00", "0.00", "Customer balance"),
      journalLine(2, "US01", "USD", "4100", "Service revenue", "0.00", "14057.89", "Professional services"),
      journalLine(3, "US01", "USD", "2220", "Sales tax payable", "0.00", "1482.11", "Washington sales tax"),
    ],
  },
  {
    id: "journal-ca-288", number: "CA-000288", entityCode: "CA01", currency: "CAD", accountingDate: "2026-08-23", description: "Record annual insurance prepayment", typeKey: "ledger.manual", typeLabel: "Manual journal", ownerModule: "ledger", sourceDocument: null, status: "POSTED", origin: "USER", purpose: "ROUTINE", editableInGeneralLedger: true, correctionRoute: "/journals/journal-ca-288", relation: null,
    lines: [
      journalLine(1, "CA01", "CAD", "1400", "Prepaid expenses", "6000.00", "0.00", "Annual insurance"),
      journalLine(2, "CA01", "CAD", "1000", "Cash", "0.00", "6000.00", "Payment"),
    ],
  },
  {
    id: "journal-us-186", number: "US-000186", entityCode: "US01", currency: "USD", accountingDate: "2026-08-22", description: "August contractor accrual", typeKey: "ledger.manual", typeLabel: "Adjusting journal", ownerModule: "ledger", sourceDocument: null, status: "POSTED", origin: "USER", purpose: "ADJUSTING", editableInGeneralLedger: true, correctionRoute: "/journals/journal-us-186", relation: null,
    lines: [
      journalLine(1, "US01", "USD", "6100", "Operating expenses", "2400.00", "0.00", "Contractor expense"),
      journalLine(2, "US01", "USD", "2300", "Accrued liabilities", "0.00", "2400.00", "Accrual"),
    ],
  },
];

export const demoReceivableInvoices: readonly DemoReceivableInvoice[] = [
  { id: "invoice-ca-1048", number: "INV-1048", entityCode: "CA01", currency: "CAD", customerPartyId: "party-184", customerName: "Harbour Dental Group", issuedOn: "2026-08-26", dueOn: "2026-09-25", subtotal: "10000.00", tax: "1300.00", total: "11300.00", openAmount: "11300.00", status: "ISSUED", taxDecisionStatus: "APPLIED", journalId: "journal-ca-291" },
  { id: "invoice-ca-1046", number: "INV-1046", entityCode: "CA01", currency: "CAD", customerPartyId: "party-184", customerName: "Harbour Dental Group", issuedOn: "2026-08-10", dueOn: "2026-08-24", subtotal: "64522.43", tax: "8387.92", total: "72910.35", openAmount: "72910.35", status: "ISSUED", taxDecisionStatus: "APPLIED", journalId: null },
  { id: "invoice-ca-1052", number: "INV-1052", entityCode: "CA01", currency: "CAD", customerPartyId: "party-231", customerName: "Maple Community Studio", issuedOn: "2026-08-26", dueOn: "2026-09-25", subtotal: "2400.00", tax: "0.00", total: "2400.00", openAmount: "0.00", status: "DRAFT_REVIEW", taxDecisionStatus: "MANUAL_REVIEW_REQUIRED", journalId: null },
  { id: "invoice-us-0734", number: "INV-US-0734", entityCode: "US01", currency: "USD", customerPartyId: "party-203", customerName: "Cascade Office Supply", issuedOn: "2026-08-24", dueOn: "2026-09-23", subtotal: "14057.89", tax: "1482.11", total: "15540.00", openAmount: "15540.00", status: "ISSUED", taxDecisionStatus: "APPLIED", journalId: "journal-us-187" },
  { id: "invoice-us-0731", number: "INV-US-0731", entityCode: "US01", currency: "USD", customerPartyId: "party-203", customerName: "Cascade Office Supply", issuedOn: "2026-08-05", dueOn: "2026-08-20", subtotal: "45273.48", tax: "4776.72", total: "50050.20", openAmount: "50050.20", status: "ISSUED", taxDecisionStatus: "APPLIED", journalId: null },
  { id: "invoice-us-0737", number: "INV-US-0737", entityCode: "US01", currency: "USD", customerPartyId: "party-244", customerName: "Lakeview Design Cooperative", issuedOn: "2026-08-26", dueOn: "2026-09-25", subtotal: "3200.00", tax: "0.00", total: "3200.00", openAmount: "0.00", status: "DRAFT_REVIEW", taxDecisionStatus: "MANUAL_REVIEW_REQUIRED", journalId: null },
];

export const demoPayableBills: readonly DemoPayableBill[] = [
  { id: "bill-ca-0312", number: "BILL-CA-0312", entityCode: "CA01", currency: "CAD", supplierPartyId: "party-256", supplierName: "Pine & Lake Advisory", billDate: "2026-08-25", dueOn: "2026-09-24", subtotal: "16283.19", tax: "2116.81", total: "18400.00", openAmount: "18400.00", status: "APPROVED", journalId: "journal-ca-289" },
  { id: "bill-ca-0314", number: "BILL-CA-0314", entityCode: "CA01", currency: "CAD", supplierPartyId: "party-256", supplierName: "Pine & Lake Advisory", billDate: "2026-08-18", dueOn: "2026-08-30", subtotal: "20770.02", tax: "2700.10", total: "23470.12", openAmount: "23470.12", status: "APPROVED", journalId: null },
  { id: "bill-us-0882", number: "BILL-0882", entityCode: "US01", currency: "USD", supplierPartyId: "party-203", supplierName: "Cascade Office Supply", billDate: "2026-08-26", dueOn: "2026-09-25", subtotal: "4850.00", tax: "0.00", total: "4850.00", openAmount: "4850.00", status: "APPROVED", journalId: "journal-us-188" },
  { id: "bill-us-0887", number: "BILL-0887", entityCode: "US01", currency: "USD", supplierPartyId: "party-267", supplierName: "Rainier Facilities LLC", billDate: "2026-08-16", dueOn: "2026-08-29", subtotal: "32580.48", tax: "0.00", total: "32580.48", openAmount: "32580.48", status: "APPROVED", journalId: null },
];

export const demoPartyDetails: readonly DemoPartyDetail[] = [
  {
    id: "party-184", party: "P:000184", name: "Harbour Dental Group", entity: "CA01", roles: ["C:CA-0021"], balance: "CAD 84,210.35 AR", status: "ACTIVE", email: "accounts@harbour-dental.demo.invalid", phone: "+1 416 555 0184", primaryAddress: { line1: "184 Harbour Avenue", city: "Toronto", region: "ON", postalCode: "M5V 2T6", country: "Canada" },
    accounts: [{ entityCode: "CA01", role: "CUSTOMER", accountNumber: "CA-0021", currency: "CAD", openAmount: "84210.35" }],
  },
  {
    id: "party-203", party: "P:000203", name: "Cascade Office Supply", entity: "US01", roles: ["C:US-0018", "S:US-0044"], balance: "USD 65,590.20 AR - 4,850.00 AP", status: "ACTIVE", email: "finance@cascade-office.demo.invalid", phone: "+1 206 555 0203", primaryAddress: { line1: "203 Cascade Way", city: "Seattle", region: "WA", postalCode: "98101", country: "United States" },
    accounts: [
      { entityCode: "US01", role: "CUSTOMER", accountNumber: "US-0018", currency: "USD", openAmount: "65590.20" },
      { entityCode: "US01", role: "SUPPLIER", accountNumber: "US-0044", currency: "USD", openAmount: "4850.00" },
    ],
  },
  {
    id: "party-231", party: "P:000231", name: "Maple Community Studio", entity: "CA01", roles: ["C:CA-0033"], balance: "CAD 0.00 draft AR", status: "ACTIVE", email: "accounts@maple-studio.demo.invalid", phone: "+1 416 555 0231", primaryAddress: { line1: "231 Maple Crescent", city: "Toronto", region: "ON", postalCode: "M4W 1A8", country: "Canada" },
    accounts: [{ entityCode: "CA01", role: "CUSTOMER", accountNumber: "CA-0033", currency: "CAD", openAmount: "0.00" }],
  },
  {
    id: "party-244", party: "P:000244", name: "Lakeview Design Cooperative", entity: "US01", roles: ["C:US-0039"], balance: "USD 0.00 draft AR", status: "ACTIVE", email: "finance@lakeview-design.demo.invalid", phone: "+1 425 555 0244", primaryAddress: { line1: "244 Lakeview Drive", city: "Bellevue", region: "WA", postalCode: "98004", country: "United States" },
    accounts: [{ entityCode: "US01", role: "CUSTOMER", accountNumber: "US-0039", currency: "USD", openAmount: "0.00" }],
  },
  {
    id: "party-219", party: "P:000219", name: "Northstar Services USA LLC", entity: "CA01 to US01", roles: ["S:CA-0072", "IC:US01"], balance: "CAD 0.00 intercompany", status: "ACTIVE", email: "intercompany@northstar.demo.invalid", phone: "+1 206 555 0219", primaryAddress: { line1: "219 Northstar Plaza", city: "Seattle", region: "WA", postalCode: "98104", country: "United States" },
    accounts: [
      { entityCode: "CA01", role: "SUPPLIER", accountNumber: "CA-0072", currency: "CAD", openAmount: "0.00" },
      { entityCode: "CA01", role: "INTERCOMPANY", accountNumber: "US01", currency: "CAD", openAmount: "0.00" },
    ],
  },
  {
    id: "party-256", party: "P:000256", name: "Pine & Lake Advisory", entity: "CA01", roles: ["S:CA-0081"], balance: "CAD 41,870.12 AP", status: "ACTIVE", email: "billing@pine-lake.demo.invalid", phone: "+1 647 555 0256", primaryAddress: { line1: "256 Pine Street", city: "Toronto", region: "ON", postalCode: "M4B 1B3", country: "Canada" },
    accounts: [{ entityCode: "CA01", role: "SUPPLIER", accountNumber: "CA-0081", currency: "CAD", openAmount: "41870.12" }],
  },
  {
    id: "party-267", party: "P:000267", name: "Rainier Facilities LLC", entity: "US01", roles: ["S:US-0051"], balance: "USD 32,580.48 AP", status: "ACTIVE", email: "billing@rainier-facilities.demo.invalid", phone: "+1 425 555 0267", primaryAddress: { line1: "267 Rainier Lane", city: "Bellevue", region: "WA", postalCode: "98004", country: "United States" },
    accounts: [{ entityCode: "US01", role: "SUPPLIER", accountNumber: "US-0051", currency: "USD", openAmount: "32580.48" }],
  },
];

export const demoTaxExceptions: readonly DemoTaxException[] = [
  taxException("tax-exception-ca-001", "CA01", "INV-1052", "Ontario HST", ontarioReview),
  taxException("tax-exception-us-001", "US01", "INV-US-0737", "Washington sales tax", washingtonReview),
];

export const demoClosePackages: readonly DemoClosePackage[] = [
  {
    id: "close-ca01-2026-08", entityCode: "CA01", currency: "CAD", periodLabel: "August 2026", periodState: "OPEN", generatedAt: DEMO_GENERATED_AT, readinessPercent: 68, demoOnly: true,
    checks: [
      { key: "journal-balance", label: "All posted journals balanced", status: "PASS", detail: "The fictional journal details balance exactly in CAD." },
      { key: "ar-ap", label: "AR/AP controls reconciled", status: "PASS", detail: "Highlighted open invoices and bills match the CA01 dashboard balances." },
      { key: "tax", label: "Tax exceptions cleared", status: "BLOCKED", detail: "INV-1052 requires a GST/HST registration decision." },
      { key: "drafts", label: "Draft journals resolved", status: "BLOCKED", detail: "MCP-DRAFT-17 remains a non-persistent review draft." },
      { key: "bank", label: "Bank reconciliation", status: "UNAVAILABLE", detail: "The banking module is deferred and cannot be represented as complete." },
    ],
    blockers: [
      { key: "tax-exception-ca-001", label: "Ontario HST review", detail: "Select a valid demo registration before the invoice can be issued.", route: "/tax?status=review&q=INV-1052" },
      { key: "journal-draft-17", label: "Manual journal review", detail: "Review the simulated draft; no accounting record has been saved.", route: "/journals?q=MCP-DRAFT-17" },
      { key: "banking-deferred", label: "Bank reconciliation unavailable", detail: "A deferred module cannot satisfy a production close control.", route: "/controls/period-close" },
    ],
  },
  {
    id: "close-us01-2026-08", entityCode: "US01", currency: "USD", periodLabel: "August 2026", periodState: "ADJUSTMENT_ONLY", generatedAt: DEMO_GENERATED_AT, readinessPercent: 72, demoOnly: true,
    checks: [
      { key: "journal-balance", label: "All posted journals balanced", status: "PASS", detail: "The fictional journal details balance exactly in USD." },
      { key: "ar-ap", label: "AR/AP controls reconciled", status: "PASS", detail: "Highlighted open invoices and bills match the US01 dashboard balances." },
      { key: "tax", label: "Tax exceptions cleared", status: "BLOCKED", detail: "INV-US-0737 requires a verified Washington DOR location code." },
      { key: "bank", label: "Bank reconciliation", status: "UNAVAILABLE", detail: "The banking module is deferred and cannot be represented as complete." },
    ],
    blockers: [
      { key: "tax-exception-us-001", label: "Washington location review", detail: "Verify the DOR location code before calculating sales tax.", route: "/tax?status=review&q=INV-US-0737" },
      { key: "banking-deferred", label: "Bank reconciliation unavailable", detail: "A deferred module cannot satisfy a production close control.", route: "/controls/period-close" },
    ],
  },
];

function journalWorkspaceHref(journal: DemoJournalSummary): string {
  const query = encodeURIComponent(journal.source || journal.number);
  if (journal.typeKey === "receivables.sales-invoice") {
    return `/receivables/invoices?q=${query}`;
  }
  if (journal.typeKey === "payables.supplier-bill") {
    return `/payables/bills?q=${query}`;
  }
  return `/journals?q=${query}`;
}

export const demoSearchIndex: readonly DemoSearchEntry[] = [
  ...demoEntityDetails.map((entity) => ({ id: entity.id, kind: "entity" as const, title: entity.name, subtitle: `${entity.code} - ${entity.location} - ${entity.currency}`, keywords: [entity.code, entity.legalName, entity.profile, entity.accountingProfile, entity.ledgerName], href: `/entities?q=${encodeURIComponent(entity.code)}`, entityCode: entity.code })),
  ...demoJournals.map((journal) => ({ id: journal.id, kind: "journal" as const, title: journal.number, subtitle: `${journal.type} - ${journal.source} - ${journal.amount}`, keywords: [journal.typeKey, journal.owner, journal.status, journal.source, journal.entity], href: journalWorkspaceHref(journal), entityCode: journal.entity })),
  ...demoReceivableInvoices.map((invoice) => ({ id: invoice.id, kind: "invoice" as const, title: invoice.number, subtitle: `${invoice.customerName} - ${invoice.currency} ${invoice.total} - ${invoice.status}`, keywords: [invoice.customerName, invoice.customerPartyId, invoice.taxDecisionStatus, invoice.entityCode], href: `/receivables/invoices?q=${encodeURIComponent(invoice.number)}`, entityCode: invoice.entityCode })),
  ...demoPayableBills.map((bill) => ({ id: bill.id, kind: "bill" as const, title: bill.number, subtitle: `${bill.supplierName} - ${bill.currency} ${bill.total} - ${bill.status}`, keywords: [bill.supplierName, bill.supplierPartyId, bill.entityCode], href: `/payables/bills?q=${encodeURIComponent(bill.number)}`, entityCode: bill.entityCode })),
  ...demoPartyDetails.map((party) => ({ id: party.id, kind: "party" as const, title: party.name, subtitle: `${party.party} - ${party.roles.join(", ")}`, keywords: [party.party, party.entity, party.email, party.phone, ...party.roles], href: `/parties?q=${encodeURIComponent(party.party)}`, entityCode: party.accounts[0]?.entityCode ?? null })),
  ...demoTaxExceptions.map((exception) => ({ id: exception.id, kind: "tax-exception" as const, title: exception.sourceDocument, subtitle: `${exception.jurisdiction} - manual review required`, keywords: [exception.packKey, exception.reviewReason, exception.status, exception.entityCode], href: `/tax?status=review&q=${encodeURIComponent(exception.sourceDocument)}`, entityCode: exception.entityCode })),
  { id: "report-trial-balance", kind: "report", title: "Trial balance", subtitle: "Separate CAD and USD demo balances", keywords: ["report", "export", "csv", "accounts"], href: "/reports/trial-balance", entityCode: null },
  { id: "control-august-close", kind: "control", title: "August close package", subtitle: "Demo blockers and period controls", keywords: ["hard close", "period", "tax exceptions", "bank reconciliation"], href: "/controls/period-close", entityCode: null },
];

export const demoDashboard = {
  organization: {
    id: "demo-organization-northstar",
    slug: "northstar-demo",
    name: "Northstar Demo Group",
    environment: "Demo business",
    currentDate: "August 26, 2026",
  },
  currentActor: demoCurrentActor,
  writeState: demoWriteState,
  entities: demoEntityDetails,
  entityDetails: demoEntityDetails,
  metrics: [
    { label: "Receivables", values: ["CAD 84,210", "USD 65,590"], note: "4 open invoices - 2 overdue", tone: "blue" },
    { label: "Payables", values: ["CAD 41,870", "USD 37,430"], note: "4 open bills - 2 due this week", tone: "amber" },
    { label: "Drafts to review", values: ["3 documents"], note: "1 journal - 2 tax exceptions", tone: "purple" },
    { label: "Control status", values: ["Balanced by entity"], note: "CAD and USD are never consolidated", tone: "green" },
  ],
  journals: demoJournals,
  journalDetails: demoJournalDetails,
  trialBalanceRows: demoTrialBalanceRows,
  receivableInvoices: demoReceivableInvoices,
  payableBills: demoPayableBills,
  accountExample: {
    canonicalKey: renderAccountKey({ entity: "CA01", account: "6100", subaccount: "SERV", department: "OPS", intercompany: null, custom1: "CONS", custom2: "DIRECT", custom3: null, custom4: null, custom5: null, custom6: null, custom7: null, custom8: null }),
    segments: [
      ["Entity", "CA01"], ["Account", "6100"], ["Subaccount", "SERV"], ["Department", "OPS"], ["Intercompany", "0000"], ["Service line", "CONS"], ["Channel", "DIRECT"], ["Custom 3-8", "Hidden - 0000"],
    ],
  },
  parties: demoPartyDetails,
  partyDetails: demoPartyDetails,
  taxDecisions: [
    { jurisdiction: "Ontario HST", pack: `${ontarioTax.packKey} - ${ontarioTax.packVersion}`, rate: "13.00%", result: `CAD ${ontarioTax.totalTax}`, status: ontarioTax.status, note: "One legal HST component - CRA place of supply" },
    { jurisdiction: "Seattle sales tax", pack: `${seattleTax.packKey} - ${seattleTax.packVersion}`, rate: "10.55%", result: `USD ${seattleTax.totalTax}`, status: seattleTax.status, note: "6.50 state + 4.05 local - DOR location 1726" },
    { jurisdiction: "Ontario HST review", pack: `${ontarioReview.packKey} - ${ontarioReview.packVersion}`, rate: "Review", result: "Not calculated", status: ontarioReview.status, note: ontarioReview.reviewReason ?? "Manual review required" },
    { jurisdiction: "Washington location review", pack: `${washingtonReview.packKey} - ${washingtonReview.packVersion}`, rate: "Review", result: "Not calculated", status: washingtonReview.status, note: washingtonReview.reviewReason ?? "Manual review required" },
  ],
  taxExceptions: demoTaxExceptions,
  closePackages: demoClosePackages,
  closeChecklist: [
    { label: "All journals balanced", done: true, detail: "8 fictional journal details checked" },
    { label: "AR/AP controls reconciled", done: true, detail: "Balances match by entity and currency" },
    { label: "Tax exceptions cleared", done: false, detail: "2 require manual review" },
    { label: "Bank reconciliation", done: false, detail: "Module deferred - unavailable" },
  ],
  searchIndex: demoSearchIndex,
} as const;
