import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabasePool, withTenantTransaction } from "@/db/transaction";
import { LocalRootKeyProvider, serializeWrappedKey } from "@/security/organization-encryption";
import { loadOrganizationRootKek } from "@/security/root-secret";
import {
  configurePersonalEmailAlias, getPersonalEmailAlias,
  provisionPersonalEmailAlias, rotatePersonalEmailAlias,
} from "@/modules/email/configuration";
import { ingestInboundEmail } from "@/modules/email/inbound";
import { parseRelayMessage } from "@/modules/email/self-smtp";
import type { InboundProviderMessage } from "@/modules/email/model";

const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const ids = {
  org: randomUUID(), otherOrg: randomUUID(), actor: randomUUID(), otherActor: randomUUID(),
  membership: randomUUID(), otherMembership: randomUUID(), session: randomUUID(),
};
const context = {
  organizationId: ids.org, actorId: ids.actor, sessionId: ids.session,
  sessionMode: "real" as const, requestId: randomUUID(), authMethod: "password+mfa",
  sourceSurface: "UI" as const, reason: "Personal email integration test",
};
const command = { context, membershipId: ids.membership, reason: context.reason };

function message(address: string): InboundProviderMessage {
  const pdf = Buffer.from("%PDF-1.7\nPersonal email integration fixture\n%%EOF");
  return parseRelayMessage(Buffer.from(JSON.stringify({
    message_id: randomUUID(), smtp_message_id: "same-sender-controlled-id@example.test",
    from: { name: null, address: "sender@example.test" }, to: [], recipient: address,
    subject: "Private invoice", text: null, html: null, received_at: new Date().toISOString(),
    attachments: [{ filename: "invoice.pdf", content_type: "application/pdf",
      size: pdf.length, content_base64: pdf.toString("base64") }],
  })));
}

