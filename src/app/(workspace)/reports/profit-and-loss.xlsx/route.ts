import * as XLSX from "xlsx";
import { exact, minorUnits } from "@/kernel/money";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import {
  loadEffectiveAccountHierarchy,
  loadReportDimensions,
  reportFilterInput,
  resolveReportSelection,
} from "@/modules/reporting/tenant-reporting";
import {
  loadMonthlyProfitAndLoss,
  MonthlyReportScopeError,
  monthlyReportAsOfDate,
  monthlyReportSelectionInput,
} from "@/modules/reporting/monthly-profit-and-loss";
import {
  monthlyProfitAndLossExportRows,
  monthlyReportFilterLabel,
  monthlyReportPresentationHash,
} from "@/modules/reporting/monthly-profit-and-loss-export";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
};

function safeCell(value: string): string {
  return /^[\s]*[=+@\-]/.test(value) ? `'${value}` : value;
}

export async function GET(request: Request) {
  const principal = await requireWorkspacePrincipal("/app/reports/profit-and-loss.xlsx");
  const [dimensions, context] = await Promise.all([
    loadReportDimensions(principal),
    currentWorkspaceEntityContext(principal),
  ]);
  const params = new URL(request.url).searchParams;
  const expectedHash = params.get("snapshot");
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    return new Response("Run the monthly report before exporting it.", { status: 400, headers });
  }
  const input = reportFilterInput(Object.fromEntries(params.entries()));
  const selection = resolveReportSelection(dimensions, monthlyReportSelectionInput(dimensions, {
    ...input,
    entity: input.entity ?? context.selectedEntity?.id,
  }));
  const entity = dimensions.entities.find((candidate) => candidate.id === selection?.entityId);
  if (!selection || !entity) {
    return new Response("No reporting entity is available.", { status: 404, headers });
  }
  let report: Awaited<ReturnType<typeof loadMonthlyProfitAndLoss>>;
  let hierarchy: Awaited<ReturnType<typeof loadEffectiveAccountHierarchy>>;
  try {
    [report, hierarchy] = await Promise.all([
      loadMonthlyProfitAndLoss(principal, selection, entity, monthlyReportAsOfDate(principal)),
      loadEffectiveAccountHierarchy(principal, selection),
    ]);
  } catch (error) {
    if (error instanceof MonthlyReportScopeError) return new Response(error.message, { status: 422, headers });
    throw error;
  }
  if (monthlyReportPresentationHash(report, hierarchy) !== expectedHash) {
    return new Response("The report changed. Rerun it before exporting.", { status: 409, headers });
  }
  const grid = monthlyProfitAndLossExportRows(report, hierarchy);
  const workbookAmount = (value: string | null) => value === null ? "" : exact(value).toFixed(minorUnits(selection.currency));
  const header = ["Line item", ...report.columns.map((column) => `${column.label} (${column.coverage.toLowerCase()}${column.periodState ? `, ${column.periodState.toLowerCase()}` : ""})`), "Selected total"];
  const values = [
    ["Profit and loss by month", report.selection.entityCode, report.selection.ledgerCode, report.selection.currency],
    ["Fiscal year", String(report.fiscalYear), "Basis", report.selection.basis],
    ["Selected range", report.selection.fromDate, report.selection.toDate, "As of", report.asOfDate],
    ["Filters", safeCell(monthlyReportFilterLabel(report))],
    ["Snapshot SHA-256", report.snapshotHash],
    [],
    header,
    ...grid.map((row) => [safeCell(row.label), ...row.values.map(workbookAmount), workbookAmount(row.total)]),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(values);
  sheet["!cols"] = [{ wch: 46 }, ...report.columns.map(() => ({ wch: 18 })), { wch: 20 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Monthly P&L");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const entityPart = selection.entityCode.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...headers,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="business-finlynq-${entityPart}-monthly-profit-and-loss.xlsx"`,
    },
  });
}
