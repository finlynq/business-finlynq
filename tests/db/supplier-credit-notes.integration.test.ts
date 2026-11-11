import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import { LocalRootKeyProvider, serializeWrappedKey, encryptField, serializeEncryptedField } from "@/security/organization-encryption";
import { loadOrganizationRootKek } from "@/security/root-secret";
import { createBusinessDocumentDraft, editBusinessDocumentDraft, issueBusinessDocument, listPayableOpenItems,
  voidSettlementAndReverseAllocations, voidIssuedBusinessDocument } from "@/modules/subledger/ar-ap-service";
import { applySupplierCredit } from "@/modules/subledger/supplier-credit-application";
import { uploadDocumentEvidence, attachDocumentEvidence, downloadDocumentEvidence } from "@/modules/subledger/evidence-service";
vi.mock("@/security/evidence-scanner", () => ({ scanEvidence: vi.fn(async () => ({ version: "Synthetic integration scanner", scannedAt: new Date().toISOString() })) }));
const run=process.env.TEST_DATABASE_URL&&process.env.TEST_APP_DATABASE_URL?describe:describe.skip;
const id={org:randomUUID(),actor:randomUUID(),member:randomUUID(),role:randomUUID(),entity:randomUUID(),ledger:randomUUID(),period:randomUUID(),revenue:randomUUID(),expense:randomUUID(),cash:randomUUID(),expenseCombination:randomUUID(),cashCombination:randomUUID(),outsider:randomUUID(),party:randomUUID(),partyAccount:randomUUID(),payable:randomUUID(),payableCombination:randomUUID(),liability:randomUUID(),liabilityCombination:randomUUID(),taxRegistration:randomUUID(),gainCombination:randomUUID()};
const context=()=>({organizationId:id.org,actorId:id.actor,requestId:randomUUID(),authMethod:"oidc",sourceSurface:"API" as const,reason:"Synthetic booking regression"});
run("supplier credit posting and application",()=>{
 const owner=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 beforeAll(async()=>{vi.stubEnv("DATABASE_URL",process.env.TEST_APP_DATABASE_URL!);vi.stubEnv("BUSINESS_WRITES_ENABLED","true");await closeDatabasePool();
    await owner.query("INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES($1,$2,'Synthetic tax regression',true,false,'REAL',now())", [id.org, `tax-refresh-${id.org}`]);
    for (const actor of [id.actor, id.outsider]) await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES($1,$2,'synthetic-encrypted','synthetic-hash',true)", [actor, `tax-refresh-${actor}`]);
    await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,true)", [id.member, id.org, id.actor]);
    await owner.query("INSERT INTO roles(id,organization_id,key,display_name,system_template) VALUES($1,$2,'TAX_REFRESH_TEST','Synthetic tax role',false)", [id.role, id.org]);
    await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,unnest($3::text[])", [id.org, id.role, ["mcp.ledger.read", "payables.read", "payables.manage", "payables.post", "payables.settle", "payables.void", "tax.determinations.override", "ledger.journal.draft", "ledger.journal.post", "ledger.journal.reverse"]]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)", [id.org, id.member, id.role, id.actor]);
    await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code) VALUES($1,$2,'TAX','Synthetic entity','CA','ON')", [id.entity, id.org]);
    await owner.query("INSERT INTO ledgers(id,organization_id,legal_entity_id,code,display_name,kind,accounting_profile,functional_currency) VALUES($1,$2,$3,'PRIMARY','Synthetic ledger','PRIMARY','CAN_ASPE','CAD')", [id.ledger, id.org, id.entity]);
    await owner.query("INSERT INTO fiscal_periods(id,organization_id,ledger_id,fiscal_year,period_number,label,starts_on,ends_on) VALUES($1,$2,$3,2025,12,'Synthetic annual period','2025-01-01','2025-12-31')", [id.period, id.org, id.ledger]);
    await owner.query(`INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES
      ($1,$4,$5,'4100','Synthetic revenue','REVENUE','NONE',true,true,'2025-01-01'),
      ($2,$4,$5,'6200','New expense','EXPENSE','NONE',true,true,'2025-01-01'),
      ($3,$4,$5,'1000','Synthetic cash','ASSET','NONE',true,true,'2025-01-01')`, [id.revenue, id.expense, id.cash, id.org, id.ledger]);
    await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$3,$4,$5,$6),($2,$3,$4,$5,$7)", [id.expenseCombination, id.cashCombination, id.org, id.ledger, id.entity, id.expense, id.cash]);

 const root=loadOrganizationRootKek(),dek=randomBytes(32);try {const wrapped=new LocalRootKeyProvider(root).wrapOrganizationKey(id.org,1,dek);await owner.query("INSERT INTO organization_key_versions(organization_id,version,key_provider,wrapped_dek,active) VALUES($1,1,$2,$3,true)",[id.org,wrapped.provider,serializeWrappedKey(wrapped)]);
 const encrypted=serializeEncryptedField(encryptField("Synthetic supplier",dek,{organizationId:id.org,table:"parties",column:"display_name_ciphertext",recordId:id.party,keyVersion:1}));
 await owner.query("INSERT INTO parties(id,organization_id,party_number,display_name_ciphertext,display_name_key_version,search_token) VALUES($1,$2,'SUPPLIER',$3,1,'hmac-sha256-v1:'||repeat('a',64))",[id.party,id.org,encrypted]);
 const registration=serializeEncryptedField(encryptField("Synthetic GST reference",dek,{organizationId:id.org,table:"entity_tax_registrations",column:"registration_ciphertext",recordId:id.taxRegistration,keyVersion:1}));
 await owner.query("INSERT INTO entity_tax_registrations(id,organization_id,legal_entity_id,regime_key,destination_country,destination_region,destination_city,registration_ciphertext,key_version,valid_from) VALUES($1,$2,$3,'ca.on.hst','CA','ON','Ottawa',$4,'1','2025-01-01')",[id.taxRegistration,id.org,id.entity,registration]);
 }finally{root.fill(0);dek.fill(0);}
 await owner.query("INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES($1,$3,$4,'2100','Supplier payable','LIABILITY','AP',true,true,'2025-01-01'),($2,$3,$4,'2300','Shareholder or card liability','LIABILITY','NONE',true,true,'2025-01-01')",[id.payable,id.liability,id.org,id.ledger]);
 await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$3,$4,$5,$6),($2,$3,$4,$5,$7)",[id.payableCombination,id.liabilityCombination,id.org,id.ledger,id.entity,id.payable,id.liability]);
 await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$2,$3,$4,$5)",[id.gainCombination,id.org,id.ledger,id.entity,id.revenue]);
 await owner.query("INSERT INTO party_accounts(id,organization_id,legal_entity_id,ledger_id,party_id,role,account_number,control_account_id) VALUES($1,$2,$3,$4,$5,'SUPPLIER','SUPPLIER',$6)",[id.partyAccount,id.org,id.entity,id.ledger,id.party,id.payable]);
 await owner.query("INSERT INTO tax_pack_versions(id,pack_key,version,jurisdiction,effective_from,source_uri,source_digest,approved_by,approved_at) VALUES($1,'ca.on.hst','2026.08.26','CA-ON','2016-07-01','https://example.test/synthetic-credit-test',repeat('a',64),$2,now()) ON CONFLICT (pack_key,version) DO NOTHING",[randomUUID(),id.actor]);

 },30000);
 afterAll(async()=>{await closeDatabasePool();await owner.end();vi.unstubAllEnvs();});

 async function issue(kind: "SUPPLIER_BILL" | "SUPPLIER_CREDIT_NOTE", netAmount: string, currency="CAD", rate="1") {
   const sourceNumber=(kind === "SUPPLIER_BILL" ? "BILL-" : "CREDIT-")+randomUUID();
   const command={context:context(),kind,sourceNumber,ledgerId:id.ledger,legalEntityId:id.entity,
     partyAccountId:id.partyAccount,controlAccountCombinationId:id.payableCombination,taxAccountCombinationId:id.cashCombination,
     documentDate:"2025-12-15",accountingDate:"2025-12-15",periodId:id.period,dueOn:"2025-12-31",currency,
     fx:{rate,source:"Synthetic documented rate",effectiveAt:"2025-12-15T00:00:00Z"},description:"Synthetic supplier credit regression",
     lines:[{description:"Synthetic expense",accountCombinationId:id.expenseCombination,netAmount,
       tax:{packKey:"ca.on.hst",category:"STANDARD" as const,destinationCountry:"CA",destinationRegion:"ON",destinationCity:"Ottawa",registrationId:id.taxRegistration,recoverablePercent:"100"}}],idempotencyKey:randomUUID()};
   const draft=await createBusinessDocumentDraft(command);
   expect((await createBusinessDocumentDraft(command)).document.id).toBe(draft.document.id);
   const edited=await editBusinessDocumentDraft({...command,expectedVersion:1,fx:undefined,fxResolutionMode:"PRESERVE",idempotencyKey:randomUUID()});
   expect(edited.document.version).toBe(2);
   let expectedVersion=edited.document.version;
   let assetId: string | undefined;
   const bytes=Buffer.from("%PDF-1.4\nSynthetic supplier credit\n%%EOF");
   if(kind==="SUPPLIER_CREDIT_NOTE") {
     const evidence=await uploadDocumentEvidence({context:context(),module:"payables",filename:"synthetic-credit.pdf",mimeType:"application/pdf",
       byteSize:bytes.length,contentBase64:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex"),idempotencyKey:randomUUID()});
     assetId=evidence.asset.assetId;
     const attached=await attachDocumentEvidence({context:context(),kind,sourceNumber,expectedVersion,assetId,purpose:"INVOICE",reason:"Synthetic booking regression",idempotencyKey:randomUUID()});
     expectedVersion=attached.document.version;
   }
   const issueCommand={context:context(),kind,sourceNumber,expectedVersion,idempotencyKey:randomUUID()};
   const result=await issueBusinessDocument(issueCommand);
   expect((await issueBusinessDocument(issueCommand)).journalId).toBe(result.journalId);
   if(assetId) {
     const download=await downloadDocumentEvidence({context:context(),sourceDocumentId:result.document.id,assetId});
     expect(download.bytes.equals(bytes)).toBe(true);
   }
   return result;
 }
 it("posts reversing tax and expense, applies partially and reverses both balances with historical reconstruction",async()=>{
   const bill=await issue("SUPPLIER_BILL","200.00");
   const credit=await issue("SUPPLIER_CREDIT_NOTE","100.00");
   const lines=(await owner.query("SELECT debit_functional::text,credit_functional::text,account_combination_id FROM journal_lines WHERE journal_entry_id=$1 ORDER BY line_number",[credit.journalId])).rows;
   expect(lines).toMatchObject([{account_combination_id:id.payableCombination,debit_functional:"113.000000000"},{account_combination_id:id.expenseCombination,credit_functional:"100.000000000"},{account_combination_id:id.cashCombination,credit_functional:"13.000000000"}]);
   const tax=(await owner.query("SELECT taxable_basis::text,total_tax::text FROM tax_determination_snapshots WHERE source_document_id=$1",[credit.document.id])).rows[0];
   expect(tax).toEqual({taxable_basis:"-100.000000000",total_tax:"-13.000000000"});
   const command={context:context(),sourceNumber:"APPLY-"+randomUUID(),ledgerId:id.ledger,legalEntityId:id.entity,partyAccountId:id.partyAccount,
     controlAccountCombinationId:id.payableCombination,periodId:id.period,accountingDate:"2025-12-16",currency:"CAD",
     creditOpenItemId:credit.openItemId,billOpenItemId:bill.openItemId,amount:"56.50",realizedFxGainAccountCombinationId:id.gainCombination,
     realizedFxLossAccountCombinationId:id.expenseCombination,description:"Apply synthetic supplier credit",idempotencyKey:randomUUID()};
   const applied=await applySupplierCredit(command);
   expect((await applySupplierCredit(command)).journalId).toBe(applied.journalId);
   const balances=await listPayableOpenItems({context:context(),documentKind:"ALL"});
   expect(balances.find(item=>item.openItemId===bill.openItemId)).toMatchObject({remainingAmount:"169.500000000",documentKind:"BILL"});
   expect(balances.find(item=>item.openItemId===credit.openItemId)).toMatchObject({remainingAmount:"56.500000000",documentKind:"CREDIT"});
   const net=(await owner.query("SELECT sum(debit_functional-credit_functional)::text AS net FROM journal_lines WHERE journal_entry_id=$1 AND account_combination_id=$2",[applied.journalId,id.payableCombination])).rows[0];
   expect(Number(net.net)).toBe(0);
   await expect(voidIssuedBusinessDocument({context:{...context(),reason:"Synthetic correction"},kind:"SUPPLIER_CREDIT_NOTE",sourceNumber:credit.document.sourceNumber,expectedVersion:credit.document.version,periodId:id.period,accountingDate:"2025-12-17",reason:"Synthetic correction",description:"Reverse credit",idempotencyKey:randomUUID()})).rejects.toThrow();
   await voidSettlementAndReverseAllocations({context:{...context(),reason:"Synthetic correction"},kind:"SUPPLIER_CREDIT_APPLICATION",sourceNumber:applied.document.sourceNumber,expectedVersion:1,periodId:id.period,accountingDate:"2025-12-17",reason:"Synthetic correction",description:"Reverse credit application",idempotencyKey:randomUUID()});
   expect((await listPayableOpenItems({context:context(),documentKind:"CREDIT"})).find(item=>item.openItemId===credit.openItemId)?.remainingAmount).toBe("113.000000000");
   expect((await listPayableOpenItems({context:context(),documentKind:"CREDIT",asOfDate:"2025-12-16"})).find(item=>item.openItemId===credit.openItemId)?.remainingAmount).toBe("56.500000000");
   const reversed=await voidIssuedBusinessDocument({context:{...context(),reason:"Synthetic correction"},kind:"SUPPLIER_CREDIT_NOTE",sourceNumber:credit.document.sourceNumber,expectedVersion:credit.document.version,periodId:id.period,accountingDate:"2025-12-18",reason:"Synthetic correction",description:"Reverse credit",idempotencyKey:randomUUID()});
   expect(reversed.document.status).toBe("VOIDED");
 },30000);
 it("prevents concurrent over-application and balances different foreign-currency carrying rates",async()=>{
   const bill=await issue("SUPPLIER_BILL","200.00","USD","1.4");
   const credit=await issue("SUPPLIER_CREDIT_NOTE","100.00","USD","1.3");
   const command={context:context(),sourceNumber:"APPLY-"+randomUUID(),ledgerId:id.ledger,legalEntityId:id.entity,partyAccountId:id.partyAccount,
     controlAccountCombinationId:id.payableCombination,periodId:id.period,accountingDate:"2025-12-16",currency:"USD",creditOpenItemId:credit.openItemId,
     billOpenItemId:bill.openItemId,amount:"113.00",realizedFxGainAccountCombinationId:id.gainCombination,realizedFxLossAccountCombinationId:id.expenseCombination,
     description:"Apply foreign supplier credit",idempotencyKey:randomUUID()};
   const outcomes=await Promise.allSettled([applySupplierCredit(command),applySupplierCredit({...command,sourceNumber:"APPLY-"+randomUUID(),idempotencyKey:randomUUID()})]);
   expect(outcomes.filter(result=>result.status==="fulfilled")).toHaveLength(1);
   const posted=outcomes.find(result=>result.status==="fulfilled")!;
   if(posted.status!=="fulfilled")throw new Error("No application posted");
   const gain=(await owner.query("SELECT credit_functional::text AS gain FROM journal_lines WHERE journal_entry_id=$1 AND account_combination_id=$2",[posted.value.journalId,id.gainCombination])).rows[0];
   expect(gain.gain).toBe("11.300000000");
   const balances=await listPayableOpenItems({context:context(),documentKind:"ALL",currency:"USD",statuses:["OPEN","PARTIALLY_SETTLED","SETTLED"]});
   expect(balances.find(item=>item.openItemId===credit.openItemId)?.remainingAmount).toBe("0.000000000");
   expect(balances.find(item=>item.openItemId===bill.openItemId)?.remainingAmount).toBe("113.000000000");
   await expect(applySupplierCredit({...command,sourceNumber:"BAD-"+randomUUID(),creditOpenItemId:randomUUID(),idempotencyKey:randomUUID()})).rejects.toThrow();
 },30000);
 it("keeps excess credit available and rejects invalid references, closed periods and revoked settlement permission",async()=>{
   const bill=await issue("SUPPLIER_BILL","100.00");
   const credit=await issue("SUPPLIER_CREDIT_NOTE","200.00");
   const command={context:context(),sourceNumber:"APPLY-"+randomUUID(),ledgerId:id.ledger,legalEntityId:id.entity,partyAccountId:id.partyAccount,
     controlAccountCombinationId:id.payableCombination,periodId:id.period,accountingDate:"2025-12-16",currency:"CAD",creditOpenItemId:credit.openItemId,
     billOpenItemId:bill.openItemId,amount:"113.00",realizedFxGainAccountCombinationId:id.gainCombination,realizedFxLossAccountCombinationId:id.expenseCombination,
     description:"Apply excess supplier credit",idempotencyKey:randomUUID()};
   await expect(applySupplierCredit({...command,controlAccountCombinationId:id.expenseCombination})).rejects.toThrow();
   await expect(applySupplierCredit({...command,creditOpenItemId:randomUUID()})).rejects.toThrow();
   const closed=randomUUID();
   await owner.query("INSERT INTO fiscal_periods(id,organization_id,ledger_id,fiscal_year,period_number,label,starts_on,ends_on,state) VALUES($1,$2,$3,2024,12,'Closed synthetic period','2024-12-01','2024-12-31','HARD_CLOSED')",[closed,id.org,id.ledger]);
   await expect(applySupplierCredit({...command,periodId:closed,accountingDate:"2024-12-16"})).rejects.toThrow(/open|closed|period/i);
   await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_key='payables.settle'",[id.org,id.role]);
   try { await expect(applySupplierCredit(command)).rejects.toThrow(); }
   finally { await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,'payables.settle')",[id.org,id.role]); }
   await applySupplierCredit(command);
   const balances=await listPayableOpenItems({context:context(),documentKind:"ALL",statuses:["OPEN","PARTIALLY_SETTLED","SETTLED"]});
   expect(balances.find(item=>item.openItemId===credit.openItemId)?.remainingAmount).toBe("113.000000000");
   expect(balances.find(item=>item.openItemId===bill.openItemId)?.remainingAmount).toBe("0.000000000");
 },30000);

});
