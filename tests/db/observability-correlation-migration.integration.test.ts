import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const connectionString = databaseUrl ?? "postgresql://invalid:invalid@127.0.0.1:1/invalid";
const runDatabaseTests = databaseUrl ? describe : describe.skip;
const migration = readFileSync(
  join(process.cwd(), "migrations", "drizzle", "0032_observability_correlation_metrics.sql"),
  "utf8",
);
const backfill = migration.slice(
  migration.indexOf("-- BEGIN OUTBOX REQUEST CORRELATION BACKFILL"),
  migration.indexOf("-- END OUTBOX REQUEST CORRELATION BACKFILL"),
).replaceAll("public.audit_events", "observability_legacy_audit")
  .replaceAll("public.outbox_events", "observability_legacy_outbox");

runDatabaseTests("G0-03 to G0-05 outbox request-correlation migration", () => {
  const pool = new Pool({ connectionString });
  let client: PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query(`
      CREATE TEMP TABLE observability_legacy_audit (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        action text NOT NULL,
        request_id text NOT NULL,
        safe_metadata jsonb NOT NULL,
        occurred_at timestamp with time zone NOT NULL
      );
      CREATE TEMP TABLE observability_legacy_outbox (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        topic text NOT NULL,
        aggregate_type text NOT NULL,
        aggregate_id text NOT NULL,
        payload jsonb NOT NULL,
        request_id text,
        created_at timestamp with time zone NOT NULL
      );
    `);
  });

  afterAll(async () => {
    if (client) {
      await client.query("DROP TABLE IF EXISTS observability_legacy_outbox, observability_legacy_audit");
      client.release();
    }
    await pool.end();
  });

  it("backfills pre-G0 rows and preserves populated post-G0 request IDs across differing clocks", async () => {
    const organizationId = randomUUID();
    const repeatedMembershipId = randomUUID();
    const fixtures = [
      {
        action: "journal.posted",
        topic: "ledger.journal-posted",
        entityType: "journal_entry",
        auditPayload: { journalNumber: "J-1", contentHash: "a".repeat(64) },
        outboxPayload: { journalId: randomUUID(), journalNumber: "J-1", contentHash: "a".repeat(64) },
      },
      {
        action: "subledger.allocation-applied",
        topic: "subledger.settlement-allocation-apply",
        entityType: "document_settlement_allocation",
        auditPayload: { allocationType: "APPLY", commandHash: "b".repeat(64) },
        outboxPayload: { allocationType: "APPLY", commandHash: "b".repeat(64) },
      },
      {
        action: "receivables.document-posted",
        topic: "receivables.source-document-posted",
        entityType: "source_document",
        auditPayload: { status: "POSTED", contentHash: "c".repeat(64) },
        outboxPayload: { status: "POSTED", contentHash: "c".repeat(64) },
      },
      {
        action: "period.transition",
        topic: "ledger.period-transitioned",
        entityType: "fiscal_period",
        auditPayload: { from: "OPEN", to: "HARD_CLOSED", version: 2 },
        outboxPayload: {
          periodId: randomUUID(),
          ledgerId: randomUUID(),
          fromState: "OPEN",
          toState: "HARD_CLOSED",
          version: 2,
        },
      },
      {
        action: "organization.member-sessions-revoked",
        topic: "organization.member-sessions-revoked",
        entityType: "organization_membership",
        entityId: repeatedMembershipId,
        preCorrelated: true,
        auditPayload: { revokedCount: 0 },
        outboxPayload: { revokedCount: 0 },
      },
      {
        action: "organization.member-sessions-revoked",
        topic: "organization.member-sessions-revoked",
        entityType: "organization_membership",
        entityId: repeatedMembershipId,
        preCorrelated: true,
        auditPayload: { revokedCount: 0 },
        outboxPayload: { revokedCount: 0 },
      },
    ];
    const expected = new Map<string, string>();

    for (const fixture of fixtures) {
      const entityId = "entityId" in fixture ? fixture.entityId : randomUUID();
      const preCorrelated = "preCorrelated" in fixture && fixture.preCorrelated;
      const requestId = randomUUID();
      const outboxId = randomUUID();
      expected.set(outboxId, requestId);
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO observability_legacy_audit
            (id, organization_id, entity_type, entity_id, action, request_id, safe_metadata, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(), organizationId, fixture.entityType, entityId, fixture.action, requestId,
            fixture.auditPayload, preCorrelated ? "2026-08-31T12:05:00Z" : "2026-08-31T12:00:00Z",
          ],
        );
        await client.query(
          `INSERT INTO observability_legacy_outbox
            (id, organization_id, topic, aggregate_type, aggregate_id, payload, created_at, request_id)
           VALUES ($1,$2,$3,$4,$5,$6,'2026-08-31T12:00:00Z',$7)`,
          [
            outboxId, organizationId, fixture.topic, fixture.entityType, entityId,
            fixture.outboxPayload, preCorrelated ? requestId : null,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    await client.query(backfill);
    const result = await client.query<{ id: string; request_id: string }>(
      "SELECT id::text, request_id FROM observability_legacy_outbox ORDER BY id",
    );
    expect(result.rows).toHaveLength(fixtures.length);
    for (const row of result.rows) expect(row.request_id).toBe(expected.get(row.id));
  });

  it("blocks an ambiguous historical match instead of inventing lineage", async () => {
    const organizationId = randomUUID();
    const entityId = randomUUID();
    const payload = { partyNumber: "P-1" };
    await client.query("BEGIN");
    try {
      for (const requestId of [randomUUID(), randomUUID()]) {
        await client.query(
          `INSERT INTO observability_legacy_audit
            (id, organization_id, entity_type, entity_id, action, request_id, safe_metadata, occurred_at)
           VALUES ($1,$2,'party',$3,'party.created',$4,$5,'2026-08-31T12:00:00Z')`,
          [randomUUID(), organizationId, entityId, requestId, payload],
        );
      }
      await client.query(
        `INSERT INTO observability_legacy_outbox
          (id, organization_id, topic, aggregate_type, aggregate_id, payload, created_at)
         VALUES ($1,$2,'parties.party-created','party',$3,$4,'2026-08-31T12:00:00Z')`,
        [randomUUID(), organizationId, entityId, payload],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    await expect(client.query(backfill)).rejects.toThrow(/cannot be correlated unambiguously/i);
    await client.query("DELETE FROM observability_legacy_outbox WHERE organization_id = $1", [organizationId]);
    await client.query("DELETE FROM observability_legacy_audit WHERE organization_id = $1", [organizationId]);
  });
});
