import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabasePool, withTenantTransaction } from "@/db/transaction";
import { LocalRootKeyProvider, serializeWrappedKey } from "@/security/organization-encryption";
import { loadOrganizationRootKek } from "@/security/root-secret";
import { encryptStorageValue } from "@/modules/document-storage/store";
import { claimInboxDocument, completeInboxDocument, listDocumentInbox, readInboxDocument, retryDocumentFiling, reviewInboxDocument, syncDocumentInbox } from "@/modules/document-storage/inbox";
import { downloadDocumentEvidence } from "@/modules/subledger/evidence-service";
import { uploadInboxDocument } from "@/modules/document-storage/upload";
import { disconnectStorage, finishStorageConnection, listStorageConnections, startStorageConnection } from "@/modules/document-storage/connections";
import type { SessionPrincipal } from "@/modules/identity/session";
import { exchangeStorageToken, StorageError, type CloudFile } from "@/modules/document-storage/provider";

const cloud = vi.hoisted(() => ({ files: new Map<string, CloudFile>(), bytes: new Map<string, Buffer>(), moveFailsOnce: false, moves: 0,
  scanFails: false, provisionCalls: 0, uploadFailsOnce: false, uploads: 0, movedDuringDownload: "", injectedChild: "" }));
vi.mock("@/security/evidence-scanner", () => ({ scanEvidence: vi.fn(async () => {
  if (cloud.scanFails) throw new Error("Evidence rejected by malware scanning");
  return { version: "ClamAV inbox-test", scannedAt: new Date().toISOString() };
}) }));
vi.mock("@/modules/document-storage/provider", async (original) => {
  const actual = await original<typeof import("@/modules/document-storage/provider")>();
  return { ...actual, exchangeStorageToken: vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600000 })),
    CloudDrive: class {
      async file(id: string) { const file = cloud.files.get(id); if (!file) throw new actual.StorageError("STORAGE_MISSING", "Cloud file missing"); return { ...file }; }
      async children(folder: string) { return { files: [...cloud.files.values()].filter((file) => file.parentId === folder || file.id === cloud.injectedChild).map((file) => ({ ...file })), cursor: null }; }
      async download(id: string) {
        if (cloud.movedDuringDownload === id) cloud.files.set(id, { ...cloud.files.get(id)!, parentId: "outside" });
        return Buffer.from(cloud.bytes.get(id)!);
      }
      async findUpload(folder: string, stem: string) { return [...cloud.files.values()].find((file) => file.parentId === folder && file.name.startsWith(stem + ".")) ?? null; }
      async upload(folder: string, name: string, mimeType: string, bytes: Buffer) {
        cloud.uploads += 1; const id = randomUUID(); const file = { id, name, mimeType, size: bytes.length, version: "v1", parentId: folder, folder: false };
        cloud.files.set(id, file); cloud.bytes.set(id, Buffer.from(bytes));
        if (cloud.uploadFailsOnce) { cloud.uploadFailsOnce = false; throw new Error("Simulated lost upload response"); }
        return file;
      }
      async folder(parent: string, name: string) {
        const id = `${parent}/${name}`;
        if (!cloud.files.has(id)) cloud.files.set(id, { id, name, parentId: parent, folder: true, mimeType: "folder", size: 0, version: "v1" });
        return id;
      }
      async move(file: CloudFile, folder: string, name: string) {
        cloud.moves += 1; const result = { ...file, parentId: folder, name, version: file.version + "-moved" }; cloud.files.set(file.id, result);
        if (cloud.moveFailsOnce) { cloud.moveFailsOnce = false; throw new Error("Simulated lost provider response"); }
        return result;
      }
      async provision(_name: string, existing: unknown) { cloud.provisionCalls += 1; return existing; }
    } };
});
// Existing accounting suites exercise configuration validation. Here the real
// transaction, source lineage, encryption, RLS, and archive recovery are tested.
vi.mock("@/modules/subledger/ar-ap-accounting", async (original) => ({
  ...await original<typeof import("@/modules/subledger/ar-ap-accounting")>(),
  loadAccountingSetup: vi.fn(async () => ({ functional_currency: "USD" })), validateDraftConfiguration: vi.fn(async () => undefined),
}));

