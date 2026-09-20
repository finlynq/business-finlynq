import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import { DEMO_MEMBERSHIP_ID, DEMO_ORGANIZATION_ID, DEMO_USER_ID } from "@/modules/demo/constants";
import type { SessionPrincipal } from "@/modules/identity/session";
import { generateAssetScheduleJournal, loadAssetWorkspace } from "@/modules/assets/service";
import { resetSharedDemoOrganization } from "@/modules/onboarding/demo-bootstrap";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = ownerUrl && appUrl ? describe : describe.skip;

runDatabaseTests("asset register PostgreSQL controls", () => {
  const owner = new Pool({ connectionString: ownerUrl });
  const app = new Pool({ connectionString: appUrl });

  async function withContext<T>(
    actorId: string,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [DEMO_ORGANIZATION_ID]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
      await client.query("SELECT set_config('app.session_mode', 'real', true)");
      await client.query("SELECT set_config('app.request_id', $1, true)", [`asset-db-test:${randomUUID()}`]);
      await client.query("SELECT set_config('app.auth_method', 'TEST', true)");
      await client.query("SELECT set_config('app.source_surface', 'API', true)");
      await client.query("SELECT set_config('app.reason', 'Verify asset database controls', true)");
      const result = await callback(client);
      await client.query("ROLLBACK");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    vi.stubEnv("DEMO_WRITES_ENABLED", "true");
    await resetSharedDemoOrganization(owner, { mode: "nightly" });
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all([owner.end(), app.end(), closeDatabasePool()]);
  });

  it("exposes a complete tenant-scoped tangible, intangible, and prepaid register", async () => {
    const result = await withContext(DEMO_USER_ID, (client) => client.query<{
      categories: number;
      assets: number;
      schedules: number;
      events: number;
      invalid_schedules: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM asset_categories) AS categories,
         (SELECT count(*)::int FROM asset_register) AS assets,
         (SELECT count(*)::int FROM asset_schedule_entries) AS schedules,
         (SELECT count(*)::int FROM asset_lifecycle_events) AS events,
         (SELECT count(*)::int FROM asset_register asset
            WHERE (asset.classification = 'INDEFINITE_LIFE' AND EXISTS (
              SELECT 1 FROM asset_schedule_entries schedule WHERE schedule.asset_id = asset.id
            )) OR (asset.classification = 'FINITE_LIFE' AND NOT EXISTS (
              SELECT 1 FROM asset_schedule_entries schedule
              WHERE schedule.asset_id = asset.id
              GROUP BY schedule.asset_id
              HAVING count(*) = asset.useful_life_months
                AND sum(schedule.amount) = asset.cost - asset.residual_value
            ))) AS invalid_schedules`,
    ));
    expect(result.rows[0]).toEqual({
      categories: 3,
      assets: 4,
      schedules: 63,
      events: 10,
      invalid_schedules: 0,
    });
  });

  it("allows the authorized demo accountant to append history and rejects an unknown actor", async () => {
    const asset = await owner.query<{ id: string; in_service_on: string }>(
      `SELECT id, in_service_on::text FROM asset_register
       WHERE organization_id = $1 AND status = 'ACTIVE'
       ORDER BY asset_number LIMIT 1`,
      [DEMO_ORGANIZATION_ID],
    );
    expect(asset.rows[0]).toBeDefined();
    const selected = asset.rows[0]!;
    await expect(withContext(DEMO_USER_ID, (client) => client.query(
      `INSERT INTO asset_lifecycle_events(
         organization_id, asset_id, event_type, effective_on, details, created_by
       ) VALUES ($1,$2,'TRANSFERRED',$3,$4::jsonb,$5)`,
      [DEMO_ORGANIZATION_ID, selected.id, selected.in_service_on,
        JSON.stringify({ reason: "Integration test transfer" }), DEMO_USER_ID],
    ))).resolves.toBeDefined();

    await expect(withContext(randomUUID(), (client) => client.query(
      `INSERT INTO asset_lifecycle_events(
         organization_id, asset_id, event_type, effective_on, details, created_by
       ) VALUES ($1,$2,'TRANSFERRED',$3,$4::jsonb,$5)`,
      [DEMO_ORGANIZATION_ID, selected.id, selected.in_service_on,
        JSON.stringify({ reason: "Unauthorized transfer" }), randomUUID()],
    ))).rejects.toMatchObject({ code: "42501" });
  });

  it("creates and links one asset schedule journal atomically through the app role", async () => {
    const schedule = (await owner.query<{
      id: string; expense_account_id: string; credit_account_id: string; amount: string;
    }>(
      `SELECT schedule.id,
         category.expense_account_combination_id AS expense_account_id,
         CASE WHEN asset.kind='PREPAID' THEN category.cost_account_combination_id
           ELSE category.contra_account_combination_id END AS credit_account_id,
         schedule.amount::text
       FROM asset_schedule_entries schedule
       JOIN asset_register asset ON asset.organization_id=schedule.organization_id
         AND asset.id=schedule.asset_id AND asset.status IN ('ACTIVE','IMPAIRED')
       JOIN asset_categories category ON category.organization_id=asset.organization_id
         AND category.id=asset.category_id
       JOIN fiscal_periods period ON period.organization_id=asset.organization_id
         AND period.ledger_id=asset.ledger_id
         AND schedule.due_on BETWEEN period.starts_on AND period.ends_on
         AND period.state IN ('OPEN','ADJUSTMENT_ONLY')
       WHERE schedule.organization_id=$1 AND schedule.status='DUE'
       ORDER BY schedule.due_on, schedule.id LIMIT 1`,
      [DEMO_ORGANIZATION_ID],
    )).rows[0];
    expect(schedule).toBeDefined();
    const demoTokenHash = randomUUID().replaceAll("-", "").repeat(2);
    const demoSession = (await owner.query<{ session_id: string }>(
      "SELECT session_id FROM app.auth_issue_demo_session($1,$2,$3,$4,$5,$6)",
      [demoTokenHash, null, null, "b".repeat(64), "c".repeat(64), randomUUID()],
    )).rows[0];
    expect(demoSession).toBeDefined();
    const context = {
      organizationId: DEMO_ORGANIZATION_ID,
      actorId: DEMO_USER_ID,
      sessionId: demoSession!.session_id,
      sessionMode: "demo" as const,
      requestId: `asset-journal:${randomUUID()}`,
      authMethod: "demo-link",
      sourceSurface: "MCP" as const,
      reason: "Verify atomic asset schedule journal generation",
      demoWriteAuthorized: true,
    };
    const idempotencyKey = `asset-db-test:${randomUUID()}`;
    const created = await generateAssetScheduleJournal({ context, scheduleEntryId: schedule!.id, idempotencyKey });
    const replay = await generateAssetScheduleJournal({
      context: { ...context, requestId: `asset-journal-replay:${randomUUID()}` },
      scheduleEntryId: schedule!.id,
      idempotencyKey,
    });
    expect(replay).toMatchObject({ journalId: created.journalId, scheduleEntryId: schedule!.id, idempotentReplay: true });

    const persisted = await owner.query<{
      status: string; journal_entry_id: string; journal_count: number;
      debit_account_id: string; credit_account_id: string; debit: string; credit: string;
    }>(
      `SELECT schedule.status, schedule.journal_entry_id,
         (SELECT count(*)::int FROM journal_entries counted
          WHERE counted.organization_id=schedule.organization_id
            AND counted.idempotency_key=$3) AS journal_count,
         max(line.account_combination_id::text) FILTER (WHERE line.debit_transaction > 0) AS debit_account_id,
         max(line.account_combination_id::text) FILTER (WHERE line.credit_transaction > 0) AS credit_account_id,
         sum(line.debit_transaction)::text AS debit,
         sum(line.credit_transaction)::text AS credit
       FROM asset_schedule_entries schedule
       JOIN journal_entries journal ON journal.organization_id=schedule.organization_id
         AND journal.id=schedule.journal_entry_id
       JOIN journal_lines line ON line.organization_id=journal.organization_id
         AND line.journal_entry_id=journal.id
       WHERE schedule.organization_id=$1 AND schedule.id=$2
       GROUP BY schedule.id`,
      [DEMO_ORGANIZATION_ID, schedule!.id, `asset-schedule:${schedule!.id}:${idempotencyKey}`],
    );
    expect(persisted.rows[0]).toMatchObject({
      status: "DRAFTED",
      journal_entry_id: created.journalId,
      journal_count: 1,
      debit_account_id: schedule!.expense_account_id,
      credit_account_id: schedule!.credit_account_id,
      debit: schedule!.amount,
      credit: schedule!.amount,
    });
  });

  it("does not reveal the register without the matching tenant context", async () => {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [randomUUID()]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [DEMO_USER_ID]);
      const result = await client.query("SELECT id FROM asset_register");
      expect(result.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("loads the workspace roll-forward and register-to-GL reconciliation through the app role", async () => {
    const principal: SessionPrincipal = {
      sessionId: randomUUID(),
      userId: DEMO_USER_ID,
      organizationId: DEMO_ORGANIZATION_ID,
      membershipId: DEMO_MEMBERSHIP_ID,
      organizationName: "Northstar Demo Group",
      roleLabel: "Demo accountant",
      displayName: "Demo owner",
      initials: "DO",
      sessionMode: "real",
      authMethod: "PASSWORD",
      expiresAt: new Date(Date.now() + 60_000),
      mfaVerifiedAt: null,
      stepUpExpiresAt: null,
      organizationWritesEnabled: true,
    };
    const workspace = await loadAssetWorkspace(principal);
    expect(workspace.assets).toHaveLength(4);
    expect(workspace.reconciliation).toHaveLength(3);
    expect(workspace.reconciliation.every((row) =>
      typeof row.registerNet === "string" &&
      typeof row.glNet === "string" &&
      typeof row.variance === "string",
    )).toBe(true);
  });
});
