import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { closeDatabasePool, withTenantTransaction } from "@/db/transaction";
import { AuthorizationDeniedError } from "@/modules/identity/authorization-error";
import type { SessionPrincipal } from "@/modules/identity/session";
import { saveTaxAccountMappings, saveTaxFilingConfiguration, createTaxFiling, setTaxFilingCanonical } from "@/modules/tax/filing-service";
import { loadTaxFilingWorkspace } from "@/modules/tax/filing-workspace";



const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const id = { org: randomUUID(), actor: randomUUID(), member: randomUUID(), role: randomUUID(),
  entity: randomUUID(), ledger: randomUUID(), period: randomUUID(),
  revenue: randomUUID(), expense: randomUUID(), cash: randomUUID(),
  expenseCombination: randomUUID(), cashCombination: randomUUID(), outsider: randomUUID(),
  manager: randomUUID(), managerMember: randomUUID(), managerRole: randomUUID() };
const templateId = "f2000000-0000-4000-8000-000000000002";
const scope = { legalEntityId: id.entity, ledgerId: id.ledger, templateId };
const period = { periodStart: "2025-01-01", periodEnd: "2025-12-31" };
const principal: SessionPrincipal = { sessionId: randomUUID(), userId: id.actor, organizationId: id.org,
  membershipId: id.member, organizationName: "Synthetic tax regressions", roleLabel: "Test tax role",
  displayName: "Synthetic actor", initials: "ST", sessionMode: "real", authMethod: "OIDC",
  expiresAt: new Date(Date.now() + 3600000), mfaVerifiedAt: null, stepUpExpiresAt: null, organizationWritesEnabled: true };
const mappingLine = (glAccountId: string) => ({ fieldKey: "wp_book_net_income", glAccountId, balanceBasis: "NET_CREDIT" as const, multiplier: "1.000000" });
const commandContext = () => ({ principal, requestId: randomUUID(), sourceSurface: "MCP" as const });
const managerPrincipal = { ...principal, userId: id.manager, membershipId: id.managerMember, roleLabel: "Owner" };

import { commandTaxDraft } from "@/modules/tax/draft-service";
import { commandTaxWorkpaperControl, previewTaxWorkpaperControl, listDeletedTaxWorkpapers, retainTaxWorkpaperExport } from "@/modules/tax/workpaper-controls";
import { exportTaxFilingWorkpaper } from "@/modules/tax/filing-export";

