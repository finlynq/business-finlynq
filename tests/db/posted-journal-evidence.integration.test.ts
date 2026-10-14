import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import { LocalRootKeyProvider, serializeWrappedKey } from "@/security/organization-encryption";
import { uploadDocumentEvidence } from "@/modules/subledger/evidence-service";
import {
  downloadPostedJournalEvidence,
  linkPostedJournalEvidence,
  listPostedJournalEvidence,
} from "@/modules/ledger/journal-evidence";

vi.mock("@/security/evidence-scanner", () => ({
  scanEvidence: vi.fn(async () => ({ version: "synthetic-scanner", scannedAt: new Date().toISOString() })),
}));

const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const ids = {
  org: randomUUID(), actor: randomUUID(), membership: randomUUID(), role: randomUUID(),
  session: randomUUID(), entity: randomUUID(), ledger: randomUUID(), period: randomUUID(),
  first: randomUUID(), second: randomUUID(),
};
const rootKey = randomBytes(32);
const original = Buffer.from("%PDF-1.4\nOriginal split invoice 134.47\n%%EOF");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const context = () => ({
  organizationId: ids.org, actorId: ids.actor, sessionId: ids.session,
  sessionMode: "real" as const, requestId: randomUUID(),
  authMethod: "password+mfa", sourceSurface: "MCP" as const,
  reason: "Retain the exact original on posted journals",
});

