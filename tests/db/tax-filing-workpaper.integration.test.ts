import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const runDatabaseTests = ownerUrl && appUrl ? describe : describe.skip;

const ids = {
  organization: randomUUID(),
  actor: randomUUID(),
  membership: randomUUID(),
  role: randomUUID(),
  entity: randomUUID(),
  ledger: randomUUID(),
  mappingSet: randomUUID(),
  configuration: randomUUID(),
  registration: randomUUID(),
  accounts: [randomUUID(), randomUUID(), randomUUID()],
  failedFiling: randomUUID(),
  filing: randomUUID(),
};

const templateId = "f1000000-0000-4000-8000-000000000002";
const idempotencyKey = `tax-workpaper-integration-${ids.organization}`;

runDatabaseTests("tax filing workpaper application-role boundary", () => {
  const owner = new Pool({ connectionString: ownerUrl });
  const app = new Pool({ connectionString: appUrl });

  async function asSession<T>(input: Readonly<{
    requestId: string;
    reason: string;
  }>, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [ids.organization]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [ids.actor]);
      await client.query("SELECT set_config('app.session_mode', 'real', true)");
      await client.query("SELECT set_config('app.auth_method', 'oidc', true)");
      await client.query("SELECT set_config('app.request_id', $1, true)", [input.requestId]);
      await client.query("SELECT set_config('app.reason', $1, true)", [input.reason]);
      await client.query("SELECT set_config('app.source_surface', 'MCP', true)");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertFiling(
    client: PoolClient,
    filingId: string,
    mappingVersion: number,
  ) {
    return client.query(
      `INSERT INTO tax_filings(
         id, organization_id, legal_entity_id, ledger_id, template_id,
         mapping_set_id, configuration_id, configuration_version,
         filing_type, status, period_start, period_end,
         reported_values, calculated_values, reconciliation_snapshot,
         validation_snapshot, template_snapshot, idempotency_key,
         command_hash, created_by
       )
       SELECT $1,$2,$3,$4,template.id,$5,$6,1,'PREPARED','READY',
         '2025-01-01'::date,'2025-12-31'::date,
         '{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,
         jsonb_build_object(
           'id', template.id,
           'version', template.version,
           'mappingSetId', $5::uuid,
           'mappingVersion', $7::integer,
           'configurationId', $6::uuid,
           'configurationVersion', 1,
           'sourceDigest', template.source_digest,
           'definition', template.definition
         ),
         $8,$9,$10
       FROM tax_filing_templates template
       WHERE template.id=$11`,
      [filingId, ids.organization, ids.entity, ids.ledger, ids.mappingSet,
        ids.configuration, mappingVersion, idempotencyKey, "b".repeat(64), ids.actor, templateId],
    );
  }

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO organizations(
         id, slug, display_name, active, is_demo, organization_mode, writes_enabled_at
       ) VALUES ($1,$2,'Tax workpaper integration',true,false,'REAL',now())`,
      [ids.organization, `tax-workpaper-${ids.organization.slice(0, 12)}`],
    );
    await owner.query(
      `INSERT INTO users(id, email_lookup_hash, email_ciphertext, password_hash, active)
       VALUES ($1,$2,'encrypted-tax-workpaper-owner','password-hash',true)`,
      [ids.actor, `tax-workpaper-owner-${ids.actor}`],
    );
    await owner.query(
      `INSERT INTO organization_memberships(id, organization_id, user_id, active)
       VALUES ($1,$2,$3,true)`,
      [ids.membership, ids.organization, ids.actor],
    );
    await owner.query(
      `INSERT INTO roles(id, organization_id, key, display_name, system_template)
       VALUES ($1,$2,'TAX_WORKPAPER_TEST','Tax workpaper test',false)`,
      [ids.role, ids.organization],
    );
    await owner.query(
      `INSERT INTO role_permissions(organization_id, role_id, permission_key)
       VALUES ($1,$2,'tax.filings.prepare'),($1,$2,'tax.mappings.manage'),
         ($1,$2,'tax.filing.configuration.manage')`,
      [ids.organization, ids.role],
    );
    await owner.query(
      `INSERT INTO membership_roles(organization_id, membership_id, role_id, assigned_by)
       VALUES ($1,$2,$3,$4)`,
      [ids.organization, ids.membership, ids.role, ids.actor],
    );
    await owner.query(
      `INSERT INTO legal_entities(
         id, organization_id, code, display_name, country_code, region_code, active
       ) VALUES ($1,$2,'TAX-WP','Tax workpaper entity','CA','ON',true)`,
      [ids.entity, ids.organization],
    );
    await owner.query(
      `INSERT INTO ledgers(
         id, organization_id, legal_entity_id, code, display_name, kind,
         accounting_profile, functional_currency, active
       ) VALUES ($1,$2,$3,'TAX-WP','Tax workpaper ledger','PRIMARY',
         'CAN_ASPE','CAD',true)`,
      [ids.ledger, ids.organization, ids.entity],
    );
    await owner.query(
      `INSERT INTO entity_tax_registrations(
         id,organization_id,legal_entity_id,regime_key,destination_country,
         destination_region,registration_ciphertext,key_version,valid_from,valid_to
       ) VALUES ($1,$2,$3,'ca.on.hst','CA','ON','encrypted-test-registration','1','2025-01-01',NULL)`,
      [ids.registration, ids.organization, ids.entity],
    );
    await owner.query(
      `INSERT INTO gl_accounts(
         id, organization_id, ledger_id, code, display_name, class,
         control_kind, postable, active, valid_from
       ) VALUES
         ($1,$4,$5,'4100','Mapped revenue','REVENUE','NONE',true,true,'2025-01-01'),
         ($2,$4,$5,'2200','Mapped HST payable','LIABILITY','NONE',true,true,'2025-01-01'),
         ($3,$4,$5,'6200','Mapped input tax','EXPENSE','NONE',true,true,'2025-01-01')`,
      [...ids.accounts, ids.organization, ids.ledger],
    );

    await asSession({
      requestId: `tax-mapping-fixture-${ids.organization}`,
      reason: "Create tax workpaper integration mapping",
    }, async (client) => {
      await client.query(
        `INSERT INTO tax_account_mapping_sets(
           id, organization_id, legal_entity_id, ledger_id, template_id,
           version, state, effective_from, effective_to,
           supersedes_mapping_set_id, reason, idempotency_key,
           command_hash, created_by
         ) VALUES ($1,$2,$3,$4,$5,1,'ACTIVE','2025-01-01',NULL,NULL,
           'Create tax workpaper integration mapping',$6,$7,$8)`,
        [ids.mappingSet, ids.organization, ids.entity, ids.ledger, templateId,
          `tax-mapping-integration-${ids.organization}`, "a".repeat(64), ids.actor],
      );
      await client.query(
        `INSERT INTO tax_account_mapping_lines(
           organization_id, mapping_set_id, field_key, gl_account_id,
           balance_basis, multiplier
         ) VALUES
           ($1,$2,'line_101',$3,'NET_CREDIT',1),
           ($1,$2,'line_103',$4,'NET_CREDIT',1),
           ($1,$2,'line_106',$5,'NET_DEBIT',1)`,
        [ids.organization, ids.mappingSet, ...ids.accounts],
      );
      await client.query(
        `INSERT INTO tax_filing_configurations(
           id,organization_id,legal_entity_id,ledger_id,registration_id,filing_type_key,
           template_id,mapping_set_id,version,state,effective_from,effective_to,
           supersedes_configuration_id,reason,idempotency_key,command_hash,created_by
         ) VALUES ($1,$2,$3,$4,$5,'ca.gst-hst.return',$6,$7,1,'ACTIVE',
           '2025-04-01',NULL,NULL,'Create exact filing configuration for integration coverage',
           $8,$9,$10)`,
        [ids.configuration, ids.organization, ids.entity, ids.ledger, ids.registration,
          templateId, ids.mappingSet, `tax-configuration-integration-${ids.organization}`,
          "c".repeat(64), ids.actor],
      );
    });
  });

  afterAll(async () => {
    // Keep append-only audit fixtures until the disposable test database is destroyed.
    await Promise.all([owner.end(), app.end()]);
  });

  it("rolls back a rejected snapshot and accepts the same idempotency key on retry", async () => {
    await expect(asSession({
      requestId: `tax-workpaper-rejected-${ids.organization}`,
      reason: "Reject an invalid workpaper lineage snapshot",
    }, (client) => insertFiling(client, ids.failedFiling, 999)))
      .rejects.toMatchObject({ code: "23514" });

    const afterFailure = await owner.query<{ filings: string; audits: string }>(
      `SELECT
         (SELECT count(*)::text FROM tax_filings
           WHERE organization_id=$1 AND idempotency_key=$2) AS filings,
         (SELECT count(*)::text FROM audit_events
           WHERE organization_id=$1 AND entity_id=$3) AS audits`,
      [ids.organization, idempotencyKey, ids.failedFiling],
    );
    expect(afterFailure.rows[0]).toEqual({ filings: "0", audits: "0" });

    await asSession({
      requestId: `tax-workpaper-created-${ids.organization}`,
      reason: "Create the valid tax workpaper after rollback",
    }, (client) => insertFiling(client, ids.filing, 1));

    const accepted = await owner.query<{
      filing_type: string;
      status: string;
      mapping_version: number;
      filings: string;
      audits: string;
    }>(
      `SELECT filing.filing_type, filing.status,
         (filing.template_snapshot ->> 'mappingVersion')::integer AS mapping_version,
         (SELECT count(*)::text FROM tax_filings duplicate
           WHERE duplicate.organization_id=filing.organization_id
             AND duplicate.idempotency_key=filing.idempotency_key) AS filings,
         (SELECT count(*)::text FROM audit_events audit
           WHERE audit.organization_id=filing.organization_id
             AND audit.action='tax.filing.prepared'
             AND audit.entity_id=filing.id::text) AS audits
       FROM tax_filings filing
       WHERE filing.organization_id=$1 AND filing.id=$2`,
      [ids.organization, ids.filing],
    );
    expect(accepted.rows[0]).toEqual({
      filing_type: "PREPARED",
      status: "READY",
      mapping_version: 1,
      filings: "1",
      audits: "1",
    });

    await expect(asSession({
      requestId: `tax-workpaper-duplicate-${ids.organization}`,
      reason: "Prove the idempotency uniqueness boundary",
    }, (client) => insertFiling(client, randomUUID(), 1)))
      .rejects.toMatchObject({ code: "23505" });
  });
});
