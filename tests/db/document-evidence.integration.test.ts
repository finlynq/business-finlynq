import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { closeDatabasePool, withTenantTransaction } from "@/db/transaction";
import { LocalRootKeyProvider, serializeWrappedKey } from "@/security/organization-encryption";
import { loadOrganizationRootKek } from "@/security/root-secret";
import { uploadDocumentEvidence, attachDocumentEvidence, detachDocumentEvidence, downloadDocumentEvidence } from "@/modules/subledger/evidence-service";
import { getCurrentSubledgerDocument } from "@/modules/subledger/ar-ap-draft-commands";
import { appendSourceDocument } from "@/modules/subledger/ar-ap-persistence";
import { buildBusinessDocumentSnapshot } from "@/modules/subledger/document-model";

const scan = vi.hoisted(() => vi.fn(async () => ({ version: "ClamAV integration-test", scannedAt: new Date().toISOString() })));
vi.mock("@/security/evidence-scanner", () => ({ scanEvidence: scan }));
const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const ids = { org: randomUUID(), otherOrg: randomUUID(), actor: randomUUID(), entity: randomUUID(), role: randomUUID(), membership: randomUUID(), session: randomUUID() };
const context = { organizationId: ids.org, actorId: ids.actor, sessionId: ids.session, sessionMode: "real" as const,
  requestId: randomUUID(), authMethod: "password+mfa", sourceSurface: "MCP" as const, reason: "Evidence integration test" };
const originalWrites = process.env.BUSINESS_WRITES_ENABLED;
const bytes = Buffer.from("%PDF-1.4\nTest invoice\n%%EOF");
const command = { context, module: "payables" as const, filename: "supplier-invoice.pdf", mimeType: "application/pdf" as const,
  byteSize: bytes.length, contentBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"),
  idempotencyKey: randomUUID() };