const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const ids = { org: randomUUID(), other: randomUUID(), actor: randomUUID(), entity: randomUUID(), role: randomUUID(), membership: randomUUID(), session: randomUUID(), secondSession: randomUUID(), connection: randomUUID() };
const context = { organizationId: ids.org, actorId: ids.actor, sessionId: ids.session, sessionMode: "real" as const, requestId: randomUUID(), authMethod: "password+mfa", sourceSurface: "MCP" as const, reason: "Cloud inbox test" };
function requestContext() { return { ...context, requestId: randomUUID() }; }
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=", "base64");
const checksum = createHash("sha256").update(png).digest("hex");
const draftInput = { kind: "SUPPLIER_BILL" as const, sourceNumber: "INBOX-BILL", ledgerId: randomUUID(), legalEntityId: ids.entity,
  partyAccountId: randomUUID(), controlAccountCombinationId: randomUUID(), documentDate: "2026-09-04", accountingDate: "2026-09-04", periodId: randomUUID(), dueOn: "2026-09-30", currency: "USD",
  fx: { rate: "1", source: "FUNCTIONAL" as const, effectiveAt: "2026-09-04T00:00:00Z", quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const }, description: "Cloud invoice",
  lines: [{ description: "Consulting", accountCombinationId: randomUUID(), netAmount: "158.20", tax: { packKey: "us.wa.sales-use", category: "OUT_OF_SCOPE" as const, destinationCountry: "US", destinationRegion: "WA" } }] };
function addFile(name: string, suffix = "") {
  const id = randomUUID(); const bytes = Buffer.concat([png, Buffer.from(suffix)]);
  cloud.files.set(id, { id, name, parentId: "inbox", folder: false, mimeType: "image/png", size: bytes.length, version: "v1" }); cloud.bytes.set(id, bytes);
  return id;
}
const principal: SessionPrincipal = { sessionId: ids.session, userId: ids.actor, organizationId: ids.org, membershipId: ids.membership,
  organizationName: "Inbox test", roleLabel: "Owner", displayName: "Tester", initials: "T", sessionMode: "real", authMethod: "PASSWORD",
  expiresAt: new Date(Date.now() + 3600000), mfaVerifiedAt: new Date(), stepUpExpiresAt: new Date(Date.now() + 3600000), organizationWritesEnabled: true };

