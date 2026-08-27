import {
  loadTrialBalance,
  trialBalanceCsv,
} from "@/modules/reporting/tenant-reporting";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";

export async function GET(request: Request) {
  void request;
  const principal = await requireWorkspacePrincipal("/app/reports/trial-balance.csv");
  const csv = `${trialBalanceCsv(await loadTrialBalance(principal))}\r\n`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="business-finlynq-trial-balance.csv"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}
