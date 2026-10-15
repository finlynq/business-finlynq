import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { type SessionPrincipal, transactionAuthMethod } from "@/modules/identity/session";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import { loadTaxFilingReadiness } from "./filing-readiness";
import { createTaxFiling, createTaxFilingSchema, saveTaxAccountMappings, saveTaxAccountMappingsSchema,
  saveTaxFilingConfiguration, saveTaxFilingConfigurationSchema, TaxFilingError, withAuthorizedTaxWrite } from "./filing-service";

export const taxDraftKindSchema = z.enum(["MAPPING", "CONFIGURATION", "WORKPAPER"]);
export const taxDraftCommandSchema = z.object({
  kind: taxDraftKindSchema, action: z.enum(["SAVE", "REVIEW", "LOCK", "DISCARD", "RESTORE", "CORRECT"]),
  draftId: z.uuid(), expectedVersion: z.number().int().min(0),
  payload: z.record(z.string(), z.unknown()).optional(), reviewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reason: z.string().trim().min(8).max(500), idempotencyKey: z.string().trim().min(1).max(180),
}).strict();
export type TaxDraftKind = z.infer<typeof taxDraftKindSchema>;
export type TaxDraftRow = {
  id: string; draft_id: string; version: number; kind: TaxDraftKind; state: "DRAFT" | "REVIEWED" | "LOCKED" | "DISCARDED";
  payload: Record<string, unknown>; review: Record<string, unknown> | null; review_hash: string | null;
  result: Record<string, unknown> | null; correction_of_draft_id: string | null;
  created_by: string; created_at: string; reason: string; command_hash: string;
};
const permissions = { MAPPING: PERMISSIONS.manageTaxMappings, CONFIGURATION: PERMISSIONS.manageTaxFilingConfiguration, WORKPAPER: PERMISSIONS.prepareTaxFilings };
function failure(message: string, code = "TAX_DRAFT_CONFLICT"): never { throw new TaxFilingError(message, 409, code); }
function parsedPayload(kind: TaxDraftKind, raw: Record<string, unknown>) {
  const schema = kind === "MAPPING" ? saveTaxAccountMappingsSchema : kind === "CONFIGURATION" ? saveTaxFilingConfigurationSchema : createTaxFilingSchema;
  const { idempotencyKey: _key, ...payload } = schema.parse({ ...raw, idempotencyKey: "draft-validation" });
  void _key;
  return payload as Record<string, unknown>;
}
async function latest(client: PoolClient, org: string, draftId: string) {
  return (await client.query<TaxDraftRow>("SELECT * FROM tax_draft_revisions WHERE organization_id=$1 AND draft_id=$2 ORDER BY version DESC LIMIT 1", [org, draftId])).rows[0];
}
export async function listTaxDrafts(principal: SessionPrincipal) {
  return withWorkspaceTenantRead({ organizationId: principal.organizationId, actorId: principal.userId,
    sessionId: principal.sessionId, sessionMode: principal.sessionMode, authMethod: transactionAuthMethod(principal),
    requestId: randomUUID(), sourceSurface: "API" }, "/app/tax", async client => {
    await assertActorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.readTax });
    return (await client.query<TaxDraftRow>(`SELECT * FROM (SELECT DISTINCT ON (draft_id) * FROM tax_draft_revisions
      WHERE organization_id=$1 ORDER BY draft_id,version DESC) current ORDER BY created_at DESC LIMIT 200`, [principal.organizationId])).rows;
  });
}
async function reviewDraft(client: PoolClient, org: string, kind: TaxDraftKind, payload: Record<string, unknown>) {
  const scope = (await client.query(`SELECT entity.id AS "legalEntityId",entity.display_name AS "entityName",
    ledger.id AS "ledgerId",ledger.code AS "ledgerCode",ledger.functional_currency AS currency,
    template.id AS "templateId",template.name AS "templateName",template.version AS "templateVersion",
    template.effective_from::text AS "templateEffectiveFrom",template.effective_to::text AS "templateEffectiveTo",
    EXISTS(SELECT 1 FROM tax_filing_templates newer WHERE newer.template_key=template.template_key AND newer.version>template.version) AS "historicalTemplate"
    FROM legal_entities entity JOIN ledgers ledger ON ledger.organization_id=entity.organization_id AND ledger.legal_entity_id=entity.id
    CROSS JOIN tax_filing_templates template WHERE entity.organization_id=$1 AND entity.id=$2 AND ledger.id=$3 AND template.id=$4`,
    [org,payload.legalEntityId,payload.ledgerId,payload.templateId])).rows[0];
  if (!scope) failure("The draft scope is unavailable in this organization.", "TAX_DRAFT_SCOPE_INVALID");
  const before = kind === "MAPPING" ? (await client.query(`SELECT mapping.id, mapping.version, mapping.effective_from::text AS "effectiveFrom",
    mapping.effective_to::text AS "effectiveTo",coalesce((SELECT jsonb_agg(jsonb_build_object('fieldKey',line.field_key,'glAccountId',line.gl_account_id,
    'balanceBasis',line.balance_basis,'multiplier',line.multiplier::text) ORDER BY line.field_key,line.gl_account_id)
    FROM tax_account_mapping_lines line WHERE line.organization_id=$1 AND line.mapping_set_id=mapping.id),'[]') AS mappings
    FROM tax_account_mapping_sets mapping WHERE organization_id=$1 AND ledger_id=$2 AND template_id=$3 ORDER BY version DESC LIMIT 1`,
    [org,payload.ledgerId,payload.templateId])).rows[0] ?? null
    : kind === "CONFIGURATION" ? (await client.query(`SELECT id,version,template_id AS "templateId",mapping_set_id AS "mappingSetId",state,
      effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo" FROM tax_filing_configurations
      WHERE organization_id=$1 AND legal_entity_id=$2 AND filing_type_key=$3 AND registration_id IS NOT DISTINCT FROM $4::uuid ORDER BY version DESC LIMIT 1`,
      [org,payload.legalEntityId,payload.filingTypeKey,payload.registrationId ?? null])).rows[0] ?? null : null;
  const mapping = payload.mappingSetId ? (await client.query(`SELECT id,version,state,effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo"
    FROM tax_account_mapping_sets WHERE organization_id=$1 AND id=$2 AND ledger_id=$3 AND template_id=$4`,[org,payload.mappingSetId,payload.ledgerId,payload.templateId])).rows[0] ?? null : null;
  const readiness = kind === "WORKPAPER" ? await loadTaxFilingReadiness(client, org, {
    legalEntityId: String(payload.legalEntityId),ledgerId:String(payload.ledgerId),templateId:String(payload.templateId),
    periodStart:String(payload.periodStart),periodEnd:String(payload.periodEnd),configurationId:payload.configurationId as string | undefined,
  }) : null;
  const accountIds=kind==="MAPPING"?(payload.mappings as {glAccountId:string}[]).map(line=>line.glAccountId):[];
  const accounts=accountIds.length?(await client.query(`SELECT id,code,display_name AS name,active,postable FROM gl_accounts
    WHERE organization_id=$1 AND ledger_id=$2 AND id=ANY($3::uuid[]) ORDER BY code,id`,[org,payload.ledgerId,accountIds])).rows:[];
  if(accounts.length!==new Set(accountIds).size)failure("Every mapped account must belong to the selected organization and ledger.","TAX_DRAFT_ACCOUNT_SCOPE");
  const warnings = ["Review lock does not file a return or close an accounting period."];
  if (kind === "MAPPING") warnings.push("Saving and locking a mapping does not activate a filing configuration.");
  if (scope.historicalTemplate || scope.templateEffectiveTo) warnings.push("Historical template version: this creates a separate tenant version and does not activate or change the shared template.");
  if (readiness) warnings.push(...readiness.blockers.map(blocker => blocker.message));
  const snapshot = { scope, before, after: payload, mapping, accounts, readiness: readiness ? { ...readiness, checkedAt: undefined } : null, warnings };
  return { snapshot, hash: createCommandFingerprint("tax.draft.review", snapshot) };
}

