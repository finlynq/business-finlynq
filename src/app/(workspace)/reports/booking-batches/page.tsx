import { randomUUID } from "node:crypto";
import Link from "next/link";
import { z } from "zod";
import { requireWorkspacePrincipal } from "@/modules/workspace/access";
import { mutationContext } from "@/modules/workspace/write-policy";
import { currentWorkspaceEntityContext } from "@/modules/workspace/entity-context";
import { listBookingReports } from "@/modules/booking-reports/service";
import { PageHeader,EmptyState } from "@/app/_components/ui";
import { bookingStatusLabel } from "@/app/_components/booking-report";
export const metadata={title:"Booking reports"};
export default async function BookingReportsPage({searchParams}:{searchParams:Promise<{sourceDocumentId?:string;journalId?:string}>}) {
  const principal=await requireWorkspacePrincipal("/app/reports/booking-batches"),entity=await currentWorkspaceEntityContext(principal),params=await searchParams;
  const sourceDocumentId=z.uuid().safeParse(params.sourceDocumentId),journalId=z.uuid().safeParse(params.journalId);
  const reports=await listBookingReports(mutationContext(principal,randomUUID()),{legalEntityId:entity.selectedEntity?.id,sourceDocumentId:sourceDocumentId.success?sourceDocumentId.data:undefined,journalId:journalId.success?journalId.data:undefined}).catch(()=>null);
  return <div className="page-content"><PageHeader eyebrow="Review & close" title="Booking reports" description="Review draft batches, actual posted results, held items and historical evidence from agent activity."/>{reports?.length?<section aria-label="Booking reports">{reports.map((report)=><article className="panel" key={report.batchId}><h2><Link href={report.url}>{report.title}</Link></h2><p>{report.company} · {bookingStatusLabel(report.status)} · {report.completeness.toLowerCase()} · {report.generatedAt}</p></article>)}</section>:<EmptyState title={reports?"No booking reports yet":"Booking reports are unavailable"}>{reports?"Ask your connected agent to group entries and create a booking review. This page lists the latest 50 batches for your working company.":"Your role must permit reading the ledger and every selected source module."}</EmptyState>}</div>;
}
