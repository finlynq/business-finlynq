import {
  loadReportDimensions,
  loadTrialBalance,
  reportFilterInput,
  resolveReportSelection,
  trialBalanceCsv,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";

export async function GET(request: Request) {
  const principal = await requireWorkspacePrincipal("/app/reports/trial-balance.csv");
  const [dimensions, entityContext] = await Promise.all([
    loadReportDimensions(principal),
    currentWorkspaceEntityContext(principal),
  ]);
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  const filterInput = reportFilterInput(query);
  const selection = resolveReportSelection(dimensions, {
    ...filterInput,
    entity: filterInput.entity ?? entityContext.selectedEntity?.id,
  });
  const csv = `${trialBalanceCsv(selection ? await loadTrialBalance(principal, selection) : [])}\r\n`;
  const entityPart = (selection?.entityCode ?? "organization").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="business-finlynq-${entityPart}-trial-balance.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}
