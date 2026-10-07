import { NextRequest,NextResponse } from "next/server";
import { requestPrincipal } from "@/modules/identity/session";
import { requestIdFor } from "@/observability/request-correlation";
import { mutationContext } from "@/modules/workspace/write-policy";
import { readBookingReport } from "@/modules/booking-reports/service";
import { bookingReportCsv } from "@/modules/booking-reports/model";
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox; default-src 'none'"};
export async function GET(request:NextRequest,{params}:{params:Promise<{batchId:string}>}) {
  const principal=await requestPrincipal(request);if(!principal)return NextResponse.json({error:"Sign in to download this report."},{status:401,headers});
  try{const {batchId}=await params;const report=await readBookingReport(mutationContext(principal,requestIdFor(request)),{batchId,reportId:request.nextUrl.searchParams.get("reportId")??undefined});
    return new NextResponse(bookingReportCsv(report.snapshot),{headers:{...headers,"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="booking-report-v${report.version}.csv"`}});
  }catch{return NextResponse.json({error:"Report unavailable in this company, or your access has changed."},{status:404,headers});}
}
