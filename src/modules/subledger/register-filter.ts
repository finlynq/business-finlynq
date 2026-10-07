import { exact } from "@/kernel/money";
import type { SubledgerWorkspaceDocumentDto } from "./workspace";

export type SubledgerDueFilter =
  | "ALL"
  | "OVERDUE"
  | "DUE_TODAY"
  | "DUE_LATER"
  | "SETTLED"
  | "NOT_APPLICABLE";

export type SubledgerRegisterFilter = Readonly<{
  search: string;
  entityCode: string;
  status: string;
  currency: string;
  dateFrom: string;
  dateTo: string;
  due: SubledgerDueFilter;
  paymentStatus?: "ALL" | "OPEN" | "PAID";
}>;

export function subledgerDocumentDate(document: SubledgerWorkspaceDocumentDto): string {
  return "documentDate" in document.snapshot
    ? document.snapshot.documentDate
    : document.snapshot.settlementDate;
}

export function subledgerDocumentDueDate(document: SubledgerWorkspaceDocumentDto): string | null {
  return "dueOn" in document.snapshot ? document.snapshot.dueOn : null;
}

export function subledgerPaymentStatus(document: SubledgerWorkspaceDocumentDto): "Open" | "Partially paid" | "Paid" | null {
  if (document.status !== "POSTED" || document.openAmount === null || document.openStatus === "REVERSED"
    || (document.snapshot.kind !== "SUPPLIER_BILL" && document.snapshot.kind !== "SALES_INVOICE")) return null;
  const remaining = exact(document.openAmount);
  if (remaining.isZero()) return "Paid";
  if (remaining.isNegative()) return null;
  return remaining.lessThan(document.snapshot.grossTotal) ? "Partially paid" : "Open";
}

function matchesDueState(
  document: SubledgerWorkspaceDocumentDto,
  due: SubledgerDueFilter,
  currentDate: string,
): boolean {
  if (due === "ALL") return true;
  const dueOn = subledgerDocumentDueDate(document);
  const isBusinessDocument = dueOn !== null;
  const hasIssuedBalance = document.openAmount !== null;
  const hasOpenBalance = hasIssuedBalance && Number(document.openAmount) > 0;
  if (due === "NOT_APPLICABLE") return !isBusinessDocument || !hasIssuedBalance;
  if (due === "SETTLED") return isBusinessDocument && hasIssuedBalance && !hasOpenBalance;
  if (!isBusinessDocument || !hasOpenBalance) return false;
  if (due === "OVERDUE") return dueOn < currentDate;
  if (due === "DUE_TODAY") return dueOn === currentDate;
  return dueOn > currentDate;
}

export function filterSubledgerDocuments(
  documents: readonly SubledgerWorkspaceDocumentDto[],
  filter: SubledgerRegisterFilter,
  currentDate: string,
): readonly SubledgerWorkspaceDocumentDto[] {
  const search = filter.search.trim().toLocaleLowerCase();
  return documents.filter((document) => {
    const date = subledgerDocumentDate(document);
    if (filter.entityCode && document.entityCode !== filter.entityCode) return false;
    if (filter.status && document.status !== filter.status) return false;
    if (filter.currency && document.snapshot.currency !== filter.currency) return false;
    if (filter.dateFrom && date < filter.dateFrom) return false;
    if (filter.dateTo && date > filter.dateTo) return false;
    const paymentStatus = subledgerPaymentStatus(document);
    if (filter.paymentStatus === "OPEN" && paymentStatus !== "Open" && paymentStatus !== "Partially paid") return false;
    if (filter.paymentStatus === "PAID" && paymentStatus !== "Paid") return false;
    if (!matchesDueState(document, filter.due, currentDate)) return false;
    if (!search) return true;
    return [
      document.sourceNumber,
      document.partyName,
      document.entityCode,
      document.snapshot.currency,
      document.snapshot.description,
      document.journalNumber?.toString() ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(search));
  });
}