export async function commandTaxDraft(input: z.input<typeof taxDraftCommandSchema> & { principal: SessionPrincipal; requestId: string; sourceSurface?: "API" | "MCP" }) {
  const { principal,requestId,sourceSurface,...raw }=input;
  const command=taxDraftCommandSchema.parse(raw);
  const hash=createCommandFingerprint("tax.draft.command",{...command,idempotencyKey:undefined});
  return withAuthorizedTaxWrite({principal,requestId,sourceSurface,permission:permissions[command.kind],reason:command.reason,
    idempotencyKey:command.idempotencyKey,isolationLevel:"SERIALIZABLE"},async client=>{
    const replay=(await client.query<TaxDraftRow>("SELECT * FROM tax_draft_revisions WHERE organization_id=$1 AND idempotency_key=$2",[principal.organizationId,command.idempotencyKey])).rows[0];
    if(replay){if(replay.command_hash!==hash)failure("The command key was already used for different inputs.","IDEMPOTENCY_CONFLICT");return{draft:replay,idempotentReplay:true};}
    const current=await latest(client,principal.organizationId,command.draftId);
    if((current?.version??0)!==command.expectedVersion || (current && current.kind!==command.kind))failure("The draft changed. Reload its latest version.","TAX_DRAFT_VERSION_CONFLICT");
    if(!current && command.action!=="SAVE")failure("Save the draft before reviewing or locking it.");
    if(current?.state==="LOCKED" && command.action!=="CORRECT")failure("This version is locked. Create a corrected version; the original remains immutable.","TAX_DRAFT_LOCKED");
    if(current?.state==="DISCARDED" && command.action!=="RESTORE")failure("Restore the discarded draft before changing it.");
    let draftId=command.draftId,version=(current?.version??0)+1,state:TaxDraftRow["state"]="DRAFT";
    let payload=current?.payload??{},review:Record<string,unknown>|null=null,reviewHash:string|null=null,result:Record<string,unknown>|null=null;
    let correctionOf=current?.correction_of_draft_id??null;
    if(command.action==="SAVE"){
      if(!command.payload)failure("Provide the complete draft inputs.");payload=parsedPayload(command.kind,command.payload);
      await reviewDraft(client,principal.organizationId,command.kind,payload); // Tenant/scope validation, without committing a mapping or calculation.
    }else if(command.payload)failure("Input changes require Save draft and invalidate the previous review.");
    if(command.action==="REVIEW" || command.action==="LOCK"){
      const checked=await reviewDraft(client,principal.organizationId,command.kind,payload);
      review=checked.snapshot;reviewHash=checked.hash;
      if(command.action==="REVIEW"){state="REVIEWED";review={...review,reviewedBy:principal.userId,reviewedAt:new Date().toISOString()};}
      else{
        if(current?.state!=="REVIEWED" || command.reviewHash!==current.review_hash || checked.hash!==current.review_hash)failure("Inputs or their dependencies changed. Review the exact draft again.","TAX_DRAFT_REVIEW_STALE");
        review=current.review;
        const context={principal,requestId,sourceSurface,idempotencyKey:`tax-draft:${draftId}:lock`};
        result=command.kind==="MAPPING"?await saveTaxAccountMappings({...saveTaxAccountMappingsSchema.parse({...payload,idempotencyKey:context.idempotencyKey}),...context},client)
          :command.kind==="CONFIGURATION"?await saveTaxFilingConfiguration({...saveTaxFilingConfigurationSchema.parse({...payload,idempotencyKey:context.idempotencyKey}),...context},client)
          :await createTaxFiling({...createTaxFilingSchema.parse({...payload,idempotencyKey:context.idempotencyKey}),...context},client);
        state="LOCKED";
      }
    }
    if(command.action==="DISCARD")state="DISCARDED";
    if(command.action==="RESTORE" && current?.state!=="DISCARDED")failure("Only a discarded draft can be restored.");
    if(command.action==="CORRECT"){
      if(current?.state!=="LOCKED")failure("Correction requires a locked original version.");
      correctionOf=command.draftId;draftId=randomUUID();version=1;
      if(command.kind==="MAPPING")payload={...payload,expectedMappingVersion:current.result?.version};
      if(command.kind==="WORKPAPER" && payload.filingType==="PREPARED")payload={...payload,correctionOfFilingId:current.result?.filingId};
      if(command.kind==="CONFIGURATION")payload={...payload,expectedConfigurationVersion:current.result?.version};
    }
    const draft=(await client.query<TaxDraftRow>(`INSERT INTO tax_draft_revisions(organization_id,draft_id,version,kind,state,payload,review,review_hash,result,correction_of_draft_id,reason,idempotency_key,command_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[principal.organizationId,draftId,version,command.kind,state,payload,review,reviewHash,result,correctionOf,command.reason,command.idempotencyKey,hash,principal.userId])).rows[0]!;
    return{draft,idempotentReplay:false};
  });
}
