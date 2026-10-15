import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { type SessionPrincipal, transactionAuthMethod } from "@/modules/identity/session";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import { TaxFilingError, withAuthorizedTaxWrite } from "./filing-service";

export const taxWorkpaperControlSchema=z.object({filingId:z.uuid(),action:z.enum(["DELETE","RESTORE","REVIEW","LOCK"]),
  expectedVersion:z.number().int().min(0),previewHash:z.string().regex(/^[a-f0-9]{64}$/),
  confirmation:z.string().min(1).max(100),reason:z.string().trim().min(8).max(500),idempotencyKey:z.string().trim().min(1).max(180)}).strict();
function readContext(principal:SessionPrincipal){return{organizationId:principal.organizationId,actorId:principal.userId,sessionId:principal.sessionId,
  sessionMode:principal.sessionMode,authMethod:transactionAuthMethod(principal),requestId:randomUUID(),sourceSurface:"API" as const};}
async function preview(client:PoolClient,org:string,filingId:string){
  const workpaper=(await client.query(`SELECT filing.id,filing.filing_type AS "filingType",filing.status,
    filing.legal_entity_id AS "legalEntityId",entity.display_name AS "entityName",filing.ledger_id AS "ledgerId",ledger.code AS "ledgerCode",
    filing.period_start::text AS "periodStart",filing.period_end::text AS "periodEnd",filing.source_file_name AS "sourceFileName",filing.external_reference AS "externalReference",
    filing.template_id AS "templateId",filing.mapping_set_id AS "mappingSetId",filing.configuration_id AS "configurationId",filing.configuration_version AS "configurationVersion",
    filing.template_snapshot AS "templateSnapshot",filing.reported_values AS "reportedValues",filing.created_at::text AS "createdAt"
    FROM tax_filings filing JOIN legal_entities entity ON entity.organization_id=filing.organization_id AND entity.id=filing.legal_entity_id
    JOIN ledgers ledger ON ledger.organization_id=filing.organization_id AND ledger.id=filing.ledger_id WHERE filing.organization_id=$1 AND filing.id=$2`,[org,filingId])).rows[0];
  if(!workpaper)throw new TaxFilingError("The workpaper was not found in this organization.",404,"FILING_NOT_FOUND");
  const events=(await client.query(`SELECT version,action,reason,created_by AS "createdBy",created_at::text AS "createdAt" FROM tax_workpaper_control_events
    WHERE organization_id=$1 AND filing_id=$2 ORDER BY version`,[org,filingId])).rows;
  const dependencies=(await client.query(`SELECT 'canonical selection' AS kind,id::text FROM tax_filing_canonical_selections WHERE organization_id=$1 AND filing_id=$2
    UNION ALL SELECT 'refreshed comparison',id::text FROM tax_filings WHERE organization_id=$1 AND (template_snapshot->>'refreshedFromFilingId'=$2::text OR template_snapshot->>'correctionOfFilingId'=$2::text)
    UNION ALL SELECT 'lifecycle / replacement',id::text FROM tax_filing_lifecycle_events WHERE organization_id=$1 AND (replacement_filing_id=$2 OR (filing_id=$2 AND state IN ('ARCHIVED','SUPERSEDED')))
    UNION ALL SELECT 'asset adjustment',id::text FROM tax_filing_asset_adjustments WHERE organization_id=$1 AND filing_id=$2
    UNION ALL SELECT 'locked preparation inputs',draft_id::text FROM tax_draft_revisions WHERE organization_id=$1 AND state='LOCKED' AND result->>'filingId'=$2::text`,[org,filingId])).rows;
  const deleted=events.filter(event=>["DELETE","RESTORE"].includes(event.action)).at(-1)?.action==="DELETE";
  const reasons:string[]=[];
  if(!events.some(event=>event.action==="CREATED"))reasons.push("Prior review, export and submission history cannot be established for this legacy workpaper.");
  if(events.some(event=>["REVIEW","LOCK","EXPORT"].includes(event.action)))reasons.push("A review, lock or export requires retention.");
  if(workpaper.filingType!=="PREPARED" || workpaper.sourceFileName || workpaper.externalReference || Object.keys(workpaper.templateSnapshot.inputReportedValues??{}).length || workpaper.templateSnapshot.refreshedFromFilingId || workpaper.templateSnapshot.correctionOfFilingId)reasons.push("Historical imports and source evidence must be retained.");
  if(dependencies.length)reasons.push("Other records depend on this workpaper.");
  const details={workpaper,version:events.at(-1)?.version??0,deleted,events,dependencies,eligible:reasons.length===0,reasons,
    submissionState:"No external submission is performed or certified by this application. Delete requires explicit confirmation that this draft remains unfiled.",
    retention:"Only ordinary views hide the draft. Its UUID, inputs, amounts, evidence, lineage and audit history remain unchanged. Restore never makes it canonical or activates a configuration."};
  return{...details,previewHash:createCommandFingerprint("tax.workpaper.control-preview",details)};
}
export async function previewTaxWorkpaperControl(principal:SessionPrincipal,filingId:string){
  return withWorkspaceTenantRead(readContext(principal),"/app/tax",async client=>{
    await assertActorHasActivePermission(client,{organizationId:principal.organizationId,actorId:principal.userId,permission:PERMISSIONS.readTax});
    return preview(client,principal.organizationId,z.uuid().parse(filingId));
  });
}
export async function listDeletedTaxWorkpapers(principal:SessionPrincipal){
  return withWorkspaceTenantRead(readContext(principal),"/app/tax",async client=>{
    await assertActorHasActivePermission(client,{organizationId:principal.organizationId,actorId:principal.userId,permission:PERMISSIONS.readTax});
    return(await client.query(`SELECT filing.id,filing.filing_type AS "filingType",filing.period_start::text AS "periodStart",filing.period_end::text AS "periodEnd",
      entity.display_name AS "entityName" FROM tax_filings filing JOIN legal_entities entity ON entity.organization_id=filing.organization_id AND entity.id=filing.legal_entity_id
      WHERE filing.organization_id=$1 AND app.tax_workpaper_deleted(filing.organization_id,filing.id) ORDER BY filing.created_at DESC LIMIT 200`,[principal.organizationId])).rows;
  });
}
export async function commandTaxWorkpaperControl(input:z.input<typeof taxWorkpaperControlSchema>&{principal:SessionPrincipal;requestId:string;sourceSurface?:"API"|"MCP"}){
  const{principal,requestId,sourceSurface,...raw}=input;const command=taxWorkpaperControlSchema.parse(raw);
  const hash=createCommandFingerprint("tax.workpaper.control",{...command,idempotencyKey:undefined});
  return withAuthorizedTaxWrite({principal,requestId,sourceSurface,permission:PERMISSIONS.manageTaxFilingCanonical,reason:command.reason,idempotencyKey:command.idempotencyKey},async client=>{
    const replay=(await client.query("SELECT * FROM tax_workpaper_control_events WHERE organization_id=$1 AND idempotency_key=$2",[principal.organizationId,command.idempotencyKey])).rows[0];
    if(replay){if(replay.command_hash!==hash)throw new TaxFilingError("The command key conflicts with another request.",409,"IDEMPOTENCY_CONFLICT");return{event:replay,idempotentReplay:true};}
    const current=await preview(client,principal.organizationId,command.filingId);
    if(current.version!==command.expectedVersion || current.previewHash!==command.previewHash)throw new TaxFilingError("The workpaper or its dependencies changed. Preview the exact record again.",409,"WORKPAPER_PREVIEW_STALE");
    const expected=`${command.action} ${command.filingId}${command.action==="DELETE"?" UNFILED":""}`;
    if(command.confirmation!==expected)throw new TaxFilingError(`Confirm the exact action by entering ${expected}.`,400,"WORKPAPER_CONFIRMATION_REQUIRED");
    if(command.action==="DELETE" && (!current.eligible || current.deleted))throw new TaxFilingError("Only an unfiled, unreviewed, unlocked and unreferenced preparation draft can be deleted.",409,"WORKPAPER_RETAINED",current);
    if((command.action==="RESTORE")!==current.deleted)throw new TaxFilingError("The draft visibility changed. Reload the exact record.",409,"WORKPAPER_VISIBILITY_CONFLICT");
    const event=(await client.query(`INSERT INTO tax_workpaper_control_events(organization_id,filing_id,version,action,reason,idempotency_key,command_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[principal.organizationId,command.filingId,current.version+1,command.action,command.reason,command.idempotencyKey,hash,principal.userId])).rows[0];
    return{event,idempotentReplay:false};
  });
}
/** An export is a retention dependency, even though it is a read capability. */
export async function retainTaxWorkpaperExport(principal:SessionPrincipal,filingId:string,contentHash:string){
  return withWorkspaceTenantRead(readContext(principal),"/app/tax",async client=>{
    await assertActorHasActivePermission(client,{organizationId:principal.organizationId,actorId:principal.userId,permission:PERMISSIONS.readTax});
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('tax-governance:'||$1::text,0))",[principal.organizationId]);
    await client.query(`INSERT INTO tax_workpaper_control_events(organization_id,filing_id,version,action,reason,idempotency_key,command_hash,created_by)
      SELECT $1,$2,coalesce(max(version),0)+1,'EXPORT','Retain workpaper used by an explicit export',$3,$4,$5 FROM tax_workpaper_control_events WHERE organization_id=$1 AND filing_id=$2
      HAVING NOT EXISTS(SELECT 1 FROM tax_workpaper_control_events WHERE organization_id=$1 AND idempotency_key=$3)`,[principal.organizationId,filingId,`export:${filingId}:${contentHash}`,contentHash,principal.userId]);
  });
}
