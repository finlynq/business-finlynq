import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabasePool, withTenantTransaction } from "@/db/transaction";
import { LocalRootKeyProvider, serializeWrappedKey } from "@/security/organization-encryption";
import { loadOrganizationRootKek } from "@/security/root-secret";
import { encryptStorageValue, realStorageContext } from "@/modules/document-storage/store";
import { configurePersonalEmailAlias, provisionPersonalEmailAlias } from "@/modules/email/configuration";
import { loadInboundMessageForRetry, retryInboundMessage } from "@/modules/email/inbound";
import { loadEmailOperations, retryEmailOperation } from "@/modules/email/operations";
import { runInboundRetryBatch } from "@/modules/email/retry-worker";
import { POST } from "@/app/api/email/inbound/self-smtp/route";
import type { CloudFile } from "@/modules/document-storage/provider";

const cloud = vi.hoisted(() => ({ files: new Map<string, CloudFile>(), bytes: new Map<string, Buffer>(),
  uploads: 0, outage: false, lostResponse: false, scanReject: false, delay: 0 }));
vi.mock("@/observability/request-observability", () => ({ observeRouteHandler: (_: string, handler: unknown) => handler }));
vi.mock("@/security/evidence-scanner", () => ({ scanEvidence: vi.fn(async () => {
  if (cloud.scanReject) throw new Error("Evidence rejected by malware scanning");
  return { version: "ClamAV synthetic", scannedAt: new Date().toISOString() };
}) }));
vi.mock("@/modules/document-storage/provider", async (original) => {
  const actual = await original<typeof import("@/modules/document-storage/provider")>();
  return { ...actual, CloudDrive: class {
    async file(id: string) {
      if (cloud.outage) throw new actual.StorageError("STORAGE_PROVIDER_FAILED", "private signed URL and message");
      const file = cloud.files.get(id);
      if (!file) throw new actual.StorageError("STORAGE_MISSING", "Synthetic missing file");
      return { ...file };
    }
    async findUpload(folder: string, stem: string) {
      return [...cloud.files.values()].find((file) => file.parentId === folder && file.name.startsWith(stem + ".")) ?? null;
    }
    async upload(parentId: string, name: string, mimeType: string, bytes: Buffer) {
      if (cloud.delay) await new Promise(resolve => setTimeout(resolve, cloud.delay));
      cloud.uploads += 1;
      const id = randomUUID();
      const file = { id, parentId, name, mimeType, size: bytes.length, version: "v1", folder: false };
      cloud.files.set(id, file); cloud.bytes.set(id, Buffer.from(bytes));
      if (cloud.lostResponse) { cloud.lostResponse = false; throw new Error("Synthetic lost provider response"); }
      return file;
    }
    async download(id: string) { return Buffer.from(cloud.bytes.get(id)!); }
  } };
});

const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const ids = Object.fromEntries(["org", "otherOrg", "actor", "membership", "session", "role", "entity", "connection"].map(k => [k, randomUUID()]));
const context = () => ({ organizationId: ids.org, actorId: ids.actor, sessionId: ids.session,
  sessionMode: "real" as const, requestId: randomUUID(), authMethod: "password+mfa", sourceSurface: "MCP" as const,
  reason: "Synthetic inbound reliability verification" });
const secret = "synthetic-self-smtp-retry-fixture-secret";
function onePagePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "BT /F1 16 Tf 25 240 Td (Archived receipt CAD 13.80) Tj ET",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    const content = index === 3
      ? `<< /Length ${Buffer.byteLength(object)} >>\nstream\n${object}\nendstream`
      : object;
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const start = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(body);
}