run("reviewed tax drafts and recoverable workpapers",()=>{
 const owner=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 let v1:Awaited<ReturnType<typeof saveTaxAccountMappings>>;
 let original:Awaited<ReturnType<typeof createTaxFiling>>;
 let originalSnapshot:unknown;
 let mappingId:string;
 let configurationId:string;
 let lockedWorkpaperId:string;
 const mappingDraftId=randomUUID();
 const draft=(kind:"MAPPING"|"CONFIGURATION"|"WORKPAPER",draftId:string,action:"SAVE"|"REVIEW"|"LOCK"|"DISCARD"|"RESTORE"|"CORRECT",expectedVersion:number,extra:Record<string,unknown>={})=>commandTaxDraft({...commandContext(),kind,draftId,action,expectedVersion,reason:"Synthetic reviewed tax acceptance",idempotencyKey:randomUUID(),...extra});
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", process.env.TEST_APP_DATABASE_URL!);
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    await closeDatabasePool();
    await owner.query("INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES($1,$2,'Synthetic tax regression',true,false,'REAL',now())", [id.org, `tax-refresh-${id.org}`]);
    for (const actor of [id.actor, id.outsider, id.manager]) await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES($1,$2,'synthetic-encrypted','synthetic-hash',true)", [actor, `tax-refresh-${actor}`]);
    await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,true)", [id.member, id.org, id.actor]);
    await owner.query("INSERT INTO roles(id,organization_id,key,display_name,system_template) VALUES($1,$2,'OWNER','Synthetic owner role',false)", [id.role, id.org]);
    await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,unnest($3::text[])", [id.org, id.role, ["tax.read", "tax.mappings.manage", "tax.filings.prepare", "tax.filing.configuration.manage", "tax.filing.canonical.manage", "ledger.journal.draft", "ledger.journal.post"]]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)", [id.org, id.member, id.role, id.actor]);
    await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,true)", [id.managerMember,id.org,id.manager]);
    await owner.query("INSERT INTO roles(id,organization_id,key,display_name,system_template) VALUES($1,$2,'TAX_MANAGER','Synthetic tax manager',false)", [id.managerRole,id.org]);
    await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,permission_key FROM role_permissions WHERE organization_id=$1 AND role_id=$3", [id.org,id.managerRole,id.role]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)", [id.org,id.managerMember,id.managerRole,id.actor]);
    await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code) VALUES($1,$2,'TAX','Synthetic entity','CA','ON')", [id.entity, id.org]);
    await owner.query("INSERT INTO ledgers(id,organization_id,legal_entity_id,code,display_name,kind,accounting_profile,functional_currency) VALUES($1,$2,$3,'PRIMARY','Synthetic ledger','PRIMARY','CAN_ASPE','CAD')", [id.ledger, id.org, id.entity]);
    await owner.query("INSERT INTO fiscal_periods(id,organization_id,ledger_id,fiscal_year,period_number,label,starts_on,ends_on) VALUES($1,$2,$3,2025,12,'Synthetic annual period','2025-01-01','2025-12-31')", [id.period, id.org, id.ledger]);
    await owner.query(`INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES
      ($1,$4,$5,'4100','Synthetic revenue','REVENUE','NONE',true,true,'2025-01-01'),
      ($2,$4,$5,'6200','New expense','EXPENSE','NONE',true,true,'2025-01-01'),
      ($3,$4,$5,'1000','Synthetic cash','ASSET','NONE',true,true,'2025-01-01')`, [id.revenue, id.expense, id.cash, id.org, id.ledger]);
    await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$3,$4,$5,$6),($2,$3,$4,$5,$7)", [id.expenseCombination, id.cashCombination, id.org, id.ledger, id.entity, id.expense, id.cash]);
    v1 = await saveTaxAccountMappings({ ...commandContext(), ...scope, expectedTemplateVersion: 2, expectedMappingVersion: 0,
      effectiveFrom: "2025-01-01", mappings: [mappingLine(id.revenue)], reason: "Initial synthetic mapping", idempotencyKey: randomUUID() });
    const configuration = await saveTaxFilingConfiguration({ ...commandContext(), ...scope, mappingSetId: v1.mappingSetId,
      filingTypeKey: "ca.t2.corporation-income-tax", expectedConfigurationVersion: 0, effectiveFrom: "2025-01-01", reason: "Initial synthetic configuration", idempotencyKey: randomUUID() });
    original = await createTaxFiling({ ...commandContext(), ...scope, ...period, configurationId: configuration.configurationId,
      filingType: "HISTORICAL_IMPORT", externalReference: "Synthetic original return", sourceFileName: "synthetic.csv",
      reportedValues: { line_300: "0" }, manualValues: { wp_schedule_1_additions: "0", wp_schedule_1_deductions: "3.25" }, idempotencyKey: randomUUID() });
    originalSnapshot = (await owner.query("SELECT to_jsonb(filing) AS data FROM tax_filings filing WHERE id=$1", [original.filingId])).rows[0].data;
  }, 30000);

  afterAll(async () => { await closeDatabasePool(); await owner.end(); vi.unstubAllEnvs(); });

 it("invalidates review after date/account edits and atomically locks the exact mapping",async()=>{
  const payload={...scope,expectedTemplateVersion:2,expectedMappingVersion:1,effectiveFrom:"2025-02-01",mappings:[mappingLine(id.revenue)],reason:"Synthetic draft mapping change"};
  const saved=await draft("MAPPING",mappingDraftId,"SAVE",0,{payload});expect(saved.draft.state).toBe("DRAFT");
  const reviewed=await draft("MAPPING",mappingDraftId,"REVIEW",1);expect(reviewed.draft.review?.before).toMatchObject({version:1});
  const edited=await draft("MAPPING",mappingDraftId,"SAVE",2,{payload:{...payload,effectiveFrom:"2025-02-02",mappings:[mappingLine(id.revenue),mappingLine(id.expense)]}});
  expect(edited.draft).toMatchObject({state:"DRAFT",review_hash:null});
  await expect(draft("MAPPING",mappingDraftId,"LOCK",3,{reviewHash:reviewed.draft.review_hash})).rejects.toMatchObject({code:"TAX_DRAFT_REVIEW_STALE"});
  const current=await draft("MAPPING",mappingDraftId,"REVIEW",3);
  const key=randomUUID();const locked=await draft("MAPPING",mappingDraftId,"LOCK",4,{reviewHash:current.draft.review_hash,idempotencyKey:key});
  mappingId=String(locked.draft.result?.mappingSetId);expect(locked.draft.state).toBe("LOCKED");
  expect((await draft("MAPPING",mappingDraftId,"LOCK",4,{reviewHash:current.draft.review_hash,idempotencyKey:key})).idempotentReplay).toBe(true);
  await expect(draft("MAPPING",mappingDraftId,"SAVE",5,{payload})).rejects.toMatchObject({code:"TAX_DRAFT_LOCKED"});
  await expect(draft("MAPPING",mappingDraftId,"DISCARD",5)).rejects.toMatchObject({code:"TAX_DRAFT_LOCKED"});
  const correction=await draft("MAPPING",mappingDraftId,"CORRECT",5);expect(correction.draft).toMatchObject({state:"DRAFT",correction_of_draft_id:mappingDraftId});
  expect(correction.draft.payload.expectedMappingVersion).toBe(2);
  expect((await owner.query("SELECT effective_from::text FROM tax_account_mapping_sets WHERE id=$1",[mappingId])).rows[0].effective_from).toBe("2025-02-02");
 });
 it("locks configuration and calculation inputs without rewriting historical amounts or period locks",async()=>{
  const configId=randomUUID();const payload={...scope,mappingSetId:mappingId,filingTypeKey:"ca.t2.corporation-income-tax",expectedConfigurationVersion:1,effectiveFrom:"2025-02-02",reason:"Synthetic reviewed activation"};
  await draft("CONFIGURATION",configId,"SAVE",0,{payload});const review=await draft("CONFIGURATION",configId,"REVIEW",1);
  const locked=await draft("CONFIGURATION",configId,"LOCK",2,{reviewHash:review.draft.review_hash});configurationId=String(locked.draft.result?.configurationId);
  const workId=randomUUID();await draft("WORKPAPER",workId,"SAVE",0,{payload:{...scope,...period,configurationId,filingType:"PREPARED"}});
  const workReview=await draft("WORKPAPER",workId,"REVIEW",1);const work=await draft("WORKPAPER",workId,"LOCK",2,{reviewHash:workReview.draft.review_hash});
  const snapshot=(await owner.query("SELECT template_snapshot FROM tax_filings WHERE id=$1",[work.draft.result?.filingId])).rows[0].template_snapshot;
  expect(snapshot).toMatchObject({version:2,mappingVersion:2});
  const corrected=await draft("WORKPAPER",workId,"CORRECT",3);const correctedReview=await draft("WORKPAPER",corrected.draft.draft_id,"REVIEW",1);
  const correctedLock=await draft("WORKPAPER",corrected.draft.draft_id,"LOCK",2,{reviewHash:correctedReview.draft.review_hash});
  const correctedSnapshot=(await owner.query("SELECT template_snapshot FROM tax_filings WHERE id=$1",[correctedLock.draft.result?.filingId])).rows[0].template_snapshot;
  expect(correctedSnapshot.correctionOfFilingId).toBe(work.draft.result?.filingId);
  expect((await owner.query("SELECT template_snapshot FROM tax_filings WHERE id=$1",[work.draft.result?.filingId])).rows[0].template_snapshot).toEqual(snapshot);
  lockedWorkpaperId=String(work.draft.result?.filingId);
  expect((await previewTaxWorkpaperControl(principal,lockedWorkpaperId)).eligible).toBe(true);
  expect((await owner.query("SELECT to_jsonb(filing) data FROM tax_filings filing WHERE id=$1",[original.filingId])).rows[0].data).toEqual(originalSnapshot);
  expect((await owner.query("SELECT count(*)::int count FROM period_events WHERE organization_id=$1",[id.org])).rows[0].count).toBe(0);
 });
 it("discards/restores versioned inputs and rejects concurrent edits and cross-tenant IDs",async()=>{
  const draftId=randomUUID();const payload={...scope,...period,configurationId,filingType:"PREPARED"};await draft("WORKPAPER",draftId,"SAVE",0,{payload});
  const outcomes=await Promise.allSettled([draft("WORKPAPER",draftId,"SAVE",1,{payload}),draft("WORKPAPER",draftId,"SAVE",1,{payload})]);expect(outcomes.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  await draft("WORKPAPER",draftId,"DISCARD",2);const restored=await draft("WORKPAPER",draftId,"RESTORE",3);expect(restored.draft).toMatchObject({state:"DRAFT",version:4,review_hash:null});
  await expect(commandTaxDraft({...commandContext(),principal:{...principal,organizationId:randomUUID()},kind:"WORKPAPER",action:"REVIEW",draftId,expectedVersion:4,reason:"Foreign tenant attempt",idempotencyKey:randomUUID()})).rejects.toBeDefined();
  await expect(owner.query("UPDATE tax_draft_revisions SET reason='Rewrite audit history' WHERE draft_id=$1",[draftId])).rejects.toMatchObject({code:"23514"});
 });
 let fixtureMonth=2;
 async function prepared(){fixtureMonth++;return createTaxFiling({...commandContext(),...scope,periodStart:`2025-${String(fixtureMonth).padStart(2,"0")}-01`,periodEnd:`2025-${String(fixtureMonth).padStart(2,"0")}-28`,configurationId,filingType:"PREPARED",idempotencyKey:randomUUID()});}
 async function control(filingId:string,action:"DELETE"|"RESTORE"|"REVIEW"|"LOCK",current?:Awaited<ReturnType<typeof previewTaxWorkpaperControl>>){
  const checked=current??await previewTaxWorkpaperControl(principal,filingId);return commandTaxWorkpaperControl({...commandContext(),filingId,action,expectedVersion:checked.version,previewHash:checked.previewHash,confirmation:`${action} ${filingId}`,reason:"Synthetic exact workpaper decision",idempotencyKey:randomUUID()});
 }
 it("lets owners move reports to Trash and restore the same immutable snapshot",async()=>{
  const work=await prepared();const before=(await owner.query("SELECT to_jsonb(f) data FROM tax_filings f WHERE id=$1",[work.filingId])).rows[0].data;
  expect((await previewTaxWorkpaperControl(principal,work.filingId)).eligible).toBe(true);await control(work.filingId,"DELETE");
  expect((await loadTaxFilingWorkspace(principal)).filings.some(f=>f.id===work.filingId)).toBe(false);
  expect((await listDeletedTaxWorkpapers(principal)).some(f=>f.id===work.filingId)).toBe(true);
  await expect(setTaxFilingCanonical({...commandContext(),filingId:work.filingId,expectedSelectionVersion:0,reason:"Cannot reference hidden draft",idempotencyKey:randomUUID()})).rejects.toBeDefined();
  await control(work.filingId,"RESTORE");expect((await owner.query("SELECT to_jsonb(f) data FROM tax_filings f WHERE id=$1",[work.filingId])).rows[0].data).toEqual(before);
  expect((await loadTaxFilingWorkspace(principal)).filings.some(f=>f.id===work.filingId)).toBe(true);
  expect((await previewTaxWorkpaperControl(principal,original.filingId)).eligible).toBe(true);
 });
 it("allows owner cleanup after exports and reviews while rejecting stale previews",async()=>{
  const work=await prepared();const before=await previewTaxWorkpaperControl(principal,work.filingId);
  await exportTaxFilingWorkpaper(principal,{filingId:work.filingId,format:"JSON",allowDraftWithWarnings:true});
  await expect(control(work.filingId,"DELETE",before)).rejects.toMatchObject({code:"WORKPAPER_PREVIEW_STALE"});
  await control(work.filingId,"DELETE");
  await expect(exportTaxFilingWorkpaper(principal,{filingId:work.filingId,format:"JSON",allowDraftWithWarnings:true})).rejects.toBeDefined();
  const exportHash=(await owner.query("SELECT command_hash FROM tax_workpaper_control_events WHERE organization_id=$1 AND filing_id=$2 AND action='EXPORT'",[id.org,work.filingId])).rows[0].command_hash;
  // An export can load the report just before cleanup; even its existing
  // idempotency key must recheck visibility after acquiring the shared fence.
  await expect(retainTaxWorkpaperExport(principal,work.filingId,exportHash)).rejects.toMatchObject({code:"WORKPAPER_DELETED"});
  await control(work.filingId,"RESTORE");
  expect((await previewTaxWorkpaperControl(principal,work.filingId)).events.some(event=>event.action==="EXPORT")).toBe(true);
  const reviewed=await prepared();await control(reviewed.filingId,"REVIEW");await control(reviewed.filingId,"LOCK");
  expect((await previewTaxWorkpaperControl(principal,reviewed.filingId)).eligible).toBe(true);
  await control(reviewed.filingId,"DELETE");await control(reviewed.filingId,"RESTORE");
  await expect(owner.query("DELETE FROM tax_workpaper_control_events WHERE filing_id=$1",[reviewed.filingId])).rejects.toMatchObject({code:"23514"});
 });
 it("serializes delete against a new canonical dependency and rejects unauthorized actions",async()=>{
  const work=await prepared();const checked=await previewTaxWorkpaperControl(principal,work.filingId);
  const outcomes=await Promise.allSettled([control(work.filingId,"DELETE",checked),setTaxFilingCanonical({...commandContext(),filingId:work.filingId,expectedSelectionVersion:0,reason:"Synthetic racing canonical decision",idempotencyKey:randomUUID()})]);
  expect(outcomes.filter(result=>result.status==="fulfilled")).toHaveLength(1);
  const current=await previewTaxWorkpaperControl(principal,work.filingId);
  expect(current.deleted ? current.dependencies.length===0 : current.dependencies.length>0).toBe(true);
  await expect(commandTaxDraft({...commandContext(),principal:{...principal,userId:id.outsider},kind:"WORKPAPER",action:"SAVE",draftId:randomUUID(),expectedVersion:0,payload:{...scope,...period,configurationId,filingType:"PREPARED"},reason:"Unauthorized draft attempt",idempotencyKey:randomUUID()})).rejects.toBeDefined();
 });
 it("cleans up imported and locked correction history with existing links and restores canonical visibility",async()=>{
  await setTaxFilingCanonical({...commandContext(),filingId:original.filingId,expectedSelectionVersion:0,reason:"Synthetic canonical historical filing",idempotencyKey:randomUUID()});
  for(const filingId of [original.filingId,lockedWorkpaperId]){
    const before=await previewTaxWorkpaperControl(principal,filingId);
    expect(before.dependencies.length).toBeGreaterThan(0);
    await control(filingId,"DELETE",before);
    expect((await loadTaxFilingWorkspace(principal)).filings.some(f=>f.id===filingId)).toBe(false);
    expect((await listDeletedTaxWorkpapers(principal)).some(f=>f.id===filingId)).toBe(true);
    const hidden=await previewTaxWorkpaperControl(principal,filingId);
    expect(hidden.workpaper).toEqual(before.workpaper);expect(hidden.dependencies).toEqual(before.dependencies);
    await control(filingId,"RESTORE",hidden);
    const restored=await previewTaxWorkpaperControl(principal,filingId);
    expect(restored.workpaper).toEqual(before.workpaper);expect(restored.dependencies).toEqual(before.dependencies);
  }
  expect((await loadTaxFilingWorkspace(principal)).filings.find(f=>f.id===original.filingId)?.canonical).toBe(true);
  expect((await owner.query("SELECT count(*)::int count FROM period_events WHERE organization_id=$1",[id.org])).rows[0].count).toBe(0);
 });
 it("denies non-owner managers in the service and database even with an Owner display label",async()=>{
  const checked=await previewTaxWorkpaperControl(managerPrincipal,original.filingId);
  expect(checked).toMatchObject({canManageDeletion:false,eligible:false});
  const request={...commandContext(),principal:managerPrincipal,filingId:original.filingId,action:"DELETE" as const,expectedVersion:checked.version,previewHash:checked.previewHash,confirmation:`DELETE ${original.filingId}`,reason:"Synthetic non-owner cleanup attempt",idempotencyKey:randomUUID()};
  await expect(commandTaxWorkpaperControl(request)).rejects.toBeInstanceOf(AuthorizationDeniedError);
  await expect(withTenantTransaction({organizationId:id.org,actorId:id.manager,sessionId:principal.sessionId,sessionMode:"real",authMethod:"oidc",requestId:randomUUID(),sourceSurface:"API",reason:request.reason},async client=>{
    await client.query(`INSERT INTO tax_workpaper_control_events(organization_id,filing_id,version,action,reason,idempotency_key,command_hash,created_by)
      VALUES($1,$2,$3,'DELETE',$4,$5,$6,$7)`,[id.org,original.filingId,checked.version+1,request.reason,randomUUID(),"a".repeat(64),id.manager]);
  })).rejects.toMatchObject({code:"42501"});
  await control(original.filingId,"DELETE");
  const hidden=await previewTaxWorkpaperControl(managerPrincipal,original.filingId);
  await expect(commandTaxWorkpaperControl({...request,action:"RESTORE",expectedVersion:hidden.version,previewHash:hidden.previewHash,confirmation:`RESTORE ${original.filingId}`,idempotencyKey:randomUUID()})).rejects.toBeInstanceOf(AuthorizationDeniedError);
  await control(original.filingId,"RESTORE");
 });
 it("binds cleanup to an exact preview and confirmation, serializes deletes and rechecks ownership on replay",async()=>{
  const work=await prepared();const checked=await previewTaxWorkpaperControl(principal,work.filingId);
  const request={...commandContext(),filingId:work.filingId,action:"DELETE" as const,expectedVersion:checked.version,previewHash:checked.previewHash,confirmation:`DELETE ${work.filingId}`,reason:"Synthetic exact owner cleanup",idempotencyKey:randomUUID()};
  await expect(commandTaxWorkpaperControl({...request,confirmation:`DELETE ${original.filingId}`})).rejects.toMatchObject({code:"WORKPAPER_CONFIRMATION_REQUIRED"});
  const competingRequest={...request,idempotencyKey:randomUUID()};
  const results=await Promise.allSettled([commandTaxWorkpaperControl(request),commandTaxWorkpaperControl(competingRequest)]);
  expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
  const replayRequest=results[0].status==="fulfilled"?request:competingRequest;
  expect((await commandTaxWorkpaperControl(replayRequest)).idempotentReplay).toBe(true);
  await expect(commandTaxWorkpaperControl({...request,principal:{...principal,organizationId:randomUUID()}})).rejects.toBeDefined();
  await owner.query("DELETE FROM membership_roles WHERE organization_id=$1 AND membership_id=$2 AND role_id=$3",[id.org,id.member,id.role]);
  await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)",[id.org,id.member,id.managerRole,id.actor]);
  try{await expect(commandTaxWorkpaperControl(replayRequest)).rejects.toBeInstanceOf(AuthorizationDeniedError);}
  finally{
    await owner.query("DELETE FROM membership_roles WHERE organization_id=$1 AND membership_id=$2 AND role_id=$3",[id.org,id.member,id.managerRole]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)",[id.org,id.member,id.role,id.actor]);
  }
  await control(work.filingId,"RESTORE");
 });
});