run("posted journal original evidence", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const previous = {
    databaseUrl: process.env.DATABASE_URL,
    rootKey: process.env.ORGANIZATION_ROOT_KEK,
    rootKeyFile: process.env.ORGANIZATION_ROOT_KEK_FILE,
    writes: process.env.BUSINESS_WRITES_ENABLED,
  };
  let assetId: string;
  const postedHash = "a".repeat(64);
  const target = (journalId: string, expectedEvidenceRevision = 0) => ({
    journalId, expectedContentHash: postedHash, expectedEvidenceRevision,
  });
  const input = (key: string, targets = [target(ids.first), target(ids.second)]) => ({
    assetId, targets, metadata: {
      documentDate: "2026-06-02", reference: "MC76150842", currency: "CAD",
      total: "134.47",
    },
    reason: "Retain the reviewed original without changing the booking",
    idempotencyKey: key,
  });

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", process.env.TEST_APP_DATABASE_URL!);
    vi.stubEnv("ORGANIZATION_ROOT_KEK", rootKey.toString("base64"));
    vi.stubEnv("ORGANIZATION_ROOT_KEK_FILE", "");
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    await owner.query(
      "INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES($1,$2,'Evidence fixture',true,false,'REAL',now())",
      [ids.org, `posted-evidence-${ids.org}`],
    );
    await owner.query(
      "INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES($1,$2,'encrypted','test',true)",
      [ids.actor, ids.actor],
    );
    await owner.query(
      "INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,true)",
      [ids.membership, ids.org, ids.actor],
    );
    await owner.query(
      "INSERT INTO roles(id,organization_id,key,display_name) VALUES($1,$2,'EVIDENCE_FIXTURE','Evidence fixture')",
      [ids.role, ids.org],
    );
    await owner.query(
      "INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,unnest(ARRAY['mcp.ledger.read','ledger.journal.draft','payables.read','payables.manage'])",
      [ids.org, ids.role],
    );
    await owner.query(
      "INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)",
      [ids.org, ids.membership, ids.role, ids.actor],
    );
    await owner.query(
      `INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,auth_method,session_mode,
         user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at)
       VALUES($1::uuid,$1::text,$2,$3,$4,'PASSWORD','REAL',repeat('a',64),7200,
         now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '2 hours')`,
      [ids.session, ids.actor, ids.org, ids.membership],
    );
    const dek = randomBytes(32);
    try {
      const wrapped = new LocalRootKeyProvider(rootKey).wrapOrganizationKey(ids.org, 1, dek);
      await owner.query(
        "INSERT INTO organization_key_versions(organization_id,version,key_provider,wrapped_dek,active) VALUES($1,1,$2,$3,true)",
        [ids.org, wrapped.provider, serializeWrappedKey(wrapped)],
      );
    } finally { dek.fill(0); }
    await owner.query(
      "INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code,active) VALUES($1,$2,'CA01','Evidence entity','CA','ON',true)",
      [ids.entity, ids.org],
    );
    await owner.query(
      "INSERT INTO ledgers(id,organization_id,legal_entity_id,code,display_name,kind,accounting_profile,functional_currency) VALUES($1,$2,$3,'PRIMARY','Primary','PRIMARY','CAN_ASPE','CAD')",
      [ids.ledger, ids.org, ids.entity],
    );
    await owner.query(
      "INSERT INTO fiscal_periods(id,organization_id,ledger_id,fiscal_year,period_number,label,starts_on,ends_on,state) VALUES($1,$2,$3,2026,6,'June 2026','2026-06-01','2026-06-30','SEALED')",
      [ids.period, ids.org, ids.ledger],
    );
    // Seed only the immutable posted headers. Their amounts deliberately sum to
    // the original total, but neither the service nor this test changes them.
    const fixture = await owner.connect();
    try {
      await fixture.query("BEGIN");
      await fixture.query("SET LOCAL session_replication_role=replica");
      for (const [id, amount, number] of [[ids.first, "119.00", 231], [ids.second, "15.47", 232]] as const) {
        await fixture.query(
          `INSERT INTO journal_entries(id,organization_id,legal_entity_id,ledger_id,period_id,
             journal_type_definition_id,journal_type_key,journal_type_version,source_event_key,
             idempotency_key,origin,purpose,status,accounting_date,functional_currency,description,
             total_debit_functional,total_credit_functional,content_hash,journal_number,created_by,posted_by,posted_at)
           VALUES($1,$2,$3,$4,$5,(SELECT id FROM journal_type_definitions WHERE key='ledger.manual' AND version=1),
             'ledger.manual',1,$6,$7,'USER','ROUTINE','POSTED','2026-06-04','CAD','Split invoice evidence',
             $8,$8,$9,$10,$11,$11,now())`,
          [id, ids.org, ids.entity, ids.ledger, ids.period, `evidence:${id}`, `evidence:${id}`,
            amount, postedHash, number, ids.actor],
        );
      }
      await fixture.query("COMMIT");
    } catch (error) { await fixture.query("ROLLBACK"); throw error; }
    finally { fixture.release(); }
    const uploaded = await uploadDocumentEvidence({
      context: context(), module: "payables", filename: "MC76150842.pdf",
      mimeType: "application/pdf", byteSize: original.length,
      contentBase64: original.toString("base64"), sha256: sha256(original),
      idempotencyKey: randomUUID(),
    });
    assetId = uploaded.asset.assetId;
  });

  afterAll(async () => {
    await closeDatabasePool();
    await owner.end();
    rootKey.fill(0);
    for (const [name, value] of Object.entries({
      DATABASE_URL: previous.databaseUrl,
      ORGANIZATION_ROOT_KEK: previous.rootKey,
      ORGANIZATION_ROOT_KEK_FILE: previous.rootKeyFile,
      BUSINESS_WRITES_ENABLED: previous.writes,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("links one verified original to two sealed-period postings with audit and exact readback", async () => {
    const key = randomUUID();
    const before = await owner.query(
      "SELECT id,status,accounting_date,total_debit_functional,total_credit_functional,content_hash FROM journal_entries WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[ids.first, ids.second]],
    );
    const result = await linkPostedJournalEvidence(context(), input(key));
    expect(result.idempotentReplay).toBe(false);
    expect(result.links).toHaveLength(2);
    expect(new Set(result.links.map((link) => link.assetId))).toEqual(new Set([assetId]));
    expect((await linkPostedJournalEvidence(context(), input(key))).idempotentReplay).toBe(true);
    await expect(linkPostedJournalEvidence(context(), {
      ...input(key), metadata: { ...input(key).metadata, total: "134.48" },
    })).rejects.toThrow(/idempotency key/);
    for (const journalId of [ids.first, ids.second]) {
      const listed = await listPostedJournalEvidence(context(), journalId);
      expect(listed.evidenceRevision).toBe(1);
      expect(listed.links[0]).toMatchObject({
        assetId, documentDate: "2026-06-02", documentReference: "MC76150842",
        documentCurrency: "CAD", documentTotal: "134.470000000",
        asset: { sha256: sha256(original), filename: "MC76150842.pdf" },
      });
      const downloaded = await downloadPostedJournalEvidence(context(), journalId, assetId);
      expect(sha256(downloaded.bytes)).toBe(sha256(original));
      downloaded.bytes.fill(0);
    }
    const after = await owner.query(
      "SELECT id,status,accounting_date,total_debit_functional,total_credit_functional,content_hash FROM journal_entries WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[ids.first, ids.second]],
    );
    expect(after.rows).toEqual(before.rows);
    const audit = await owner.query(
      "SELECT count(*)::int AS count FROM audit_events WHERE organization_id=$1 AND action='journal-evidence.linked'",
      [ids.org],
    );
    expect(audit.rows[0].count).toBe(2);
  });

  it("rejects stale targets, changed retry arguments, duplicate bytes, and revoked module access", async () => {
    await expect(linkPostedJournalEvidence(context(), input(randomUUID(), [target(ids.first, 0)])))
      .rejects.toThrow(/revision/);
    const key = randomUUID();
    await expect(linkPostedJournalEvidence(context(), input(key, [target(ids.first, 1)])))
      .rejects.toThrow(/already linked/);
    await owner.query(
      "DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_key='payables.manage'",
      [ids.org, ids.role],
    );
    try {
      await expect(linkPostedJournalEvidence(context(), input(randomUUID(), [target(ids.first, 1)])))
        .rejects.toThrow();
      const stillReadable = await downloadPostedJournalEvidence(context(), ids.first, assetId);
      expect(sha256(stillReadable.bytes)).toBe(sha256(original));
      stillReadable.bytes.fill(0);
      await owner.query(
        "DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_key='payables.read'",
        [ids.org, ids.role],
      );
      await expect(downloadPostedJournalEvidence(context(), ids.first, assetId)).rejects.toThrow();
    } finally {
      await owner.query(
        "INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,'payables.manage'),($1,$2,'payables.read') ON CONFLICT DO NOTHING",
        [ids.org, ids.role],
      );
    }
    await expect(downloadPostedJournalEvidence(
      { ...context(), organizationId: randomUUID() }, ids.first, assetId,
    )).rejects.toThrow();
  });
});