run("personal email PostgreSQL lifecycle with the restricted runtime role", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", process.env.TEST_APP_DATABASE_URL!);
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN", "mail.finlynq.com");
    vi.stubEnv("BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX", "businessdev-");
    vi.stubEnv("APP_ORIGIN", "https://dev.business.finlynq.com");
    await owner.query(`INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at)
      VALUES ($1,$2,'Personal email test',true,false,'REAL',now()),
        ($3,$4,'Other email tenant',true,false,'REAL',now())`,
    [ids.org, `email-${ids.org}`, ids.otherOrg, `email-${ids.otherOrg}`]);
    await owner.query(`INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active)
      VALUES ($1::uuid,$1::text,'encrypted','test',true),($2::uuid,$2::text,'encrypted','test',true)`,
    [ids.actor, ids.otherActor]);
    await owner.query(`INSERT INTO organization_memberships(id,organization_id,user_id,active)
      VALUES ($1,$2,$3,true),($4,$2,$5,true)`,
    [ids.membership, ids.org, ids.actor, ids.otherMembership, ids.otherActor]);
    await owner.query(`INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,
      auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at)
      VALUES ($1::uuid,$1::text,$2,$3,$4,'PASSWORD','REAL',repeat('a',64),7200,
        now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '2 hours')`,
    [ids.session, ids.actor, ids.org, ids.membership]);
    const root = loadOrganizationRootKek();
    const dek = randomBytes(32);
    try {
      const wrapped = new LocalRootKeyProvider(root).wrapOrganizationKey(ids.org, 1, dek);
      await owner.query(`INSERT INTO organization_key_versions(organization_id,version,key_provider,wrapped_dek,active)
        VALUES ($1,1,$2,$3,true)`, [ids.org, wrapped.provider, serializeWrappedKey(wrapped)]);
    } finally { root.fill(0); dek.fill(0); }
  });

  afterAll(async () => {
    await closeDatabasePool();
    await owner.end();
    vi.unstubAllEnvs();
  });

  it("provisions, configures, ingests, deduplicates, and rotates without identity table privileges", async () => {
    await withTenantTransaction(context, async (client) => {
      const privileges = (await client.query(`SELECT
        has_table_privilege(current_user,'users','SELECT') AS read_users,
        has_table_privilege(current_user,'organization_memberships','UPDATE') AS lock_memberships,
        has_table_privilege(current_user,'users','UPDATE') AS lock_users`)).rows[0];
      expect(privileges).toEqual({ read_users: false, lock_memberships: false, lock_users: false });
      expect((await client.query("SELECT app.lock_active_email_membership($1) AS allowed", [ids.membership])).rows[0].allowed).toBe(true);
      expect((await client.query("SELECT app.lock_active_email_membership($1) AS allowed", [ids.otherMembership])).rows[0].allowed).toBe(false);
    });
    expect(await getPersonalEmailAlias(context, ids.membership)).toBeNull();
    const created = await provisionPersonalEmailAlias(command);
    expect(created.idempotentReplay).toBe(false);
    expect(created.alias.address).toMatch(/^businessdev-[a-f0-9]{32}@mail\.finlynq\.com$/);
    expect((await provisionPersonalEmailAlias(command)).alias.id).toBe(created.alias.id);
    expect((await getPersonalEmailAlias(context, ids.membership))?.id).toBe(created.alias.id);
    await expect(getPersonalEmailAlias(context, ids.otherMembership)).rejects.toThrow("membership is not active");
    await expect(getPersonalEmailAlias({ ...context, organizationId: ids.otherOrg }, ids.membership)).rejects.toThrow("membership is not active");

    const configured = await configurePersonalEmailAlias({ ...command, context: { ...context, requestId: randomUUID() },
      aliasId: created.alias.id, expectedVersion: created.alias.version, connectionId: null });
    expect(configured.alias.version).toBe(created.alias.version + 1);
    const inbound = message(created.alias.address);
    expect(await ingestInboundEmail(inbound)).toMatchObject({ routedRecipients: 1, replays: 0, retryPending: true });
    expect(await ingestInboundEmail(inbound)).toMatchObject({ routedRecipients: 1, replays: 1 });
    const stored = (await owner.query(`SELECT organization_id,alias_id,status,envelope_ciphertext
      FROM inbound_email_messages WHERE provider_event_id=$1`, [inbound.eventId])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ organization_id: ids.org, alias_id: created.alias.id, status: "RETRY_PENDING" });
    expect(stored[0].envelope_ciphertext).not.toContain("Private invoice");

    // Concurrent relay retries serialize alias staging and cannot duplicate a
    // message even when they arrive before initial downstream processing ends.
    const concurrent = message(created.alias.address);
    const deliveries = await Promise.all([ingestInboundEmail(concurrent), ingestInboundEmail(concurrent)]);
    expect(deliveries.reduce((count, result) => count + result.replays, 0)).toBe(1);
    expect((await owner.query("SELECT id FROM inbound_email_messages WHERE provider_message_id=$1",
      [concurrent.messageId])).rows).toHaveLength(1);

    // Unsupported types remain encrypted in quarantine, not silently lost
    // when Mailpit deletes the acknowledged copy.
    const unsupported = message(created.alias.address);
    unsupported.attachments[0] = { id: "csv", filename: "statement.csv", mimeType: "text/csv",
      content: Buffer.from("private,statement"), declaredSize: 17 };
    expect(await ingestInboundEmail(unsupported)).toMatchObject({ routedRecipients: 1 });
    const quarantined = (await owner.query(`SELECT a.status,a.mime_type,a.content_ciphertext
      FROM inbound_email_attachments a JOIN inbound_email_messages m ON m.id=a.message_id
      WHERE m.provider_message_id=$1`, [unsupported.messageId])).rows[0];
    expect(quarantined).toMatchObject({ status: "QUARANTINED", mime_type: "text/csv" });
    expect(quarantined.content_ciphertext).toBeTruthy();
    expect(quarantined.content_ciphertext).not.toContain("private,statement");

    await withTenantTransaction({ ...context, requestId: randomUUID() }, (client) => client.query(
      "UPDATE email_ingestion_aliases SET max_payload_bytes=1024 WHERE organization_id=$1 AND id=$2",
      [ids.org, created.alias.id]));
    const overAliasLimit = message(created.alias.address);
    overAliasLimit.attachments[0].content = Buffer.alloc(2048, "x");
    overAliasLimit.attachments[0].declaredSize = 2048;
    expect(await ingestInboundEmail(overAliasLimit)).toMatchObject({ routedRecipients: 1 });
    const retained = (await owner.query(`SELECT m.status,a.status AS attachment_status,a.content_ciphertext
      FROM inbound_email_messages m JOIN inbound_email_attachments a ON a.message_id=m.id
      WHERE m.provider_message_id=$1`, [overAliasLimit.messageId])).rows[0];
    expect(retained).toMatchObject({ status: "QUARANTINED", attachment_status: "QUARANTINED" });
    expect(retained.content_ciphertext).toBeTruthy();

    const rotation = { ...command, context: { ...context, requestId: randomUUID() },
      aliasId: created.alias.id, expectedVersion: configured.alias.version,
      idempotencyKey: randomUUID() };
    const rotated = await rotatePersonalEmailAlias(rotation);
    expect(rotated.alias.address).not.toBe(created.alias.address);
    expect((await rotatePersonalEmailAlias(rotation)).alias.id).toBe(rotated.alias.id);
    expect(await ingestInboundEmail(message(created.alias.address))).toMatchObject({ routedRecipients: 0, ignoredRecipients: 1 });
    expect(await ingestInboundEmail(message(rotated.alias.address))).toMatchObject({ routedRecipients: 1 });

    await owner.query("UPDATE users SET active=false WHERE id=$1", [ids.actor]);
    try {
      await expect(getPersonalEmailAlias(context, ids.membership)).rejects.toThrow("membership is not active");
      expect(await ingestInboundEmail(message(rotated.alias.address))).toMatchObject({ routedRecipients: 0, ignoredRecipients: 1 });
    } finally { await owner.query("UPDATE users SET active=true WHERE id=$1", [ids.actor]); }
    await owner.query("UPDATE organization_memberships SET active=false WHERE id=$1", [ids.membership]);
    try {
      await expect(getPersonalEmailAlias(context, ids.membership)).rejects.toThrow("membership is not active");
      expect(await ingestInboundEmail(message(rotated.alias.address))).toMatchObject({ routedRecipients: 0, ignoredRecipients: 1 });
    } finally { await owner.query("UPDATE organization_memberships SET active=true WHERE id=$1", [ids.membership]); }
  });
});
