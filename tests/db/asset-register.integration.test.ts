import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import { DEMO_MEMBERSHIP_ID, DEMO_ORGANIZATION_ID, DEMO_USER_ID } from "@/modules/demo/constants";
import type { SessionPrincipal } from "@/modules/identity/session";
import { loadAssetWorkspace } from "@/modules/assets/service";
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
    await resetSharedDemoOrganization(owner, { mode: "nightly" });
  }, 300_000);

  afterAll(async () => Promise.all([owner.end(), app.end(), closeDatabasePool()]));

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
