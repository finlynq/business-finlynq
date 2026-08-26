import { generateDemoTrialBalanceCsv } from "@/modules/demo/workspace";

export function GET() {
  const csv = `${generateDemoTrialBalanceCsv()}\r\n`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="business-finlynq-demo-trial-balance-2026-08.csv"',
      "Cache-Control": "no-store",
    },
  });
}
