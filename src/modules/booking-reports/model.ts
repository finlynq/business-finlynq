import { z } from "zod";
import { exact } from "@/kernel/money";
import type { DocumentEvidenceMetadata } from "@/modules/subledger/evidence-model";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const bookingRecordSchema = z.object({
  type: z.enum(["SOURCE_DOCUMENT", "JOURNAL"]), id: z.uuid(), expectedVersion: z.number().int().min(0), expectedContentHash: hash,
  group: z.string().trim().min(1).max(80).optional(), note: z.string().trim().max(500).optional(),
}).strict();
export const createBookingBatchSchema = z.object({
  legalEntityId: z.uuid(), ledgerId: z.uuid(), title: z.string().trim().min(1).max(160),
  records: z.array(bookingRecordSchema).min(1).max(100).refine((records) => new Set(records.map((record) => `${record.type}:${record.id}`)).size === records.length, "Select each record only once"),
  heldItems: z.array(z.object({ description: z.string().trim().min(1).max(300), reason: z.string().trim().min(5).max(500) }).strict()).max(100).default([]),
  clearingGroups: z.array(z.object({ name: z.string().trim().min(1).max(80), accountCombinationIds: z.array(z.uuid()).min(1).max(20) }).strict()).max(20).default([]),
  reason: z.string().trim().min(5).max(500), idempotencyKey: z.uuid(),
}).strict();
export const readBookingReportSchema = z.object({ batchId: z.uuid(), reportId: z.uuid().optional() }).strict();
export const refreshBookingReportSchema = readBookingReportSchema.omit({ reportId: true }).extend({ reason: z.string().trim().min(5).max(500), idempotencyKey: z.uuid() }).strict();
export const postBookingBatchSchema = z.object({ batchId: z.uuid(), reviewReportId: z.uuid(), expectedReviewHash: hash,
  confirmed: z.literal(true), reason: z.string().trim().min(5).max(500), idempotencyKey: z.uuid() }).strict();
export type BookingRecord = z.infer<typeof bookingRecordSchema>;
export type BookingDefinition = z.infer<typeof createBookingBatchSchema>;
export type BookingLine = { accountCombinationId: string; accountCode: string; accountName: string; accountClass: string;
  debitFunctional: string; creditFunctional: string; currency: string; debit: string; credit: string;
  fxRate: string; fxSource: string; fxDate: string; memo: string };
export type BookingEntry = {
  selected: BookingRecord; id: string; sourceType: string | null; sourceNumber: string; version: number; contentHash: string;
  kind: string; status: string; accountingDate: string; documentDate: string; period: string; description: string; party: string | null;
  currency: string; functionalCurrency: string; net: string | null; tax: string | null; gross: string | null; grossFunctional: string | null;
  outstanding: string | null; journalId: string | null; journalNumber: number | null; linesArePosted: boolean; lines: BookingLine[];
  taxDetails: { description: string; net: string; tax: string; treatment: string; rounding: string; evidence: string | null; reason: string | null }[];
  treatments: string[]; attachments: readonly DocumentEvidenceMetadata[]; approvalContext: unknown;
  differences: string[]; heldReason: string | null;
};
export type BookingSnapshot = {
  schemaVersion: 1; title: string; company: string; companyCode: string; legalEntityId: string; ledgerId: string;
  generatedAt: string; generatedBy: string; requestId: string; reason: string; phase: "REVIEW" | "OUTCOME";
  reviewReportId: string | null; entries: BookingEntry[]; heldItems: BookingDefinition["heldItems"];
  summary: ReturnType<typeof summarizeBookingEntries>;
};