run("cloud inbox PostgreSQL lifecycle", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let itemId: string; const claimId = randomUUID(); let complete: Parameters<typeof completeInboxDocument>[1];
  beforeAll(async () => {
    for (const [id, parentId] of [["root", "drive-root"], ["inbox", "root"], ["archive", "root"]]) cloud.files.set(id, { id, parentId, name: id, folder: true, mimeType: "folder", size: 0, version: "v1" });
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    vi.stubEnv("DOCUMENT_GOOGLE_CLIENT_ID", "test-client"); vi.stubEnv("DOCUMENT_GOOGLE_CLIENT_SECRET", "test-secret"); vi.stubEnv("DOCUMENT_GOOGLE_CLIENT_SECRET_FILE", ""); vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    await owner.query("INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES ($1,$2,'Inbox test',true,false,'REAL',now()),($3,$4,'Other inbox tenant',true,false,'REAL',now())", [ids.org, `inbox-${ids.org}`, ids.other, `inbox-${ids.other}`]);
    await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES ($1,$2,'encrypted','test',true)", [ids.actor, ids.actor]);
    await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES ($1,$2,$3,true)", [ids.membership, ids.org, ids.actor]);
    await owner.query("INSERT INTO roles(id,organization_id,key,display_name) VALUES ($1,$2,'INBOX_TEST','Inbox test')", [ids.role, ids.org]);
    await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,unnest(ARRAY['payables.read','payables.manage','organization.settings.manage'])", [ids.org, ids.role]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES ($1,$2,$3,$4)", [ids.org, ids.membership, ids.role, ids.actor]);
    for (const session of [ids.session, ids.secondSession]) await owner.query(`INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at)
      VALUES ($1::uuid,$1::text,$2,$3,$4,'PASSWORD','REAL',repeat('a',64),7200,now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '2 hours')`, [session, ids.actor, ids.org, ids.membership]);
    await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code,active) VALUES ($1,$2,'INBOX','Inbox company','US','WA',true)", [ids.entity, ids.org]);
    const root = loadOrganizationRootKek(); const dek = randomBytes(32);
    try { const wrapped = new LocalRootKeyProvider(root).wrapOrganizationKey(ids.org, 1, dek); await owner.query("INSERT INTO organization_key_versions(organization_id,version,key_provider,wrapped_dek,active) VALUES ($1,1,$2,$3,true)", [ids.org, wrapped.provider, serializeWrappedKey(wrapped)]); }
    finally { root.fill(0); dek.fill(0); }
    await withTenantTransaction(requestContext(), async (client) => {
      const row = { id: ids.connection, organization_id: ids.org, key_version: 1 };
      const config = await encryptStorageValue(client, row, "document_storage_connections", "config_ciphertext", { accountId: "account", driveId: "drive", rootId: "root", inboxId: "inbox", archiveId: "archive", inboxUrl: "https://drive.google.com/drive/folders/inbox", archiveUrl: "https://drive.google.com/drive/folders/archive" });
      const credentials = await encryptStorageValue(client, row, "document_storage_connections", "credentials_ciphertext", { accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3600000 });
      await client.query(`INSERT INTO document_storage_connections(id,organization_id,legal_entity_id,owner_module,provider,label,config_ciphertext,credentials_ciphertext,key_version,active,created_by)
        VALUES ($1,$2,$3,'payables','GOOGLE_DRIVE','Company purchases',$4,$5,1,true,$6)`, [ids.connection, ids.org, ids.entity, config, credentials, ids.actor]);
    });
  });
  afterAll(async () => { vi.unstubAllEnvs(); await closeDatabasePool(); await owner.end(); });
  async function discover(name: string, suffix = "") {
    addFile(name, suffix); const synced = await syncDocumentInbox(requestContext(), { connectionId: ids.connection });
    return synced.items.find((item) => item.filename === name)!;
  }
  it("discovers metadata without storing bytes and denies cross-tenant access", async () => {
    const item = await discover("invoice.png"); itemId = item.id;
    expect(item.status).toBe("PENDING");
    expect((await listDocumentInbox({ ...context, organizationId: ids.other })).items).toEqual([]);
    await expect(claimInboxDocument({ ...context, organizationId: ids.other }, { itemId, claimId })).rejects.toThrow();
    const stored = (await owner.query("SELECT metadata_ciphertext FROM document_inbox_items WHERE id=$1", [itemId])).rows[0];
    expect(stored.metadata_ciphertext).not.toContain("invoice.png"); expect(stored.metadata_ciphertext).not.toContain(png.toString("base64"));
  });
  it("leases prevent competing clients and support renewal", async () => {
    await claimInboxDocument(requestContext(), { itemId, claimId });
    await expect(claimInboxDocument({ ...context, sessionId: ids.secondSession }, { itemId, claimId })).rejects.toThrow(/Claim/);
    const renewed = await claimInboxDocument(requestContext(), { itemId, claimId }); expect(renewed.claimId).toBe(claimId);
    const read = await readInboxDocument(requestContext(), { itemId, claimId }); expect(read.imageBase64).toBe(png.toString("base64")); expect(read.sha256).toBe(checksum);
  });
  it("rolls back both draft and evidence when extracted totals do not match", async () => {
    complete = { itemId, claimId, sha256: checksum, metadata: { documentType: "PURCHASE_INVOICE", documentDate: "2026-09-04", counterparty: "Acme", reference: "INV-42", currency: "USD", total: "999.00" }, action: { type: "CREATE_DRAFT", draft: draftInput }, reason: "Process verified invoice" };
    await expect(completeInboxDocument(requestContext(), complete)).rejects.toThrow(/calculated total/);
    expect((await owner.query("SELECT count(*)::int AS n FROM source_documents WHERE organization_id=$1", [ids.org])).rows[0].n).toBe(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM document_evidence_assets WHERE organization_id=$1", [ids.org])).rows[0].n).toBe(0);
  });
  it("commits one draft and cloud reference even when the provider loses the move response", async () => {
    complete = { ...complete, metadata: { ...complete.metadata, total: "158.20" } };
    cloud.moveFailsOnce = true;
    const saved = await completeInboxDocument(requestContext(), complete); expect(saved.filingPending).toBe(true);
    const stored = (await owner.query("SELECT * FROM document_evidence_assets WHERE organization_id=$1", [ids.org])).rows[0];
    expect(stored.storage_backend).toBe("CLOUD"); expect(stored.content_ciphertext).toBeNull();
    expect((await owner.query("SELECT status FROM source_documents WHERE organization_id=$1", [ids.org])).rows).toEqual([{ status: "DRAFT" }]);
    const recovered = await retryDocumentFiling(requestContext(), { itemId }); expect(recovered.item.status).toBe("FILED"); expect(cloud.moves).toBe(1);
    expect(recovered.item.canonicalName).toContain("INV-42__USD-158.20");
    const replay = await completeInboxDocument(requestContext(), complete); expect(replay.idempotentReplay).toBe(true);
    expect((await owner.query("SELECT count(*)::int AS n FROM document_evidence_assets WHERE organization_id=$1", [ids.org])).rows[0].n).toBe(1);
    const download = await downloadDocumentEvidence({ context: requestContext(), assetId: recovered.item.assetId!, sourceDocumentId: recovered.item.sourceDocumentId! }); expect(download.bytes).toEqual(png);
    await expect(completeInboxDocument(requestContext(), { ...complete, reason: "Changed completion arguments" })).rejects.toThrow(/different arguments/);
  });
  it("flags rescans of the same invoice even when their file checksums differ", async () => {
    const duplicate = await discover("rescan.png", "rescan"); const claim = randomUUID(); await claimInboxDocument(requestContext(), { itemId: duplicate.id, claimId: claim });
    const read = await readInboxDocument(requestContext(), { itemId: duplicate.id, claimId: claim });
    await expect(completeInboxDocument(requestContext(), { ...complete, itemId: duplicate.id, claimId: claim, sha256: read.sha256, action: { type: "CREATE_DRAFT", draft: { ...draftInput, sourceNumber: "OTHER-NUMBER" } } })).rejects.toThrow(/already be recorded/);
    await reviewInboxDocument(requestContext(), { itemId: duplicate.id, claimId: claim, reason: "Possible duplicate invoice needs review" });
    expect((await listDocumentInbox(requestContext(), { status: "NEEDS_REVIEW" })).items.some((item) => item.id === duplicate.id)).toBe(true);
  });
  it("links supporting evidence to the exact current draft and retains historical downloads", async () => {
    const row = await discover("receipt.png", "receipt"); const claim = randomUUID(); await claimInboxDocument(requestContext(), { itemId: row.id, claimId: claim });
    const read = await readInboxDocument(requestContext(), { itemId: row.id, claimId: claim });
    const saved = await completeInboxDocument(requestContext(), { itemId: row.id, claimId: claim, sha256: read.sha256, metadata: { documentType: "RECEIPT", documentDate: "2026-09-04", counterparty: "Acme" },
      action: { type: "LINK_DRAFT", kind: "SUPPLIER_BILL", sourceNumber: draftInput.sourceNumber, expectedVersion: 1, purpose: "RECEIPT" }, reason: "Retain supporting receipt" });
    expect(saved.item.status).toBe("FILED");
    expect((await owner.query("SELECT max(version)::int AS n FROM source_documents WHERE organization_id=$1", [ids.org])).rows[0].n).toBe(2);
    expect((await downloadDocumentEvidence({ context: requestContext(), assetId: saved.item.assetId!, sourceDocumentId: saved.item.sourceDocumentId! })).bytes).toEqual(Buffer.concat([png, Buffer.from("receipt")]));
  });
  it("blocks changed source content, malware, and expired claims", async () => {
    const item = await discover("changing.png"); const claim = randomUUID(); await claimInboxDocument(requestContext(), { itemId: item.id, claimId: claim });
    const providerId = (await owner.query("SELECT provider_file_id FROM document_inbox_items WHERE id=$1", [item.id])).rows[0].provider_file_id;
    cloud.files.set(providerId, { ...cloud.files.get(providerId)!, version: "v2" });
    await expect(readInboxDocument(requestContext(), { itemId: item.id, claimId: claim })).rejects.toThrow(/changed/);
    await syncDocumentInbox(requestContext(), { connectionId: ids.connection }); await claimInboxDocument(requestContext(), { itemId: item.id, claimId: claim });
    cloud.scanFails = true; await expect(readInboxDocument(requestContext(), { itemId: item.id, claimId: claim })).rejects.toThrow(/malware/); cloud.scanFails = false;
    await withTenantTransaction(requestContext(), (client) => client.query("UPDATE document_inbox_items SET lease_until=now()-interval '1 minute' WHERE id=$1", [item.id]));
    await expect(readInboxDocument(requestContext(), { itemId: item.id, claimId: claim })).rejects.toThrow(/Claim/);
    await expect(withTenantTransaction(requestContext(), (client) => client.query("DELETE FROM document_inbox_items WHERE id=$1", [item.id]))).rejects.toThrow();
  });
  it("recovers an uploaded original after a lost response without another upload or persisted bytes", async () => {
    const command = { connectionId: ids.connection, filename: "upload.png", mimeType: "image/png" as const, byteSize: png.length, sha256: checksum, contentBase64: png.toString("base64"), idempotencyKey: randomUUID() };
    cloud.uploadFailsOnce = true;
    await expect(uploadInboxDocument(requestContext(), command)).rejects.toThrow(/lost upload/);
    const saved = await uploadInboxDocument(requestContext(), command);
    expect(saved.item.filename).toBe("upload.png"); expect(saved.item.status).toBe("PENDING");
    expect((await uploadInboxDocument(requestContext(), command)).idempotentReplay).toBe(true);
    expect(cloud.uploads).toBe(1);
    await expect(uploadInboxDocument(requestContext(), { ...command, filename: "different.png" })).rejects.toThrow(/different file/);
    const record = (await owner.query("SELECT metadata_ciphertext,upload_hash FROM document_inbox_items WHERE id=$1", [saved.item.id])).rows[0];
    expect(record.metadata_ciphertext).not.toContain(command.contentBase64); expect(record.upload_hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects new broad Google grants while retaining legacy connection metadata", async () => {
    const command = { provider: "GOOGLE_DRIVE" as const, legalEntityId: ids.entity, module: "payables" as const, label: "Another inbox", sharedWithOrganization: true as const, accessAcknowledged: true as const };
    const before = (await owner.query("SELECT count(*)::int AS n FROM document_storage_connections WHERE organization_id=$1", [ids.org])).rows[0].n;
    await expect(startStorageConnection(principal, command)).rejects.toMatchObject({ code: "STORAGE_AUTHORIZATION_UNSUPPORTED" });
    expect((await owner.query("SELECT count(*)::int AS n FROM document_storage_connections WHERE organization_id=$1", [ids.org])).rows[0].n).toBe(before);
    expect((await listStorageConnections(requestContext()))[0].access.mode).toBe("GOOGLE_LEGACY_DRIVE");
  });
  it("rejects unexpected children before recording metadata and discovers later external drops", async () => {
    const outside = addFile("outside.png"); cloud.files.set(outside, { ...cloud.files.get(outside)!, parentId: "outside" });
    cloud.injectedChild = outside;
    try { await expect(syncDocumentInbox(requestContext(), { connectionId: ids.connection })).rejects.toThrow(/outside/); }
    finally { cloud.injectedChild = ""; }
    expect((await owner.query("SELECT id FROM document_inbox_items WHERE provider_file_id=$1", [outside])).rows).toEqual([]);
    const late = await discover("added-directly-in-drive.png"); expect(late.status).toBe("PENDING");
  });
  it("rejects a source moved during reading even if its contents and version stay the same", async () => {
    const item = await discover("moved-during-read.png"); const claim = randomUUID();
    await claimInboxDocument(requestContext(), { itemId: item.id, claimId: claim });
    const id = (await owner.query("SELECT provider_file_id FROM document_inbox_items WHERE id=$1", [item.id])).rows[0].provider_file_id;
    cloud.movedDuringDownload = id;
    try { await expect(readInboxDocument(requestContext(), { itemId: item.id, claimId: claim })).rejects.toThrow(/moved/); }
    finally { cloud.movedDuringDownload = ""; }
  });
  it("preserves old attachment access while denying moved originals and other organizations", async () => {
    const row = (await owner.query("SELECT asset_id,source_document_id,provider_file_id FROM document_inbox_items WHERE id=$1", [itemId])).rows[0];
    const input = { context: requestContext(), assetId: row.asset_id, sourceDocumentId: row.source_document_id };
    const file = cloud.files.get(row.provider_file_id)!; const inbox = cloud.files.get("inbox")!;
    cloud.files.delete("inbox");
    try { expect((await downloadDocumentEvidence(input)).bytes).toEqual(png); }
    finally { cloud.files.set("inbox", inbox); }
    cloud.files.set(row.provider_file_id, { ...file, parentId: "outside" });
    try { await expect(downloadDocumentEvidence(input)).rejects.toThrow(); }
    finally { cloud.files.set(row.provider_file_id, file); }
    const other = { ...requestContext(), organizationId: ids.other };
    expect(await listStorageConnections(other)).toEqual([]);
    await expect(syncDocumentInbox(other, { connectionId: ids.connection })).rejects.toThrow();
    await expect(downloadDocumentEvidence({ ...input, context: other })).rejects.toThrow();
    await expect(disconnectStorage(other, ids.connection)).rejects.toThrow();
    await expect(startStorageConnection({ ...principal, organizationId: ids.other }, { provider: "GOOGLE_DRIVE", legalEntityId: ids.entity, module: "payables", label: "Purchases", connectionId: ids.connection, sharedWithOrganization: true, accessAcknowledged: true })).rejects.toThrow();
  });
  it("rejects moved inboxes and missing archives without creating replacement locations", async () => {
    const inbox = cloud.files.get("inbox")!; cloud.files.set("inbox", { ...inbox, parentId: "outside" });
    try { await expect(syncDocumentInbox(requestContext(), { connectionId: ids.connection })).rejects.toThrow(/outside/); }
    finally { cloud.files.set("inbox", inbox); }
    const row = (await owner.query("SELECT asset_id,source_document_id FROM document_inbox_items WHERE id=$1", [itemId])).rows[0];
    const archive = cloud.files.get("archive")!; cloud.files.delete("archive");
    try { await expect(downloadDocumentEvidence({ context: requestContext(), assetId: row.asset_id, sourceDocumentId: row.source_document_id })).rejects.toThrow(/missing/i); }
    finally { cloud.files.set("archive", archive); }
  });
  it("renews expired credentials and surfaces revocation without changing folder identity", async () => {
    async function expire() {
      await withTenantTransaction(requestContext(), async (client) => {
        const value = await encryptStorageValue(client, { id: ids.connection, organization_id: ids.org, key_version: 1 }, "document_storage_connections", "credentials_ciphertext", { accessToken: "expired-test", refreshToken: "test-refresh", expiresAt: 0 });
        await client.query("UPDATE document_storage_connections SET credentials_ciphertext=$2 WHERE id=$1", [ids.connection, value]);
      });
    }
    await expire(); await syncDocumentInbox(requestContext(), { connectionId: ids.connection });
    expect(exchangeStorageToken).toHaveBeenCalledWith("GOOGLE_DRIVE", { refreshToken: "test-refresh" });
    await expire(); vi.mocked(exchangeStorageToken).mockRejectedValueOnce(new StorageError("STORAGE_RECONNECT", "Authorization revoked; reconnect the original account"));
    await expect(syncDocumentInbox(requestContext(), { connectionId: ids.connection })).rejects.toMatchObject({ code: "STORAGE_RECONNECT" });
    expect((await listStorageConnections(requestContext()))[0].inboxUrl).toContain("/inbox");
    await syncDocumentInbox(requestContext(), { connectionId: ids.connection });
  });
  it("completes a valid browser handoff for the original cloud account", async () => {
    await withTenantTransaction(requestContext(), (client) => client.query("UPDATE document_storage_connections SET sync_cursor='old-cursor' WHERE id=$1", [ids.connection]));
    const started = await startStorageConnection(principal, { provider: "GOOGLE_DRIVE", legalEntityId: ids.entity, module: "payables", label: "Purchases", connectionId: ids.connection, sharedWithOrganization: true, accessAcknowledged: true });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    expect((await finishStorageConnection(principal, "GOOGLE_DRIVE", state, "code")).connectionId).toBe(ids.connection);
    expect((await owner.query("SELECT sync_cursor FROM document_storage_connections WHERE id=$1", [ids.connection])).rows[0].sync_cursor).toBeNull();
    await expect(finishStorageConnection(principal, "GOOGLE_DRIVE", state, "code")).rejects.toThrow(/expired/);
    expect(cloud.provisionCalls).toBe(1); cloud.provisionCalls = 0;
  });
  it("binds OAuth state to the session and invalidates it on disconnect", async () => {
    const started = await startStorageConnection(principal, { provider: "GOOGLE_DRIVE", legalEntityId: ids.entity, module: "payables", label: "Purchases", connectionId: ids.connection, sharedWithOrganization: true, accessAcknowledged: true });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(finishStorageConnection({ ...principal, sessionId: ids.secondSession }, "GOOGLE_DRIVE", state, "code")).rejects.toThrow(/expired/);
    await disconnectStorage(requestContext(), ids.connection);
    await expect(finishStorageConnection(principal, "GOOGLE_DRIVE", state, "code")).rejects.toThrow(/expired|revoked/);
    expect(cloud.provisionCalls).toBe(0);
    await expect(syncDocumentInbox(requestContext(), { connectionId: ids.connection })).rejects.toThrow(/unavailable/);
  });
  it("rejects an in-flight new Google handoff from the previous authorization policy", async () => {
    const connectionId = randomUUID(); const state = randomBytes(32).toString("base64url");
    const stateHash = createHash("sha256").update(state).digest("hex");
    await withTenantTransaction(requestContext(), async (client) => {
      await client.query(`INSERT INTO document_storage_connections(id,organization_id,legal_entity_id,owner_module,provider,label,key_version,created_by,oauth_state_hash)
        VALUES ($1,$2,$3,'payables','GOOGLE_DRIVE','Pending old handoff',1,$4,$5)`, [connectionId, ids.org, ids.entity, ids.actor, stateHash]);
      const oauth = { id: randomUUID(), organization_id: ids.org, key_version: 1 };
      const verifier = await encryptStorageValue(client, oauth, "document_storage_oauth", "verifier_ciphertext", "test-verifier");
      await client.query(`INSERT INTO document_storage_oauth(id,organization_id,connection_id,actor_id,session_id,state_hash,verifier_ciphertext,key_version,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,1,now()+interval '10 minutes')`, [oauth.id, ids.org, connectionId, ids.actor, ids.session, stateHash, verifier]);
    });
    vi.mocked(exchangeStorageToken).mockClear();
    await expect(finishStorageConnection(principal, "GOOGLE_DRIVE", state, "test-code")).rejects.toMatchObject({ code: "STORAGE_AUTHORIZATION_UNSUPPORTED" });
    expect(exchangeStorageToken).not.toHaveBeenCalled();
    expect(cloud.provisionCalls).toBe(0);
    expect((await owner.query("SELECT config_ciphertext,credentials_ciphertext,active FROM document_storage_connections WHERE id=$1", [connectionId])).rows[0]).toEqual({ config_ciphertext: null, credentials_ciphertext: null, active: false });
  });
});