run("signed inbound email and durable retries with tenant-restricted storage", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let address: string;
  let aliasId: string;
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", process.env.TEST_APP_DATABASE_URL!);
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN", "mail.finlynq.com");
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX", "businessdev-");
    vi.stubEnv("APP_ORIGIN", "https://dev.business.finlynq.com");
    vi.stubEnv("ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET", secret);
    vi.stubEnv("ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET_FILE", "");
    await owner.query(`INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at)
      VALUES ($1,$2,'Synthetic mail tenant',true,false,'REAL',now()),($3,$4,'Other synthetic tenant',true,false,'REAL',now())`,
      [ids.org, `mail-${ids.org}`, ids.otherOrg, `mail-${ids.otherOrg}`]);
    await owner.query(`INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active)
      VALUES ($1::uuid,$1::text,'encrypted','test',true)`, [ids.actor]);
    await owner.query(`INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES ($1,$2,$3,true)`,
      [ids.membership, ids.org, ids.actor]);
    await owner.query(`INSERT INTO roles(id,organization_id,key,display_name) VALUES ($1,$2,'MAIL_TEST','Mail test')`, [ids.role, ids.org]);
    await owner.query(`INSERT INTO role_permissions(organization_id,role_id,permission_key)
      SELECT $1,$2,unnest(ARRAY['payables.read','payables.manage','organization.settings.read','organization.settings.manage'])`, [ids.org, ids.role]);
    await owner.query(`INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES ($1,$2,$3,$4)`,
      [ids.org, ids.membership, ids.role, ids.actor]);
    await owner.query(`INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,
      auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at)
      VALUES ($1::uuid,$1::text,$2,$3,$4,'PASSWORD','REAL',repeat('a',64),7200,
        now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '2 hours')`, [ids.session, ids.actor, ids.org, ids.membership]);
    await owner.query(`INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code,active)
      VALUES ($1,$2,'MAIL','Synthetic company','CA','ON',true)`, [ids.entity, ids.org]);
    const root = loadOrganizationRootKek(), dek = randomBytes(32);
    try {
      const wrapped = new LocalRootKeyProvider(root).wrapOrganizationKey(ids.org, 1, dek);
      await owner.query(`INSERT INTO organization_key_versions(organization_id,version,key_provider,wrapped_dek,active)
        VALUES ($1,1,$2,$3,true)`, [ids.org, wrapped.provider, serializeWrappedKey(wrapped)]);
    } finally { root.fill(0); dek.fill(0); }
    for (const [id,parentId] of [["root","drive-root"],["inbox","root"],["archive","root"]]) {
      cloud.files.set(id, { id, parentId, name: id, folder: true, mimeType: "folder", size: 0, version: "v1" });
    }
    await withTenantTransaction(context(), async client => {
      const row = { id: ids.connection, organization_id: ids.org, key_version: 1 };
      const config = await encryptStorageValue(client, row, "document_storage_connections", "config_ciphertext", {
        accountId: "account", driveId: "drive", rootId: "root", inboxId: "inbox", archiveId: "archive",
        inboxUrl: "https://drive.google.com/drive/folders/inbox", archiveUrl: "https://drive.google.com/drive/folders/archive",
      });
      const credentials = await encryptStorageValue(client, row, "document_storage_connections", "credentials_ciphertext", {
        accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now()+3600000,
      });
      await client.query(`INSERT INTO document_storage_connections(id,organization_id,legal_entity_id,owner_module,provider,
        label,config_ciphertext,credentials_ciphertext,key_version,active,created_by)
        VALUES ($1,$2,$3,'payables','GOOGLE_DRIVE','Synthetic inbox',$4,$5,1,true,$6)`,
        [ids.connection, ids.org, ids.entity, config, credentials, ids.actor]);
    });
    const command = { context: context(), membershipId: ids.membership, reason: "Synthetic email setup" };
    const created = await provisionPersonalEmailAlias(command);
    address = created.alias.address; aliasId = created.alias.id;
    await configurePersonalEmailAlias({ ...command, context: context(), aliasId, expectedVersion: created.alias.version, connectionId: ids.connection });
  });
  afterAll(async () => { await closeDatabasePool(); await owner.end(); vi.unstubAllEnvs(); });

  function delivery(messageId = randomUUID(), options: { signature?: string; recipient?: string; attachments?: number } = {}) {
    const bytes = onePagePdf();
    const body = JSON.stringify({ message_id: messageId, smtp_message_id: null,
      from: { name: null, address: "supplier@example.test" }, to: [], recipient: options.recipient ?? address,
      subject: "Synthetic invoice", text: null, html: null, received_at: new Date().toISOString(),
      attachments: Array.from({ length: options.attachments ?? 1 }, (_, i) => ({ filename: i ? "receipt.pdf" : "invoice.pdf",
        content_type: "application/pdf", size: bytes.length, content_base64: bytes.toString("base64") })),
    });
    const timestamp = new Date().toISOString();
    return new Request("https://dev.business.finlynq.com/api/email/inbound/self-smtp", {
      method: "POST", body, headers: { "Content-Type": "application/json", "X-Mail-Timestamp": timestamp,
        "X-Mail-Signature": options.signature ?? `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}` },
    });
  }
  async function row(providerId: string) {
    return (await owner.query("SELECT * FROM inbound_email_messages WHERE organization_id=$1 AND provider_message_id=$2", [ids.org, providerId])).rows[0];
  }
  async function due(messageId: string) {
    await owner.query("UPDATE inbound_email_messages SET next_retry_at=now()-interval '10 minutes' WHERE id=$1", [messageId]);
  }

  it("signed intake creates one review item per attachment and replay creates no duplicate or accounting records", async () => {
    const providerId = randomUUID(), before = cloud.uploads;
    expect((await POST(delivery(providerId, { attachments: 2 }))).status).toBe(200);
    const message = await row(providerId);
    expect(message).toMatchObject({ status: "READY", retry_count: 0, error_code: null, processing_token: null });
    expect(cloud.uploads).toBe(before+2);
    const attachments = (await owner.query(`SELECT a.status,a.inbox_item_id,i.status AS inbox_status,i.source_document_id
      FROM inbound_email_attachments a JOIN document_inbox_items i ON i.id=a.inbox_item_id WHERE a.message_id=$1`, [message.id])).rows;
    expect(attachments).toHaveLength(2);
    expect(new Set(attachments.map(a => a.inbox_item_id)).size).toBe(2);
    expect(attachments.every(a => a.status === "INBOXED" && a.inbox_status === "PENDING" && a.source_document_id === null)).toBe(true);
    expect((await POST(delivery(providerId, { attachments: 2 }))).status).toBe(200);
    expect((await retryInboundMessage(context(), message.id)).status).toBe("UNCHANGED");
    expect(cloud.uploads).toBe(before+2);
    for (const table of ["source_documents","journal_entries","invoice_delivery_attempts"]) {
      expect((await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1`, [ids.org])).rows[0].n).toBe(0);
    }
  });

  it("rejects invalid signatures, unverified contexts, inactive memberships and wrong module access", async () => {
    const providerId = randomUUID();
    expect((await POST(delivery(providerId, { signature: `sha256=${"0".repeat(64)}` }))).status).toBe(401);
    expect(await row(providerId)).toBeUndefined();
    expect(() => realStorageContext({ ...context(), sessionId: undefined, sourceSurface: "WORKER", authMethod: "self-smtp-webhook" })).toThrow();
    await owner.query("UPDATE organization_memberships SET active=false WHERE id=$1", [ids.membership]);
    try {
      expect((await POST(delivery(providerId))).status).toBe(200);
      expect(await row(providerId)).toBeUndefined();
    } finally { await owner.query("UPDATE organization_memberships SET active=true WHERE id=$1", [ids.membership]); }
    await owner.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_key='payables.manage'", [ids.role]);
    try {
      expect((await POST(delivery(providerId))).status).toBe(200);
      expect((await row(providerId)).status).toBe("NEEDS_REVIEW");
      const ops = await loadEmailOperations(context());
      expect(ops.messages.find(m => m.providerMessageId === providerId)?.attachments[0])
        .toMatchObject({ failureCode: "INBOUND_ACCESS_DENIED", failureStage: "AUTHORIZATION" });
    } finally {
      await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES ($1,$2,'payables.manage')", [ids.org, ids.role]);
    }
    await expect(loadEmailOperations({ ...context(), organizationId: ids.otherOrg })).rejects.toThrow();
  });

  it("automatically recovers due work and exposes minimized overdue and attachment errors", async () => {
    const providerId = randomUUID(); cloud.outage = true;
    await POST(delivery(providerId));
    const message = await row(providerId);
    expect(message.status).toBe("RETRY_PENDING");
    await due(message.id);
    const ops = await loadEmailOperations(context());
    expect(ops.metrics).toMatchObject({ retryAlert: true });
    expect(ops.metrics.overdueRetryCount).toBeGreaterThan(0);
    expect(ops.messages.find(m => m.id === message.id)?.attachments[0]).toMatchObject({
      attemptCount: 1, failureCode: "STORAGE_PROVIDER_FAILED", failureStage: "STORAGE",
    });
    expect(JSON.stringify(ops)).not.toContain("private signed URL");
    cloud.outage = false;
    expect((await runInboundRetryBatch()).processed).toBeGreaterThan(0);
    expect(await row(providerId)).toMatchObject({ status: "READY", retry_count: 1, error_code: null, next_retry_at: null });
    const finished = await loadEmailOperations(context());
    expect(finished.messages.find(m => m.id === message.id)?.attachments[0]).toMatchObject({
      status: "INBOXED", attemptCount: 2, failureCode: null, failureStage: null,
    });
    expect((await owner.query("SELECT safe_details FROM email_operation_events WHERE organization_id=$1 AND outcome='RETRY_PENDING'", [ids.org])).rows.some(r => r.safe_details.code === "STORAGE_PROVIDER_FAILED")).toBe(true);
  });

  it("recovers a lost upload response exactly once across concurrent manual and automatic retry", async () => {
    const providerId = randomUUID(), before = cloud.uploads; cloud.lostResponse = true;
    await POST(delivery(providerId));
    const message = await row(providerId); expect(message.status).toBe("RETRY_PENDING");
    await due(message.id); cloud.delay = 30;
    try {
      await Promise.all([runInboundRetryBatch(), retryEmailOperation({ context: context(), kind: "INBOUND_MESSAGE", id: message.id, reason: "Synthetic retry race" })]);
      expect(await row(providerId)).toMatchObject({ status: "READY", retry_count: 1 });
      expect(cloud.uploads).toBe(before+1);
      expect((await owner.query("SELECT id FROM inbound_email_attachments WHERE message_id=$1 AND inbox_item_id IS NOT NULL", [message.id])).rows).toHaveLength(1);
    } finally { cloud.delay = 0; }
  });

  it("recovers expired claims, enforces backoff, and dead-letters after five retries", async () => {
    const providerId = randomUUID(); cloud.outage = true;
    await POST(delivery(providerId)); const message = await row(providerId);
    const claim = await loadInboundMessageForRetry(context(), message.id);
    expect(claim).not.toBeNull();
    expect(await loadInboundMessageForRetry(context(), message.id)).toBeNull();
    await owner.query("UPDATE inbound_email_messages SET processing_expires_at=now()-interval '1 second' WHERE id=$1", [message.id]);
    await due(message.id);
    await runInboundRetryBatch();
    expect(await row(providerId)).toMatchObject({ retry_count: 2, status: "RETRY_PENDING" });
    expect((await row(providerId)).next_retry_at.getTime()-Date.now()).toBeGreaterThan(290000);
    expect(await loadInboundMessageForRetry(context(), message.id, { dueOnly: true })).toBeNull();
    for (let i=0;i<3;i++) await retryInboundMessage(context(), message.id);
    expect(await row(providerId)).toMatchObject({ retry_count: 5, status: "DEAD_LETTER", error_code: "RETRY_EXHAUSTED", next_retry_at: null });
    expect((await retryInboundMessage(context(), message.id)).status).toBe("UNCHANGED");
    cloud.outage = false;
  });

  it("limits dispatcher output and preserves RLS with a non-superuser function owner", async () => {
    const providerId = randomUUID(); cloud.outage = true;
    try { await POST(delivery(providerId)); } finally { cloud.outage = false; }
    const message = await row(providerId); await due(message.id);
    const client = await owner.connect();
    const role = `email_dispatch_test_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await client.query(`GRANT USAGE,CREATE ON SCHEMA app,public TO ${role}`);
      await client.query(`GRANT SELECT ON users TO ${role}`);
      await client.query(`GRANT EXECUTE ON FUNCTION app.current_organization_id() TO ${role}`);
      for (const table of ["inbound_email_messages","email_ingestion_aliases","organizations","organization_memberships"]) {
        await client.query(`ALTER TABLE ${table} OWNER TO ${role}`);
      }
      await client.query(`ALTER FUNCTION app.due_inbound_email_retries(integer) OWNER TO ${role}`);
      await client.query("SET LOCAL ROLE business_finlynq_app");
      await client.query("SELECT set_config('app.organization_id',$1,true)", [ids.otherOrg]);
      const jobs = (await client.query("SELECT * FROM app.due_inbound_email_retries(1000)")).rows;
      expect(jobs.length).toBeLessThanOrEqual(10);
      expect(jobs.some(job => job.message_id === message.id)).toBe(true);
      expect(Object.keys(jobs[0]).sort()).toEqual(["actor_id","message_id","organization_id","provider"]);
      expect((await client.query("SELECT app.current_organization_id() AS id")).rows[0].id).toBe(ids.otherOrg);
      expect((await client.query("SELECT id FROM inbound_email_messages WHERE id=$1", [message.id])).rows).toHaveLength(0);
      expect((await client.query("SELECT id FROM inbound_email_attachments WHERE message_id=$1", [message.id])).rows).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK"); client.release();
      await retryInboundMessage(context(), message.id);
    }
  });
});