export function summarizeBookingEntries(entries: readonly BookingEntry[], heldItems: BookingDefinition["heldItems"], groups: BookingDefinition["clearingGroups"]) {
  const invoices: Record<string, { net: string; tax: string; gross: string; outstanding: string }> = {};
  let recognized = exact(0), debit = exact(0), credit = exact(0), postedDebit = exact(0), postedCredit = exact(0);
  const exceptions: string[] = heldItems.map((item) => `${item.description}: ${item.reason}`);
  let posted = 0;
  for (const entry of entries) {
    if (entry.status === "POSTED" && entry.linesArePosted) posted++;
    if (entry.heldReason) exceptions.push(`${entry.sourceNumber}: ${entry.heldReason}`);
    let entryDebit = exact(0), entryCredit = exact(0);
    for (const line of entry.lines) { entryDebit = entryDebit.plus(line.debitFunctional); entryCredit = entryCredit.plus(line.creditFunctional); }
    if (!entryDebit.eq(entryCredit)) exceptions.push(`${entry.sourceNumber}: debit and credit amounts do not balance`);
    debit = debit.plus(entryDebit); credit = credit.plus(entryCredit);
    if (entry.linesArePosted) { postedDebit = postedDebit.plus(entryDebit); postedCredit = postedCredit.plus(entryCredit); }
    if (entry.kind === "SUPPLIER_BILL" || entry.kind === "SALES_INVOICE") {
      const total = invoices[entry.currency] ?? { net: "0", tax: "0", gross: "0", outstanding: "0" };
      invoices[entry.currency] = { net: exact(total.net).plus(entry.net ?? "0").toFixed(), tax: exact(total.tax).plus(entry.tax ?? "0").toFixed(),
        gross: exact(total.gross).plus(entry.gross ?? "0").toFixed(), outstanding: exact(total.outstanding).plus(entry.outstanding ?? "0").toFixed() };
      if (entry.linesArePosted) recognized = recognized.plus(entry.grossFunctional ?? "0");
    }
  }
  const clearing = groups.flatMap((group) => group.accountCombinationIds.map((accountCombinationId) => {
    const lines = entries.filter((entry) => entry.selected.group === group.name).flatMap((entry) => entry.lines).filter((line) => line.accountCombinationId === accountCombinationId);
    const net = lines.reduce((total, line) => total.plus(line.debitFunctional).minus(line.creditFunctional), exact(0));
    const balanced = lines.length > 0 && net.isZero();
    if (!balanced) exceptions.push(`${group.name}: clearing account ${lines[0]?.accountCode ?? "not represented"} ${lines.length ? "has an unmatched balance" : "has no selected entries"}`);
    return { group: group.name, accountCombinationId, account: lines[0] ? `${lines[0].accountCode} · ${lines[0].accountName}` : "Unrepresented account", net: net.toFixed(), balanced };
  }));
  const stale = entries.some((entry) => entry.differences.length > 0);
  const completeness = stale ? "STALE" as const : exceptions.length ? "HELD" as const : "COMPLETE" as const;
  const status = posted === entries.length && completeness === "COMPLETE" ? "POSTED" as const : posted > 0 ? "PARTIALLY_POSTED" as const : "DRAFT" as const;
  return { status, completeness, counts: { bills: entries.filter((entry) => ["SUPPLIER_BILL","SALES_INVOICE"].includes(entry.kind)).length,
    settlements: entries.filter((entry) => ["SUPPLIER_PAYMENT","CUSTOMER_RECEIPT"].includes(entry.kind)).length,
    manualJournals: entries.filter((entry) => entry.kind === "JOURNAL").length, posted, held: entries.length - posted + heldItems.length },
    invoiceCurrencies: invoices, recognizedFunctional: recognized.toFixed(), debitFunctional: debit.toFixed(), creditFunctional: credit.toFixed(),
    postedDebitFunctional: postedDebit.toFixed(), postedCreditFunctional: postedCredit.toFixed(), clearing, exceptions };
}

export function bookingReportCsv(snapshot: BookingSnapshot): string {
  const cell = (value: string | number | null) => {
    let text = String(value ?? "");
    if (/^(?:\s*[=+@-]|[\t\r\n])/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const rows: (string | number | null)[][] = [["Company",snapshot.company],["Batch",snapshot.title],["Phase",snapshot.phase],["Status",snapshot.summary.status],["Completeness",snapshot.summary.completeness],["Generated",snapshot.generatedAt],["Functional invoice recognition",snapshot.summary.recognizedFunctional],[],["Source","Status","Journal","Date","Account","Account name","Currency","Debit","Credit","Functional currency","Functional debit","Functional credit","FX rate","FX source","FX date","Memo"]];
  for (const entry of snapshot.entries) for (const line of entry.lines) rows.push([entry.sourceNumber, entry.linesArePosted ? "Posted" : "Draft review",entry.journalNumber,entry.accountingDate,line.accountCode,line.accountName,line.currency,line.debit,line.credit,entry.functionalCurrency,line.debitFunctional,line.creditFunctional,line.fxRate,line.fxSource,line.fxDate,line.memo]);
  rows.push([], ["Invoice currency", "Net", "Tax", "Invoice total", "Still owed on posted invoices"]);
  for (const [currency, total] of Object.entries(snapshot.summary.invoiceCurrencies)) rows.push([currency,total.net,total.tax,total.gross,total.outstanding]);
  rows.push([], ["Source", "Tax description", "Net", "Tax", "Treatment", "Source rounding", "Reason", "Evidence"]);
  for (const entry of snapshot.entries) for (const tax of entry.taxDetails) rows.push([entry.sourceNumber,tax.description,tax.net,tax.tax,tax.treatment,tax.rounding,tax.reason,tax.evidence]);
  rows.push([], ["Clearing group", "Account", "Net functional balance", "Reconciled"]);
  for (const group of snapshot.summary.clearing) rows.push([group.group,group.account,group.net,group.balanced?"Yes":"No"]);
  rows.push([], ["Held items and exceptions"]);
  for (const message of snapshot.summary.exceptions) rows.push([message]);
  for (const entry of snapshot.entries) for (const difference of entry.differences) rows.push([entry.sourceNumber,difference]);
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