const base = buildBusinessDocumentSnapshot({
  kind: "SUPPLIER_BILL", sourceNumber: "BILL-EVIDENCE", ledgerId: randomUUID(), legalEntityId: ids.entity,
  partyAccountId: randomUUID(), controlAccountCombinationId: randomUUID(), documentDate: "2026-09-03",
  accountingDate: "2026-09-03", periodId: randomUUID(), dueOn: "2026-09-30", currency: "USD",
  fx: { rate: "1", source: "FUNCTIONAL", effectiveAt: "2026-09-03T00:00:00Z", quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" },
  description: "Evidence integration fixture",
  lines: [{ description: "Evidence fixture", accountCombinationId: randomUUID(), netAmount: "158.20",
    tax: { packKey: "us.wa.sales-use", category: "OUT_OF_SCOPE", destinationCountry: "US", destinationRegion: "WA" } }],
}, "USD");

run("encrypted document evidence PostgreSQL lifecycle", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let assetId: string;
  let attachedId: string;
  let postedId: string;
  const attachKey = randomUUID();
  beforeAll(async () => {
    process.env.BUSINESS_WRITES_ENABLED = "true";
    await owner.query("INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES ($1,$2,'Evidence test',true,false,'REAL',now()),($3,$4,'Other evidence tenant',true,false,'REAL',now())",
      [ids.org, "evidence-" + ids.org, ids.otherOrg, "evidence-" + ids.otherOrg]);
    await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES ($1,$2,'encrypted','test',true)", [ids.actor, ids.actor]);
    await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES ($1,$2,$3,true)", [ids.membership, ids.org, ids.actor]);
    await owner.query("INSERT INTO roles(id,organization_id,key,display_name) VALUES ($1,$2,'EVIDENCE_TEST','Evidence test')", [ids.role, ids.org]);
    await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,unnest(ARRAY['payables.read','payables.manage','payables.post','payables.void'])", [ids.org, ids.role]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES ($1,$2,$3,$4)", [ids.org, ids.membership, ids.role, ids.actor]);
    await owner.query(`INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at)
      VALUES ($1::uuid,$1::text,$2,$3,$4,'PASSWORD','REAL',repeat('a',64),7200,now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '2 hours')`,
      [ids.session, ids.actor, ids.org, ids.membership]);
    await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code,active) VALUES ($1,$2,'EVIDENCE','Evidence test','US','WA',true)", [ids.entity, ids.org]);
    const root = loadOrganizationRootKek(); const dek = randomBytes(32);
    try {
      const wrapped = new LocalRootKeyProvider(root).wrapOrganizationKey(ids.org, 1, dek);
      await owner.query("INSERT INTO organization_key_versions(organization_id,version,key_provider,wrapped_dek,active) VALUES ($1,1,$2,$3,true)", [ids.org, wrapped.provider, serializeWrappedKey(wrapped)]);
    } finally { root.fill(0); dek.fill(0); }
    await withTenantTransaction(context, (client) => appendSourceDocument(client, {
      context, ownerModule: "payables", sourceType: "payables.supplier-bill", sourceNumber: base.sourceNumber,
      legalEntityId: ids.entity, version: 1, status: "DRAFT", snapshot: base,
      idempotencyKey: randomUUID(), commandHash: "a".repeat(64),
    }));
  });
  afterAll(async () => {
    if (originalWrites === undefined) delete process.env.BUSINESS_WRITES_ENABLED;
    else process.env.BUSINESS_WRITES_ENABLED = originalWrites;
    await closeDatabasePool(); await owner.end();
  });
  it("stores encrypted bytes and filename, and concurrent retries create only one asset", async () => {
    const results = await Promise.all([uploadDocumentEvidence(command), uploadDocumentEvidence(command)]);
    assetId = results[0].asset.assetId;
    expect(results[1].asset.assetId).toBe(assetId);
    expect(results.map((r) => r.idempotentReplay).sort()).toEqual([false, true]);
    const stored = (await owner.query("SELECT * FROM document_evidence_assets WHERE id=$1", [assetId])).rows[0];
    expect(stored.filename_ciphertext).not.toContain(command.filename);
    expect(stored.content_ciphertext).not.toContain(command.contentBase64);
    expect(stored.sha256).toBe(command.sha256);
    expect(stored.uploaded_by).toBe(ids.actor);
    await expect(uploadDocumentEvidence({ ...command, filename: "changed.pdf" })).rejects.toThrow(/idempotency/);
  });
  it("rejects denied uploads, invalid checksums, and malware before persistence", async () => {
    await expect(uploadDocumentEvidence({ ...command, context: { ...context, actorId: randomUUID() }, idempotencyKey: randomUUID() })).rejects.toThrow();
    await expect(uploadDocumentEvidence({ ...command, sha256: "0".repeat(64), idempotencyKey: randomUUID() })).rejects.toThrow(/checksum/);
    scan.mockRejectedValueOnce(new Error("Evidence rejected by malware scanning"));
    await expect(uploadDocumentEvidence({ ...command, idempotencyKey: randomUUID() })).rejects.toThrow(/malware/);
    expect((await owner.query("SELECT count(*)::int AS n FROM document_evidence_assets WHERE organization_id=$1", [ids.org])).rows[0].n).toBe(1);
  });
  it("attaches once with optimistic versioning and lists metadata without binary", async () => {
    const attach = { context, kind: "SUPPLIER_BILL" as const, sourceNumber: base.sourceNumber,
      expectedVersion: 1, assetId, purpose: "INVOICE" as const, idempotencyKey: attachKey, reason: "Retain invoice evidence" };
    const linked = await attachDocumentEvidence(attach);
    attachedId = linked.document.id;
    expect(linked.document.version).toBe(2);
    expect((await attachDocumentEvidence(attach)).idempotentReplay).toBe(true);
    await expect(attachDocumentEvidence({ ...attach, idempotencyKey: randomUUID() })).rejects.toThrow(/current DRAFT/);
    const document = await getCurrentSubledgerDocument({ context, ownerModule: "payables", sourceType: "payables.supplier-bill", sourceNumber: base.sourceNumber });
    expect(document?.attachments?.[0]).toMatchObject({ assetId, filename: command.filename, sourceVersion: 2, uploadedBy: ids.actor });
    expect(JSON.stringify(document)).not.toContain(command.contentBase64);
    const downloaded = await downloadDocumentEvidence({ context, assetId, sourceDocumentId: attachedId });
    expect(downloaded.bytes).toEqual(bytes);
  });
  it("denies cross-tenant assets, unrelated source versions, and direct mutations", async () => {
    await expect(downloadDocumentEvidence({ context: { ...context, organizationId: ids.otherOrg }, assetId, sourceDocumentId: attachedId })).rejects.toThrow();
    await expect(downloadDocumentEvidence({ context, assetId, sourceDocumentId: randomUUID() })).rejects.toThrow();
    await expect(attachDocumentEvidence({ context, kind: "SUPPLIER_BILL", sourceNumber: base.sourceNumber,
      expectedVersion: 2, assetId: randomUUID(), purpose: "INVOICE", idempotencyKey: randomUUID(), reason: "Reject foreign asset" })).rejects.toThrow(/unavailable/);
    await expect(withTenantTransaction(context, (client) => client.query("UPDATE document_evidence_assets SET sha256=repeat('0',64) WHERE id=$1", [assetId]))).rejects.toThrow();
    await expect(withTenantTransaction(context, (client) => client.query("DELETE FROM document_evidence_assets WHERE id=$1", [assetId]))).rejects.toThrow();
  });
  it("detaches only in a new draft version and preserves historical downloads", async () => {
    const detach = { context, kind: "SUPPLIER_BILL" as const, sourceNumber: base.sourceNumber,
      expectedVersion: 2, assetId, idempotencyKey: randomUUID(), reason: "Correct draft evidence link" };
    const result = await detachDocumentEvidence(detach);
    expect(result.document.version).toBe(3);
    expect((await detachDocumentEvidence(detach)).idempotentReplay).toBe(true);
    await expect(downloadDocumentEvidence({ context, assetId, sourceDocumentId: result.document.id })).rejects.toThrow();
    expect((await downloadDocumentEvidence({ context, assetId, sourceDocumentId: attachedId })).bytes).toEqual(bytes);
    const reattached = await attachDocumentEvidence({ context, kind: "SUPPLIER_BILL", sourceNumber: base.sourceNumber,
      expectedVersion: 3, assetId, purpose: "INVOICE", idempotencyKey: randomUUID(), reason: "Restore correct invoice evidence" });
    const posted = await withTenantTransaction(context, (client) => appendSourceDocument(client, {
      context, ownerModule: "payables", sourceType: "payables.supplier-bill", sourceNumber: base.sourceNumber,
      legalEntityId: ids.entity, version: 5, status: "POSTED", snapshot: reattached.document.snapshot,
      idempotencyKey: randomUUID(), commandHash: "b".repeat(64), supersedesSourceDocumentId: reattached.document.id,
    }));
    postedId = posted.id;
  });
  it("enforces posted/voided lineage at both the service and SQL boundary", async () => {
    await expect(detachDocumentEvidence({ context, kind: "SUPPLIER_BILL", sourceNumber: base.sourceNumber,
      expectedVersion: 5, assetId, idempotencyKey: randomUUID(), reason: "Invalid posted detach" })).rejects.toThrow(/current DRAFT/);
    const append = { context, ownerModule: "payables" as const, sourceType: "payables.supplier-bill",
      sourceNumber: base.sourceNumber, legalEntityId: ids.entity, version: 6, status: "VOIDED" as const,
      snapshot: base, idempotencyKey: randomUUID(), commandHash: "c".repeat(64), supersedesSourceDocumentId: postedId, voidReason: "Test evidence preservation" };
    await expect(withTenantTransaction(context, (client) => appendSourceDocument(client, append))).rejects.toThrow(/lineage/);
    const voided = await withTenantTransaction(context, (client) => appendSourceDocument(client, {
      ...append, snapshot: { ...base, evidence: [{ assetId, purpose: "INVOICE" }] },
    }));
    expect((await downloadDocumentEvidence({ context, assetId, sourceDocumentId: voided.id })).bytes).toEqual(bytes);
    await owner.query("UPDATE organization_memberships SET active=false WHERE id=$1", [ids.membership]);
    await expect(downloadDocumentEvidence({ context, assetId, sourceDocumentId: voided.id })).rejects.toThrow();
    await expect(uploadDocumentEvidence(command)).rejects.toThrow();
  });
});
