import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { mutationContext } from "@/modules/workspace/write-policy";
import { readBookingReport } from "@/modules/booking-reports/service";
import { PageHeader } from "@/app/_components/ui";
import { BookingReportView } from "@/app/_components/booking-report";
export const metadata={title:"Booking report"};
export default async function BookingReportPage({params,searchParams}:{params:Promise<{batchId:string}>;searchParams:Promise<{reportId?:string}>}) {
  const principal=await requireWorkspacePrincipal("/app/reports/booking-batches");const {batchId}=await params,{reportId}=await searchParams;
  if(!z.uuid().safeParse(batchId).success || (reportId&&!z.uuid().safeParse(reportId).success))notFound();
  const report=await readBookingReport(mutationContext(principal,randomUUID()),{batchId,reportId}).catch(()=>null);
  if(!report)notFound();
  return <div className="page-content"><PageHeader eyebrow="Agent booking review" title={report.snapshot.title} description="An immutable record of selected accounting entries, evidence and posting results."/><BookingReportView report={report}/></div>;
}
