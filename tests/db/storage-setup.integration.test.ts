import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabasePool, withTenantTransaction } from "@/db/transaction";
import { LocalRootKeyProvider, serializeWrappedKey } from "@/security/organization-encryption";
import { loadOrganizationRootKek } from "@/security/root-secret";
import { encryptStorageValue } from "@/modules/document-storage/store";
import { prepareStorageSetup, approveStorageSetup, getStorageSetup } from "@/modules/document-storage/setup";
import { finishStorageConnection, startStorageConnection } from "@/modules/document-storage/connections";
import { prepareAndUploadPdf } from "@/modules/document-storage/prepare-pdf-upload";
import { scanEvidence } from "@/security/evidence-scanner";
import { pdf } from "../fixtures/oversized-pdf";
import type { SessionPrincipal } from "@/modules/identity/session";
import type { StorageProvider } from "@/modules/document-storage/model";
import type { CloudFile, StorageLocation } from "@/modules/document-storage/provider";

const cloud = vi.hoisted(() => ({ folders: new Map<string, CloudFile>(), bytes: new Map<string, Buffer>(), provisions: 0, uploads: 0, expired: false }));
vi.mock("@/security/evidence-scanner", () => ({ scanEvidence: vi.fn(async () => ({ version: "synthetic-scanner", scannedAt: new Date().toISOString() })) }));
vi.mock("@/modules/document-storage/provider", async (original) => {
  const actual = await original<typeof import("@/modules/document-storage/provider")>();
  return { ...actual, exchangeStorageToken: vi.fn(async () => ({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600000 })),
    CloudDrive: class {
      constructor(readonly provider: StorageProvider) {}
      async appFolder() { if (cloud.expired) throw new actual.StorageError("STORAGE_RECONNECT", "Renew the original grant"); return { id: "app-folder", driveId: "drive" }; }
      async folder(parentId: string, name: string) {
        const id = `${parentId}/${name}`;
        if (!cloud.folders.has(id)) cloud.folders.set(id, { id, parentId, name, driveId: "drive", folder: true, mimeType: "folder", size: 0, version: "v1" });
        return id;
      }
      async findUpload(folderId: string, stem: string) {
        return [...cloud.folders.values()].find((entry) => entry.parentId === folderId && entry.name === `${stem}.pdf`) ?? null;
      }
      async upload(folderId: string, name: string, mimeType: string, bytes: Buffer) {
        cloud.uploads += 1;
        const id = `${folderId}/${name}`;
        const file: CloudFile = { id, parentId: folderId, name, driveId: "drive", folder: false, mimeType, size: bytes.length, version: "v1" };
        cloud.folders.set(id, file); cloud.bytes.set(id, Buffer.from(bytes)); return file;
      }
      async download(id: string) { const bytes = cloud.bytes.get(id); if (!bytes) throw new Error("Synthetic file missing"); return Buffer.from(bytes); }
      async file(id: string) { const result = cloud.folders.get(id); if (!result) throw new Error("Synthetic folder missing"); return result; }
      async provision(name: string, existing?: StorageLocation) {
        cloud.provisions += 1;
        if (existing) return existing;
        for (const [id, parentId] of [[name, "app-folder"], [name + "/inbox", name], [name + "/archive", name]]) {
          cloud.folders.set(id, { id, parentId, name: id, driveId: "drive", folder: true, mimeType: "folder", size: 0, version: "v1" });
        }
        return { accountId: "drive", driveId: "drive", rootId: name, inboxId: name + "/inbox", archiveId: name + "/archive", inboxUrl: "https://onedrive.live.com/?id=" + encodeURIComponent(name + "/inbox"), archiveUrl: "https://onedrive.live.com/?id=" + encodeURIComponent(name + "/archive") };
      }
    },
  };
});
const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const ids = { org: randomUUID(), other: randomUUID(), actor: randomUUID(), colleague: randomUUID(), entity: randomUUID(), secondEntity: randomUUID(), role: randomUUID(), membership: randomUUID(), session: randomUUID(), donor: randomUUID() };
const context = () => ({ organizationId: ids.org, actorId: ids.actor, sessionId: ids.session, sessionMode: "real" as const, requestId: randomUUID(), authMethod: "password+mfa", sourceSurface: "MCP" as const, reason: "Synthetic storage setup" });
const principal: SessionPrincipal = { sessionId: ids.session, userId: ids.actor, organizationId: ids.org, membershipId: ids.membership, organizationName: "Setup test", roleLabel: "Owner", displayName: "Tester", initials: "T", sessionMode: "real", authMethod: "PASSWORD", expiresAt: new Date(Date.now() + 3600000), mfaVerifiedAt: new Date(), stepUpExpiresAt: new Date(Date.now() + 3600000), organizationWritesEnabled: true };
const input = () => ({ provider: "ONEDRIVE" as const, legalEntityId: ids.entity, module: "receivables" as const, label: "Sales " + randomUUID(), reuseConnectionId: ids.donor, idempotencyKey: randomUUID() });
run("storage setup consent and grant reuse", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let readyConnectionId: string;
  beforeAll(async () => {
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true"); vi.stubEnv("DOCUMENT_MICROSOFT_CLIENT_ID", "synthetic-client"); vi.stubEnv("DOCUMENT_MICROSOFT_CLIENT_SECRET", "synthetic-secret"); vi.stubEnv("DOCUMENT_MICROSOFT_CLIENT_SECRET_FILE", ""); vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    await owner.query("INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES ($1,$2,'Setup test',true,false,'REAL',now()),($3,$4,'Other setup',true,false,'REAL',now())", [ids.org, 'setup-' + ids.org, ids.other, 'setup-' + ids.other]);
    await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES ($1,$2,'encrypted','test',true)", [ids.actor, ids.actor]);
    await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES ($1,$2,$3,true)", [ids.membership, ids.org, ids.actor]);
    await owner.query("INSERT INTO roles(id,organization_id,key,display_name) VALUES ($1,$2,'STORAGE_SETUP_TEST','Setup test')", [ids.role, ids.org]);
    await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,unnest(ARRAY['payables.read','payables.manage','receivables.read','receivables.manage','organization.settings.manage'])", [ids.org, ids.role]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES ($1,$2,$3,$4)", [ids.org, ids.membership, ids.role, ids.actor]);
    await owner.query(`INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at) VALUES ($1::uuid,$1::text,$2,$3,$4,'PASSWORD','REAL',repeat('a',64),7200,now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '2 hours')`, [ids.session, ids.actor, ids.org, ids.membership]);
    await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code,active) VALUES ($1,$2,'SETUP','Setup company','CA','ON',true),($3,$2,'OTHER','Other company','CA','ON',true)", [ids.entity, ids.org, ids.secondEntity]);
    const root = loadOrganizationRootKek(), dek = randomBytes(32);
    try { const wrapped = new LocalRootKeyProvider(root).wrapOrganizationKey(ids.org, 1, dek); await owner.query("INSERT INTO organization_key_versions(organization_id,version,key_provider,wrapped_dek,active) VALUES ($1,1,$2,$3,true)", [ids.org, wrapped.provider, serializeWrappedKey(wrapped)]); }
    finally { root.fill(0); dek.fill(0); }
    for (const [id, parentId] of [["purchases", "app-folder"], ["purchases/inbox", "purchases"], ["purchases/archive", "purchases"]]) cloud.folders.set(id, { id, parentId, name: id, driveId: "drive", folder: true, mimeType: "folder", size: 0, version: "v1" });
    await withTenantTransaction(context(), async (client) => {
      const row = { id: ids.donor, organization_id: ids.org, key_version: 1 };
      const location = { accountId: "drive", driveId: "drive", rootId: "purchases", inboxId: "purchases/inbox", archiveId: "purchases/archive", inboxUrl: "https://onedrive.live.com/?id=purchases-inbox", archiveUrl: "https://onedrive.live.com/?id=purchases-archive" };
      const config = await encryptStorageValue(client, row, "document_storage_connections", "config_ciphertext", location);
      const credentials = await encryptStorageValue(client, row, "document_storage_connections", "credentials_ciphertext", { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600000 });
      await client.query("INSERT INTO document_storage_connections(id,organization_id,legal_entity_id,owner_module,provider,label,config_ciphertext,credentials_ciphertext,key_version,active,created_by) VALUES ($1,$2,$3,'payables','ONEDRIVE','Purchases',$4,$5,1,true,$6)", [ids.donor, ids.org, ids.entity, config, credentials, ids.actor]);
    });
  });
  afterAll(async () => { vi.unstubAllEnvs(); await closeDatabasePool(); await owner.end(); });
  it("prepares once without sharing, records consent, reuses only the app folder and recovers identical retries", async () => {
    const command = input(), before = cloud.provisions;
    const prepared = await prepareStorageSetup(context(), command);
    expect(prepared).toMatchObject({ status: "USER_APPROVAL_REQUIRED", module: "receivables", providerScopes: ["offline_access", "Files.ReadWrite.AppFolder"], sharing: { approved: false } });
    expect(prepared.handoffUrl).toContain('/app/settings/documents/setup/' + prepared.connectionId);
    expect(cloud.provisions).toBe(before);
    expect((await prepareStorageSetup(context(), command)).connectionId).toBe(prepared.connectionId);
    await expect(prepareStorageSetup(context(), { ...command, module: "payables" })).rejects.toMatchObject({ code: "STORAGE_SETUP_CONFLICT" });
    await expect(prepareStorageSetup(context(), { ...command, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "STORAGE_CONNECTION_EXISTS" });
    await expect(startStorageConnection(principal, { connectionId: prepared.connectionId, provider: "ONEDRIVE", legalEntityId: ids.entity, module: "receivables", label: command.label, sharedWithOrganization: true, accessAcknowledged: true })).rejects.toThrow(/sharing approval/);
    const approval = { connectionId: prepared.connectionId, expectedSetupHash: prepared.expectedSetupHash!, sharedWithOrganization: true as const, accessAcknowledged: true as const };
    await expect(approveStorageSetup({ ...principal, mcpConnectionId: randomUUID() }, approval)).rejects.toMatchObject({ code: "STORAGE_USER_CONSENT_REQUIRED" });
    await expect(approveStorageSetup(principal, { ...approval, expectedSetupHash: 'a'.repeat(64) })).rejects.toMatchObject({ code: "STORAGE_SETUP_CHANGED" });
    const ready = await approveStorageSetup(principal, approval);
    expect(ready.status).toBe("READY"); readyConnectionId = ready.connectionId; expect(ready.inboxUrl).toContain('inbox');
    expect(ready.archiveUrl).toContain('archive'); expect(cloud.provisions).toBe(before + 1);
    expect((await approveStorageSetup(principal, approval)).connectionId).toBe(prepared.connectionId);
    expect(cloud.provisions).toBe(before + 1);
    expect((await getStorageSetup(context(), prepared.connectionId)).status).toBe("READY");
    expect(JSON.stringify(ready)).not.toContain('synthetic-access'); expect(JSON.stringify(ready)).not.toContain('synthetic-refresh');
    const stored = (await owner.query("SELECT sharing_consent_ciphertext FROM document_storage_connections WHERE id=$1", [prepared.connectionId])).rows[0];
    expect(stored.sharing_consent_ciphertext).not.toContain('approvedBy');
    await expect(withTenantTransaction({ ...context(), sourceSurface: "UI" }, client => client.query("UPDATE document_storage_connections SET sharing_consent_ciphertext=NULL WHERE id=$1", [prepared.connectionId]))).rejects.toThrow(/immutable/);
    const events = await owner.query("SELECT id FROM audit_events WHERE organization_id=$1 AND action='document-storage.sharing-approved'", [ids.org]);
    expect(events.rows.length).toBe(1);
  });
  it("retains an oversized PDF original, links verified provenance, and replays without duplicate cloud files", async () => {
    const original = pdf();
    const hash = createHash("sha256").update(original).digest("hex");
    const command = { connectionId: readyConnectionId, filename: "Synthetic Invoice.pdf", mimeType: "application/pdf" as const,
      byteSize: original.length, sha256: hash, contentBase64: original.toString("base64"), idempotencyKey: randomUUID() };
    const before = cloud.uploads;
    const first = await prepareAndUploadPdf(context(), command);
    expect(first.idempotentReplay).toBe(false);
    expect(first.item.pdfPreparation).toMatchObject({ originalSha256: hash, originalByteSize: original.length, verified: true, pageCount: 2 });
    expect(first.preparation.optimizedByteSize).toBeLessThan(2 * 1024 * 1024);
    expect(cloud.uploads).toBe(before + 2);
    const retained = cloud.bytes.get(first.preparation.originalProviderFileId);
    expect(retained?.equals(original)).toBe(true);
    const replay = await prepareAndUploadPdf(context(), command);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.item.id).toBe(first.item.id);
    expect(cloud.uploads).toBe(before + 2);
    const duplicate = await prepareAndUploadPdf(context(), { ...command, idempotencyKey: randomUUID() });
    expect(duplicate.idempotentReplay).toBe(true);
    expect(duplicate.item.id).toBe(first.item.id);
    expect(cloud.uploads).toBe(before + 2);
    const scanSizes = vi.mocked(scanEvidence).mock.calls.map(([bytes]) => bytes.length);
    expect(scanSizes.some((size) => size > 2 * 1024 * 1024)).toBe(true);
    expect(scanSizes.some((size) => size < 2 * 1024 * 1024)).toBe(true);
    vi.mocked(scanEvidence).mockRejectedValueOnce(new Error("Evidence rejected by malware scanning"));
    await expect(prepareAndUploadPdf(context(), command)).rejects.toMatchObject({ code: "STORAGE_PDF_MALWARE" });
    expect(cloud.uploads).toBe(before + 2);
    const rows = await owner.query("SELECT id FROM document_inbox_items WHERE organization_id=$1 AND connection_id=$2", [ids.org, readyConnectionId]);
    expect(rows.rows).toHaveLength(1);
    original.fill(0);
  }, 120_000);
  it("denies another company, tenant, actor, and missing module permissions", async () => {
    await expect(prepareStorageSetup(context(), { ...input(), legalEntityId: ids.secondEntity })).rejects.toMatchObject({ code: "STORAGE_GRANT_REUSE_DENIED" });
    await expect(prepareStorageSetup({ ...context(), organizationId: ids.other }, input())).rejects.toThrow();
    const prepared = await prepareStorageSetup(context(), input());
    await expect(getStorageSetup({ ...context(), actorId: ids.colleague }, prepared.connectionId)).rejects.toThrow();
    await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_key='receivables.manage'", [ids.org, ids.role]);
    try { await expect(prepareStorageSetup(context(), input())).rejects.toThrow(); await expect(getStorageSetup(context(), prepared.connectionId)).rejects.toThrow(); }
    finally { await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES ($1,$2,'receivables.manage')", [ids.org, ids.role]); }
  });
  it("returns a recoverable OAuth handoff for expired grants without broader scopes or duplicate connections", async () => {
    const prepared = await prepareStorageSetup(context(), input());
    cloud.expired = true;
    let handoff;
    try { handoff = await approveStorageSetup(principal, { connectionId: prepared.connectionId, expectedSetupHash: prepared.expectedSetupHash!, sharedWithOrganization: true, accessAcknowledged: true }); }
    finally { cloud.expired = false; }
    expect(handoff.status).toBe("CONNECTION_REQUIRED");
    expect('authorizationUrl' in handoff).toBe(true);
    if (!('authorizationUrl' in handoff) || typeof handoff.authorizationUrl !== 'string') throw new Error('OAuth handoff missing');
    const url = new URL(handoff.authorizationUrl);
    expect(url.searchParams.get('scope')).toBe('offline_access Files.ReadWrite.AppFolder');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    await finishStorageConnection(principal, 'ONEDRIVE', url.searchParams.get('state')!, 'synthetic-code');
    expect((await getStorageSetup(context(), prepared.connectionId)).status).toBe('READY');
  });
});
