import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { activeKeyVersion, decryptStorageValue, encryptStorageValue } from "@/modules/document-storage/store";
import { canonicalHash } from "@/modules/subledger/document-model";
import { assertPermission } from "@/modules/subledger/ar-ap-access";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";
import { issueBusinessDocument } from "@/modules/subledger/ar-ap-service";
import { postJournal } from "@/modules/ledger/posting-service";
import { captureBookingSnapshot } from "./capture";
import { createBookingBatchSchema, readBookingReportSchema, refreshBookingReportSchema, postBookingBatchSchema, type BookingDefinition, type BookingSnapshot } from "./model";

type BatchRow = { id:string; organization_id:string; key_version:number; definition_ciphertext:string; required_permissions:Permission[]; command_hash:string };
type ReportRow = { id:string; organization_id:string; batch_id:string; key_version:number; snapshot_ciphertext:string; version:number; phase:"REVIEW"|"OUTCOME"; snapshot_hash:string; command_hash:string };
export type BookingReport = {batchId:string;reportId:string;version:number;url:string;reportUrl:string;hash:string;status:BookingSnapshot["summary"]["status"];completeness:BookingSnapshot["summary"]["completeness"];selectedRecords:BookingDefinition["records"];snapshot:BookingSnapshot};
async function lock(client:PoolClient, context:TenantTransactionContext, key:string) { await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`booking:${context.organizationId}:${key}`]); }
async function loadBatch(client:PoolClient,context:TenantTransactionContext,id:string) {
  await assertPermission(client,context,PERMISSIONS.readMcpLedger);
  const row = (await client.query<BatchRow>("SELECT * FROM booking_batches WHERE organization_id=$1 AND id=$2",[context.organizationId,id])).rows[0];
  if (!row) throw new Error("Booking report is unavailable in this company");
  for (const permission of row.required_permissions) await assertPermission(client,context,permission);
  const definition=createBookingBatchSchema.parse(await decryptStorageValue(client,row,"booking_batches","definition_ciphertext",row.definition_ciphertext));
  return {row,definition};
}
async function decoded(client:PoolClient,row:ReportRow,definition:BookingDefinition):Promise<BookingReport> {
  const snapshot = await decryptStorageValue(client,row,"booking_batch_reports","snapshot_ciphertext",row.snapshot_ciphertext) as BookingSnapshot;
  if (snapshot.schemaVersion !== 1 || canonicalHash(snapshot)!==row.snapshot_hash) throw new Error("Booking report integrity check failed");
  const url=`/app/reports/booking-batches/${row.batch_id}?reportId=${row.id}`;
  return {batchId:row.batch_id,reportId:row.id,version:row.version,url,reportUrl:url,hash:row.snapshot_hash,status:snapshot.summary.status,completeness:snapshot.summary.completeness,selectedRecords:definition.records,snapshot};
}
async function replay(client:PoolClient,context:TenantTransactionContext,key:string,hash:string,definition:BookingDefinition,batchId:string) {
  const row=(await client.query<ReportRow>("SELECT * FROM booking_batch_reports WHERE organization_id=$1 AND idempotency_key=$2",[context.organizationId,key])).rows[0];
  if (!row) return null;
  if (row.command_hash!==hash || row.batch_id!==batchId) throw new Error("Idempotency key was already used for a different booking report command");
  return decoded(client,row,definition);
}
async function appendReport(client:PoolClient,context:TenantTransactionContext,batchId:string,definition:BookingDefinition,snapshot:BookingSnapshot,key:string,commandHash:string) {
  if(snapshot.reviewReportId) {
    const priorRow=(await client.query<ReportRow>("SELECT * FROM booking_batch_reports WHERE organization_id=$1 AND batch_id=$2 AND id=$3",[context.organizationId,batchId,snapshot.reviewReportId])).rows[0];
    if(priorRow) {
      const prior=(await decoded(client,priorRow,definition)).snapshot;
      for(const entry of snapshot.entries.filter((item)=>item.differences.length)) {
        const before=prior.entries.find((item)=>item.selected.id===entry.selected.id);if(!before)continue;
        const labels={description:"Description",accountingDate:"Accounting date",documentDate:"Source date",currency:"Currency",net:"Net amount",tax:"Tax",gross:"Invoice total",grossFunctional:"Functional invoice value"} as const;
        for(const [key,label] of Object.entries(labels)) {const field=key as keyof typeof labels;if(before[field]!==entry[field])entry.differences.push(`${label}: ${before[field]??"none"} → ${entry[field]??"none"}`);}
        if(canonicalHash(before.lines)!==canonicalHash(entry.lines))entry.differences.push("Account lines or FX evidence changed; compare the original draft review with these current lines.");
        if(canonicalHash(before.attachments)!==canonicalHash(entry.attachments))entry.differences.push("Supporting evidence changed since the original review.");
      }
    }
  }
  const id=randomUUID(),keyVersion=await activeKeyVersion(client,context.organizationId),hash=canonicalHash(snapshot);
  const encrypted=await encryptStorageValue(client,{id,organization_id:context.organizationId,key_version:keyVersion},"booking_batch_reports","snapshot_ciphertext",snapshot);
  const row=(await client.query<ReportRow>(`INSERT INTO booking_batch_reports (id,organization_id,batch_id,version,phase,status,completeness,snapshot_ciphertext,key_version,snapshot_hash,command_hash,idempotency_key,review_report_id,created_by)
    VALUES($1,$2,$3,(SELECT coalesce(max(version),0)+1 FROM booking_batch_reports WHERE organization_id=$2 AND batch_id=$3),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [id,context.organizationId,batchId,snapshot.phase,snapshot.summary.status,snapshot.summary.completeness,encrypted,keyVersion,hash,commandHash,key,snapshot.reviewReportId,context.actorId])).rows[0];
  return decoded(client,row,definition);
}
export async function createBookingBatch(context:TenantTransactionContext,input:unknown):Promise<BookingReport> {
  const definition=createBookingBatchSchema.parse(input),hash=canonicalHash(definition); assertTenantWritesEnabled(context);
  return withTenantTransaction({...context,reason:definition.reason},async(client)=> {
    await assertWritableOrganization(client,context);await assertPermission(client,context,PERMISSIONS.readMcpLedger);await lock(client,context,definition.idempotencyKey);
    const existing=(await client.query<BatchRow>("SELECT * FROM booking_batches WHERE organization_id=$1 AND idempotency_key=$2",[context.organizationId,definition.idempotencyKey])).rows[0];
    if (existing) {const {definition:saved}=await loadBatch(client,context,existing.id);if(existing.command_hash!==hash)throw new Error("Idempotency key already belongs to another booking batch");const result=await replay(client,context,definition.idempotencyKey,hash,saved,existing.id);if(!result)throw new Error("Initial booking report is unavailable");return result;}
    const snapshot=await captureBookingSnapshot(client,context,definition,"REVIEW",null);
    if(snapshot.entries.some((entry)=>entry.differences.length))throw new Error("Selected entries changed. Read their current versions and hashes and create a new review.");
    const requiredPermissions:Permission[]=[PERMISSIONS.readMcpLedger];
    if(snapshot.entries.some((entry)=>entry.sourceType?.startsWith("payables.")))requiredPermissions.push(PERMISSIONS.readPayables);
    if(snapshot.entries.some((entry)=>entry.sourceType?.startsWith("receivables.")))requiredPermissions.push(PERMISSIONS.readReceivables);
    const id=randomUUID(),keyVersion=await activeKeyVersion(client,context.organizationId);
    const encrypted=await encryptStorageValue(client,{id,organization_id:context.organizationId,key_version:keyVersion},"booking_batches","definition_ciphertext",definition);
    await client.query(`INSERT INTO booking_batches(id,organization_id,legal_entity_id,ledger_id,record_refs,required_permissions,definition_ciphertext,key_version,command_hash,idempotency_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id,context.organizationId,definition.legalEntityId,definition.ledgerId,JSON.stringify(snapshot.entries.map((entry)=>({type:entry.selected.type,id:entry.selected.id,sourceType:entry.sourceType,sourceNumber:entry.sourceNumber}))),requiredPermissions,encrypted,keyVersion,hash,definition.idempotencyKey,context.actorId]);
    return appendReport(client,context,id,definition,snapshot,definition.idempotencyKey,hash);
  },{isolationLevel:"REPEATABLE READ"});
}
export async function readBookingReport(context:TenantTransactionContext,input:unknown):Promise<BookingReport> {
  const args=readBookingReportSchema.parse(input);
  return withTenantTransaction(context,async(client)=> {const {definition}=await loadBatch(client,context,args.batchId);
    const row=(await client.query<ReportRow>(`SELECT * FROM booking_batch_reports WHERE organization_id=$1 AND batch_id=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY version DESC LIMIT 1`,[context.organizationId,args.batchId,args.reportId ?? null])).rows[0];
    if(!row)throw new Error("Booking report is unavailable in this company");return decoded(client,row,definition);
  },{isolationLevel:"REPEATABLE READ"});
}
export async function refreshBookingReport(context:TenantTransactionContext,input:unknown):Promise<BookingReport> {
  const args=refreshBookingReportSchema.parse(input),hash=canonicalHash({operation:"refresh",...args});assertTenantWritesEnabled(context);
  return withTenantTransaction({...context,reason:args.reason},async(client)=> {await assertWritableOrganization(client,context);await lock(client,context,args.batchId);const {definition}=await loadBatch(client,context,args.batchId);
    const old=await replay(client,context,args.idempotencyKey,hash,definition,args.batchId);if(old)return old;
    const review=(await client.query<{id:string}>("SELECT id FROM booking_batch_reports WHERE organization_id=$1 AND batch_id=$2 AND phase='REVIEW' ORDER BY version LIMIT 1",[context.organizationId,args.batchId])).rows[0];
    const snapshot=await captureBookingSnapshot(client,{...context,reason:args.reason},definition,"OUTCOME",review?.id ?? null);
    return appendReport(client,context,args.batchId,definition,snapshot,args.idempotencyKey,hash);
  },{isolationLevel:"REPEATABLE READ"});
}
export async function postBookingBatch(context:TenantTransactionContext,input:unknown,assertConnectionAccess?:(entries:BookingSnapshot["entries"])=>void):Promise<BookingReport | {batchId:string;reportGenerationRequired:true;url:string;message:string}> {
  const args=postBookingBatchSchema.parse(input),hash=canonicalHash({operation:"post",...args});assertTenantWritesEnabled(context);
  const prepared=await withTenantTransaction(context,async(client)=> {await assertWritableOrganization(client,context);const {definition}=await loadBatch(client,context,args.batchId);
    const old=await replay(client,context,args.idempotencyKey,hash,definition,args.batchId);if(old)return {old,definition,review:null};
    const row=(await client.query<ReportRow>("SELECT * FROM booking_batch_reports WHERE organization_id=$1 AND batch_id=$2 AND id=$3 AND phase='REVIEW'",[context.organizationId,args.batchId,args.reviewReportId])).rows[0];
    if(!row || row.snapshot_hash!==args.expectedReviewHash)throw new Error("An exact immutable draft review is required before booking");
    const review=await decoded(client,row,definition);return {old:null,definition,review};
  });
  if(prepared.old)return prepared.old;
  assertConnectionAccess?.(prepared.review!.snapshot.entries);
  const failures:Record<string,string>={};
  for(const selected of prepared.definition.records) {
    const entry=prepared.review!.snapshot.entries.find((candidate)=>candidate.selected.id===selected.id)!;
    try {
      // Existing commands hold source/journal locks and recheck the exact selected
      // version/hash and live permissions. Reading this report grants no posting authority.
      if(entry.linesArePosted)continue;
      if(entry.heldReason || entry.differences.length) {failures[selected.id]=entry.heldReason ?? "Selected entry changed; create a new review";continue;}
      const childContext={...context,reason:args.reason,requestId:`booking:${args.batchId}:${selected.id}`};
      if(selected.type==="SOURCE_DOCUMENT" && (entry.kind==="SUPPLIER_BILL" || entry.kind==="SALES_INVOICE")) {
        await issueBusinessDocument({context:childContext,kind:entry.kind,sourceNumber:entry.sourceNumber,expectedVersion:selected.expectedVersion,idempotencyKey:`booking:${args.batchId}:${selected.id}`});
      } else if(selected.type==="JOURNAL") {
        await postJournal({context:childContext,journalId:selected.id,expectedContentHash:selected.expectedContentHash,...(selected.expectedVersion>0?{expectedApprovalVersion:selected.expectedVersion}:{})});
      } else failures[selected.id]="Settlement must be booked through its normal settlement workflow";
    } catch { failures[selected.id]="Posting was held. Review the current version, journal approval, period, permissions and tax review before retrying."; }
  }
  try {
    return await withTenantTransaction({...context,reason:args.reason},async(client)=> {await assertWritableOrganization(client,context);await lock(client,context,args.batchId);const {definition}=await loadBatch(client,context,args.batchId);
      const old=await replay(client,context,args.idempotencyKey,hash,definition,args.batchId);if(old)return old;
      const snapshot=await captureBookingSnapshot(client,{...context,reason:args.reason},definition,"OUTCOME",args.reviewReportId,failures);
      return appendReport(client,context,args.batchId,definition,snapshot,args.idempotencyKey,hash);
    },{isolationLevel:"REPEATABLE READ"});
  }catch{return {batchId:args.batchId,reportGenerationRequired:true,url:`/app/reports/booking-batches/${args.batchId}`,message:"Booking commands finished, but the outcome report could not be saved. Use finlynq_daily_refresh_booking_batch_report to capture current results without posting again, or retry this identical command."};}
}
export async function listBookingReports(context:TenantTransactionContext,filter:{legalEntityId?:string;sourceDocumentId?:string;journalId?:string}={}) {
  return withTenantTransaction(context,async(client)=> {
    await assertPermission(client,context,PERMISSIONS.readMcpLedger);
    const rows=(await client.query<BatchRow>(`SELECT b.* FROM booking_batches b WHERE b.organization_id=$1 AND ($2::uuid IS NULL OR b.legal_entity_id=$2)
      AND NOT EXISTS(SELECT 1 FROM unnest(b.required_permissions) p WHERE NOT app.current_actor_has_permission(p))
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(b.record_refs) r JOIN source_documents s ON s.organization_id=b.organization_id AND s.id=$3 WHERE r->>'sourceType'=s.source_type AND r->>'sourceNumber'=s.source_number))
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(b.record_refs) r WHERE (r->>'type'='JOURNAL' AND r->>'id'=$4::text) OR EXISTS(SELECT 1 FROM journal_entries j JOIN source_documents s ON s.organization_id=j.organization_id AND s.id=j.source_document_id WHERE j.organization_id=b.organization_id AND j.id=$4 AND r->>'sourceType'=s.source_type AND r->>'sourceNumber'=s.source_number))) ORDER BY b.created_at DESC LIMIT 50`,[context.organizationId,filter.legalEntityId ?? null,filter.sourceDocumentId ?? null,filter.journalId ?? null])).rows;
    const result: {batchId:string;title:string;company:string;generatedAt:string;status:string;completeness:string;url:string}[]=[];
    for(const row of rows){const {definition}=await loadBatch(client,context,row.id);const report=(await client.query<ReportRow>("SELECT * FROM booking_batch_reports WHERE organization_id=$1 AND batch_id=$2 ORDER BY version DESC LIMIT 1",[context.organizationId,row.id])).rows[0];if(!report)continue;const view=await decoded(client,report,definition);result.push({batchId:row.id,title:definition.title,company:view.snapshot.company,generatedAt:view.snapshot.generatedAt,status:view.status,completeness:view.completeness,url:view.url});}
    return result;
  });
}
