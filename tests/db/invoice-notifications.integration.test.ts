import { LocalRootKeyProvider, serializeWrappedKey } from "@/security/organization-encryption";
import { loadOrganizationRootKek } from "@/security/root-secret";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { closeDatabasePool, withTenantTransaction } from "@/db/transaction";
import { readInvoiceNotifications } from "@/modules/email/invoice-notifications";
const run=process.env.TEST_DATABASE_URL&&process.env.TEST_APP_DATABASE_URL?describe:describe.skip;
const id={org:randomUUID(),actor:randomUUID(),membership:randomUUID(),role:randomUUID(),entity:randomUUID(),connection:randomUUID(),alias:randomUUID(),message:randomUUID(),duplicateMessage:randomUUID(),first:randomUUID(),second:randomUUID()};
const context={organizationId:id.org,actorId:id.actor,requestId:randomUUID(),authMethod:"oidc",sourceSurface:"API" as const};
run("durable emailed invoice notification summary",()=>{
 const owner=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const fixtureWrite=(sql:string,params:unknown[])=>withTenantTransaction({...context,requestId:randomUUID()},client=>client.query(sql,params));
 beforeAll(async()=>{
   vi.stubEnv("DATABASE_URL",process.env.TEST_APP_DATABASE_URL!);await closeDatabasePool();
   await owner.query("INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES($1::uuid,$2,'Synthetic invoice notice',true,false,'REAL',now())",[id.org,"notice-"+id.org]);
   await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES($1::uuid,$1::text,'synthetic-encrypted','test',true)",[id.actor]);
   await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1::uuid,$2,$3,true)",[id.membership,id.org,id.actor]);
   await owner.query("INSERT INTO roles(id,organization_id,key,display_name) VALUES($1::uuid,$2,'INVOICE_NOTICE_TEST','Invoice notice')",[id.role,id.org]);
   await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1::uuid,$2,unnest(ARRAY['payables.read','payables.manage','organization.settings.manage'])",[id.org,id.role]);
   await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1::uuid,$2,$3,$4)",[id.org,id.membership,id.role,id.actor]);
   const root=loadOrganizationRootKek(),dek=randomBytes(32);
   try { const wrapped=new LocalRootKeyProvider(root).wrapOrganizationKey(id.org,1,dek);
     await owner.query("INSERT INTO organization_key_versions(organization_id,version,key_provider,wrapped_dek,active) VALUES($1,1,$2,$3,true)",[id.org,wrapped.provider,serializeWrappedKey(wrapped)]);
   } finally { root.fill(0);dek.fill(0); }
   await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code) VALUES($1::uuid,$2,'NOTICES','Synthetic notice entity','CA','ON')",[id.entity,id.org]);
   await fixtureWrite("INSERT INTO document_storage_connections(id,organization_id,legal_entity_id,owner_module,provider,label,key_version,active,config_ciphertext,credentials_ciphertext,created_by) VALUES($1::uuid,$2,$3,'payables','ONEDRIVE','Synthetic notices',1,true,'synthetic-config','synthetic-credentials',$4)",[id.connection,id.org,id.entity,id.actor]);
   await owner.query("INSERT INTO email_ingestion_aliases(id,organization_id,label,purpose,address_digest,address_ciphertext,key_version,idempotency_key,command_hash,created_by) VALUES($1::uuid,$2,'Synthetic alias','PAYABLES',$3,'encrypted',1,$1::text,repeat('a',64),$4)",[id.alias,id.org,id.alias.replaceAll("-","").repeat(2),id.actor]);
   for(const [message,received] of [[id.message,"2026-11-11T10:00:00Z"],[id.duplicateMessage,"2026-11-11T10:01:00Z"]]) {
     await owner.query("INSERT INTO inbound_email_messages(id,organization_id,alias_id,provider,provider_event_id,provider_message_id,received_at,key_version,routing_result,status,transient_expires_at) VALUES($1::uuid,$2,$3,'SELF_SMTP',$1::text,$1::text,$4,1,'ROUTED','READY',now()+interval '30 days')",[message,id.org,id.alias,received]);
   }
   for(const item of [id.first,id.second]) await fixtureWrite("INSERT INTO document_inbox_items(id,organization_id,connection_id,owner_module,provider_file_id,content_version,metadata_ciphertext,key_version,mime_type,byte_size,status) VALUES($1::uuid,$2,$3,'payables',$1::text,'v1','encrypted',1,'application/pdf',100,'PENDING')",[item,id.org,id.connection]);
   for(const [message,item,purpose,hash] of [[id.message,id.first,"INVOICE","a"],[id.message,id.second,"INVOICE","b"],[id.message,null,"RECEIPT","c"],[id.duplicateMessage,id.first,"INVOICE","a"]]) {
     const attachment=randomUUID();
     await owner.query("INSERT INTO inbound_email_attachments(id,organization_id,message_id,attachment_key,filename_ciphertext,key_version,mime_type,byte_size,sha256,evidence_purpose,status,inbox_item_id) VALUES($1::uuid,$2,$3,$1::text,'encrypted',1,'application/pdf',100,repeat($4,64),$5,CASE WHEN $6::uuid IS NULL THEN 'STAGED' ELSE 'INBOXED' END,$6)",[attachment,id.org,message,hash,purpose,item]);
   }
 });
 afterAll(async()=>{await closeDatabasePool();await owner.end();vi.unstubAllEnvs();});
 it("counts two invoices in one email, excludes the supporting receipt and redelivery, and offers no duplicate prompt for an unchanged revision",async()=>{
   const before=(await owner.query("SELECT count(*)::int AS n FROM source_documents WHERE organization_id=$1",[id.org])).rows[0].n;
   const summary=await readInvoiceNotifications(context);
   expect(summary).toMatchObject({availability:"AVAILABLE",invoiceCount:2,emailCount:1,readyCount:2,shouldNotify:true});
   expect(summary.items).toHaveLength(2);expect(summary.items.map(item=>item.inboxItemId).sort()).toEqual([id.first,id.second].sort());
   expect((await readInvoiceNotifications(context,summary.revision)).shouldNotify).toBe(false);
   expect((await owner.query("SELECT count(*)::int AS n FROM source_documents WHERE organization_id=$1",[id.org])).rows[0].n).toBe(before);
 });
 it("updates review, completion and active-claim states while leaving the documents untouched by reads",async()=>{
   await fixtureWrite("UPDATE document_inbox_items SET status='NEEDS_REVIEW' WHERE id=$1",[id.second]);
   expect(await readInvoiceNotifications(context)).toMatchObject({readyCount:1,reviewCount:1,invoiceCount:2});
   const asset=randomUUID();
   await fixtureWrite("INSERT INTO document_evidence_assets(id,organization_id,owner_module,filename_ciphertext,content_ciphertext,key_version,mime_type,byte_size,sha256,scanner_version,scanned_at,uploaded_by,idempotency_key,command_hash) VALUES($1::uuid,$2,'payables','encrypted','encrypted',1,'application/pdf',100,repeat('a',64),'Synthetic fixture',now(),$3,$1::text,repeat('e',64))",[asset,id.org,id.actor]);
   await fixtureWrite("UPDATE document_inbox_items SET status='READY_TO_FILE',asset_id=$2,completion_hash=repeat('e',64),processing_ciphertext='synthetic-processing' WHERE id=$1",[id.first,asset]);
   expect(await readInvoiceNotifications(context)).toMatchObject({readyCount:0,reviewCount:1,invoiceCount:1});
   await fixtureWrite("UPDATE document_inbox_items SET status='CLAIMED',claim_id=gen_random_uuid(),claimed_by=$2,claimed_session_id=gen_random_uuid(),lease_until=now()+interval '1 hour' WHERE id=$1",[id.second,id.actor]);
   expect(await readInvoiceNotifications(context)).toMatchObject({claimedCount:1,shouldNotify:false});
   await fixtureWrite("UPDATE document_inbox_items SET lease_until=now()-interval '1 second' WHERE id=$1",[id.second]);
   expect(await readInvoiceNotifications(context)).toMatchObject({readyCount:1,shouldNotify:true});
 });
 it("shows newly received failed intake as review work and rejects revoked or foreign-organization access",async()=>{
   const message=randomUUID(),attachment=randomUUID();
   await owner.query("INSERT INTO inbound_email_messages(id,organization_id,alias_id,provider,provider_event_id,provider_message_id,received_at,key_version,routing_result,status,transient_expires_at) VALUES($1::uuid,$2,$3,'SELF_SMTP',$1::text,$1::text,now(),1,'ROUTED','NEEDS_REVIEW',now()+interval '30 days')",[message,id.org,id.alias]);
   await owner.query("INSERT INTO inbound_email_attachments(id,organization_id,message_id,attachment_key,filename_ciphertext,key_version,mime_type,byte_size,sha256,evidence_purpose,status) VALUES($1::uuid,$2,$3,$1::text,'encrypted',1,'application/pdf',100,repeat('d',64),'INVOICE','QUARANTINED')",[attachment,id.org,message]);
   expect(await readInvoiceNotifications(context)).toMatchObject({intakeFailedCount:1,invoiceCount:2,emailCount:2});
   await expect(readInvoiceNotifications({...context,organizationId:randomUUID()})).rejects.toThrow();
   await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2",[id.org,id.role]);
   await expect(readInvoiceNotifications(context)).rejects.toThrow();
 });
});
