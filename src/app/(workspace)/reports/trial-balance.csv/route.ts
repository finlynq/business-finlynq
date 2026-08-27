import { NextRequest, NextResponse } from "next/server";
import { requestPrincipal } from "@/modules/identity/session";
import { generateDemoTrialBalanceCsv } from "@/modules/demo/workspace";

export async function GET(request: NextRequest) {
  const principal = await requestPrincipal(request);
  if (!principal) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    login.searchParams.set("next", "/app/reports/trial-balance.csv");
    login.searchParams.set("reason", "expired");
    return NextResponse.redirect(login, 303);
  }
  if (principal.sessionMode !== "demo") {
    return NextResponse.json(
      { error: "Tenant-scoped trial balance export is not enabled yet." },
      { status: 501, headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } },
    );
  }
  const csv = `${generateDemoTrialBalanceCsv()}\r\n`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="business-finlynq-demo-trial-balance-2026-08.csv"',
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
