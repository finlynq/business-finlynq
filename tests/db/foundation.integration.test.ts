import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import { postJournal } from "@/modules/ledger/posting-service";

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminConnectionString =
  databaseUrl ?? "postgresql://invalid:invalid@127.0.0.1:1/invalid";
const runtimeConnectionUrl = new URL(adminConnectionString);
runtimeConnectionUrl.username = "business_finlynq_test_runtime";
runtimeConnectionUrl.password = "runtime-test-only";
const runDatabaseTests = databaseUrl ? describe : describe.skip;

const ids = {
  orgA: "11111111-1111-4111-8111-111111111111",
  orgB: "22222222-2222-4222-8222-222222222222",
  entity: "33333333-3333-4333-8333-333333333333",
  ledger: "44444444-4444-4444-8444-444444444444",
  period: "55555555-5555-4555-8555-555555555555",
  debitAccount: "66666666-6666-4666-8666-666666666661",
  creditAccount: "66666666-6666-4666-8666-666666666662",
  debitCombination: "77777777-7777-4777-8777-777777777771",
  creditCombination: "77777777-7777-4777-8777-777777777772",
  journalType: "88888888-8888-4888-8888-888888888888",
  postedJournal: "99999999-9999-4999-8999-999999999991",
  closedJournal: "99999999-9999-4999-8999-999999999992",
  fxJournal: "99999999-9999-4999-8999-999999999993",
  actor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  membership: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  postingRole: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  keyVersion: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  unauthorizedActor: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};

const previousWritesSetting = process.env.BUSINESS_WRITES_ENABLED;

runDatabaseTests("PostgreSQL accounting controls", () => {
  const adminPool = new Pool({ connectionString: adminConnectionString });
  let runtimePool: Pool;

  async function asTenant<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [ids.orgA]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [ids.actor]);
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

  beforeAll(async () => {
    const admin = await adminPool.connect();
    try {
      await admin.query(
        `DO $role$
         BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'business_finlynq_test_runtime') THEN
             CREATE ROLE business_finlynq_test_runtime LOGIN PASSWORD 'runtime-test-only'
               NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
           ELSE
             ALTER ROLE business_finlynq_test_runtime PASSWORD 'runtime-test-only'
               NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
           END IF;
         END
         $role$`,
      );
      await admin.query(
        `DO $grant$
         BEGIN
           EXECUTE format('GRANT CONNECT ON DATABASE %I TO business_finlynq_test_runtime', current_database());
         END
         $grant$`,
      );
      await admin.query("GRANT USAGE ON SCHEMA public, app TO business_finlynq_test_runtime");
      await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO business_finlynq_test_runtime");
      await admin.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO business_finlynq_test_runtime");
      await admin.query(
        `REVOKE INSERT, UPDATE, DELETE ON audit_events, outbox_events, period_events,
           organization_key_versions FROM business_finlynq_test_runtime`,
      );
      await admin.query(
        `REVOKE UPDATE, DELETE ON source_documents, subledger_events, open_items,
           journal_entry_relations FROM business_finlynq_test_runtime`,
      );
      await admin.query(
        `REVOKE INSERT, UPDATE, DELETE ON segment_definitions, segment_values
         FROM business_finlynq_test_runtime`,
      );
      await admin.query("REVOKE ALL ON users FROM business_finlynq_test_runtime");
      await admin.query(
        "REVOKE ALL ON auth_sessions, auth_one_time_tokens, auth_rate_limits, auth_security_events FROM business_finlynq_test_runtime",
      );
      await admin.query(
        `REVOKE INSERT, UPDATE, DELETE ON organizations, organization_memberships,
           roles, membership_roles, role_permissions FROM business_finlynq_test_runtime`,
      );
      await admin.query("REVOKE DELETE ON fiscal_periods FROM business_finlynq_test_runtime");

      await admin.query(
        "INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'org-a', 'Organization A'), ($2, 'org-b', 'Organization B')",
        [ids.orgA, ids.orgB],
      );
      await admin.query(
        `INSERT INTO users (id, email_lookup_hash, email_ciphertext, password_hash)
         VALUES ($1, 'actor-email-lookup', 'encrypted-email', 'password-hash')`,
        [ids.actor],
      );
      await admin.query(
        `INSERT INTO organization_memberships (id, organization_id, user_id)
         VALUES ($1, $2, $3)`,
        [ids.membership, ids.orgA, ids.actor],
      );
      await admin.query(
        `INSERT INTO roles (id, organization_id, key, display_name)
         VALUES ($1, $2, 'ACCOUNTING_TEST', 'Accounting test role')`,
        [ids.postingRole, ids.orgA],
      );
      await admin.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission_key)
         VALUES
           ($1, $2, 'ledger.journal.post'),
           ($1, $2, 'ledger.journal.post_adjustment'),
           ($1, $2, 'ledger.journal.submit'),
           ($1, $2, 'ledger.journal.approve'),
           ($1, $2, 'ledger.period.close'),
           ($1, $2, 'ledger.period.reopen')`,
        [ids.orgA, ids.postingRole],
      );
      await admin.query(
        `INSERT INTO membership_roles (organization_id, membership_id, role_id, assigned_by)
         VALUES ($1, $2, $3, $4)`,
        [ids.orgA, ids.membership, ids.postingRole, ids.actor],
      );
      await admin.query(
        `INSERT INTO organization_key_versions
           (id, organization_id, version, key_provider, wrapped_dek)
         VALUES ($1, $2, 1, 'test-provider', 'wrapped-test-dek')`,
        [ids.keyVersion, ids.orgA],
      );
      await admin.query(
        "INSERT INTO legal_entities (id, organization_id, code, display_name, country_code, region_code) VALUES ($1, $2, 'CA01', 'Ontario Entity', 'CA', 'ON')",
        [ids.entity, ids.orgA],
      );
      await admin.query(
        "INSERT INTO ledgers (id, organization_id, legal_entity_id, code, display_name, kind, accounting_profile, functional_currency) VALUES ($1, $2, $3, 'PRIMARY', 'Primary ledger', 'PRIMARY', 'CAN_ASPE', 'CAD')",
        [ids.ledger, ids.orgA, ids.entity],
      );
      await admin.query(
        "INSERT INTO fiscal_periods (id, organization_id, ledger_id, fiscal_year, period_number, label, starts_on, ends_on) VALUES ($1, $2, $3, 2026, 8, 'August 2026', '2026-08-01', '2026-08-31')",
        [ids.period, ids.orgA, ids.ledger],
      );
      await admin.query(
        "INSERT INTO gl_accounts (id, organization_id, ledger_id, code, display_name, class, valid_from) VALUES ($1, $2, $3, '6100', 'Professional fees', 'EXPENSE', '2026-01-01'), ($4, $2, $3, '1000', 'Cash', 'ASSET', '2026-01-01')",
        [ids.debitAccount, ids.orgA, ids.ledger, ids.creditAccount],
      );
      await admin.query(
        "INSERT INTO account_combinations (id, organization_id, ledger_id, entity_id, account_id) VALUES ($1, $2, $3, $4, $5), ($6, $2, $3, $4, $7)",
        [
          ids.debitCombination,
          ids.orgA,
          ids.ledger,
          ids.entity,
          ids.debitAccount,
          ids.creditCombination,
          ids.creditAccount,
        ],
      );
      await admin.query(
        "INSERT INTO journal_type_definitions (id, key, version, owner_module, display_name, correction_route) VALUES ($1, 'ledger.manual', 1, 'ledger', 'Manual journal', '/journals')",
        [ids.journalType],
      );

      for (const [journalId, sourceKey, idempotency] of [
        [ids.postedJournal, "manual:posted", "test-posted"],
        [ids.closedJournal, "manual:closed", "test-closed"],
      ]) {
        await admin.query(
          `INSERT INTO journal_entries (
            id, organization_id, ledger_id, legal_entity_id, period_id,
            journal_type_key, journal_type_definition_id, journal_type_version,
            source_event_key, idempotency_key, origin, purpose, accounting_date,
            functional_currency, description, created_by
          ) VALUES ($1, $2, $3, $4, $5, 'ledger.manual', $6, 1, $7, $8, 'USER', 'ROUTINE', '2026-08-26', 'CAD', 'Test journal', $9)`,
          [journalId, ids.orgA, ids.ledger, ids.entity, ids.period, ids.journalType, sourceKey, idempotency, ids.actor],
        );
        await admin.query(
          `INSERT INTO journal_lines (
            organization_id, ledger_id, journal_entry_id, line_number,
            account_combination_id, debit_functional, credit_functional,
            transaction_currency, debit_transaction, credit_transaction,
            fx_rate, fx_rate_source, fx_rate_effective_at
          ) VALUES
            ($1, $2, $3, 1, $4, 100, 0, 'CAD', 100, 0, 1, 'functional', now()),
            ($1, $2, $3, 2, $5, 0, 100, 'CAD', 0, 100, 1, 'functional', now())`,
          [ids.orgA, ids.ledger, journalId, ids.debitCombination, ids.creditCombination],
        );
      }

      await admin.query(
        `INSERT INTO journal_entries (
          id, organization_id, ledger_id, legal_entity_id, period_id,
          journal_type_key, journal_type_definition_id, journal_type_version,
          source_event_key, idempotency_key, origin, purpose, accounting_date,
          functional_currency, description, created_by
        ) VALUES ($1, $2, $3, $4, $5, 'ledger.manual', $6, 1,
          'manual:rounded-fx', 'test-rounded-fx', 'USER', 'ROUTINE',
          '2026-08-26', 'CAD', 'Rounded FX journal', $7)`,
        [ids.fxJournal, ids.orgA, ids.ledger, ids.entity, ids.period, ids.journalType, ids.actor],
      );
      await admin.query(
        `INSERT INTO journal_lines (
          organization_id, ledger_id, journal_entry_id, line_number,
          account_combination_id, debit_functional, credit_functional,
          transaction_currency, debit_transaction, credit_transaction,
          fx_rate, fx_rate_source, fx_rate_effective_at
        ) VALUES
          ($1, $2, $3, 1, $4, 133.33, 0, 'USD', 100, 0, 1.333333, 'test', now()),
          ($1, $2, $3, 2, $5, 0, 133.33, 'USD', 0, 100, 1.333333, 'test', now())`,
        [ids.orgA, ids.ledger, ids.fxJournal, ids.debitCombination, ids.creditCombination],
      );
    } finally {
      admin.release();
    }

    runtimePool = new Pool({
      connectionString: runtimeConnectionUrl.toString(),
    });
    process.env.DATABASE_URL = runtimeConnectionUrl.toString();
    process.env.BUSINESS_WRITES_ENABLED = "true";
  });

  afterAll(async () => {
    await closeDatabasePool();
    await runtimePool?.end();
    await adminPool.end();
    if (previousWritesSetting === undefined) {
      delete process.env.BUSINESS_WRITES_ENABLED;
    } else {
      process.env.BUSINESS_WRITES_ENABLED = previousWritesSetting;
    }
  });

  it("posts an exact balanced journal and writes audit in the same transaction", async () => {
    const result = await postJournal({
      context: {
        organizationId: ids.orgA,
        actorId: ids.actor,
        requestId: "post-1",
        authMethod: "password+mfa",
        sourceSurface: "UI",
      },
      journalId: ids.postedJournal,
    });
    expect(result).toMatchObject({ journalNumber: 1, status: "POSTED", idempotentReplay: false });

    const eventCounts = await asTenant(async (client) =>
      client.query(
        `SELECT
           (SELECT count(*)::int FROM audit_events WHERE entity_id = $1) AS audit_count,
           (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS outbox_count`,
        [ids.postedJournal],
      ),
    );
    expect(eventCounts.rows[0]).toEqual({ audit_count: 1, outbox_count: 1 });
  });

  it("posts FX converted at the database's functional minor-unit rule", async () => {
    const result = await postJournal({
      context: {
        organizationId: ids.orgA,
        actorId: ids.actor,
        requestId: "post-rounded-fx",
        authMethod: "password+mfa",
        sourceSurface: "UI",
      },
      journalId: ids.fxJournal,
    });

    expect(result).toMatchObject({ journalNumber: 2, status: "POSTED" });
  });

  it("rejects direct posted inserts and posted-line reparenting", async () => {
    await expect(
      asTenant((client) =>
        client.query(
          `INSERT INTO journal_entries (
             organization_id, ledger_id, legal_entity_id, period_id,
             journal_type_key, journal_type_definition_id, journal_type_version,
             source_event_key, idempotency_key, origin, purpose, status,
             accounting_date, functional_currency, description, created_by
           ) VALUES (
             $1, $2, $3, $4, 'ledger.manual', $5, 1,
             'direct:posted', 'direct-posted-bypass', 'USER', 'ROUTINE', 'POSTED',
             '2026-08-26', 'CAD', 'Bypass attempt', $6
           )`,
          [ids.orgA, ids.ledger, ids.entity, ids.period, ids.journalType, ids.actor],
        ),
      ),
    ).rejects.toThrow(/clean drafts/);

    await expect(
      asTenant((client) =>
        client.query(
          `UPDATE journal_lines
           SET journal_entry_id = $1
           WHERE journal_entry_id = $2 AND line_number = 1`,
          [ids.closedJournal, ids.postedJournal],
        ),
      ),
    ).rejects.toThrow(/cannot be moved/);
  });

  it("prevents the runtime role from forging audit events or destroying wrapped keys", async () => {
    await expect(
      asTenant((client) =>
        client.query(
          `INSERT INTO audit_events (
             organization_id, actor_type, actor_id, auth_method, source_surface,
             action, entity_type, entity_id, request_id, safe_metadata, event_hash
           ) VALUES ($1, 'USER', $2, 'test', 'UI', 'forged', 'test', '1', 'forged-1', '{}', 'forged')`,
          [ids.orgA, ids.actor],
        ),
      ),
    ).rejects.toThrow(/permission denied/);

    await expect(
      asTenant((client) =>
        client.query("UPDATE organization_key_versions SET wrapped_dek = 'destroyed' WHERE id = $1", [
          ids.keyVersion,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);

    await expect(
      asTenant((client) =>
        client.query(
          "INSERT INTO roles (organization_id, key, display_name) VALUES ($1, 'escalated', 'Escalated')",
          [ids.orgA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);

    await expect(
      asTenant((client) => client.query("SELECT token_hash FROM auth_sessions LIMIT 1")),
    ).rejects.toThrow(/permission denied/);
  });

  it("resolves posting authority from active membership inside the transaction", async () => {
    await expect(
      asTenant(async (client) => {
        await client.query("SELECT set_config('app.actor_id', $1, true)", [ids.unauthorizedActor]);
        const hash = await client.query<{ content_hash: string }>(
          "SELECT app.compute_journal_content_hash($1) AS content_hash",
          [ids.closedJournal],
        );
        await client.query(
          `UPDATE journal_entries
           SET status = 'POSTED', journal_number = 91, content_hash = $1, posted_by = $2
           WHERE id = $3`,
          [hash.rows[0]?.content_hash, ids.unauthorizedActor, ids.closedJournal],
        );
      }),
    ).rejects.toThrow(/Posting permission/);
  });

  it("freezes submitted content and rejects contradictory FX", async () => {
    await asTenant((client) =>
      client.query("UPDATE journal_entries SET status = 'SUBMITTED' WHERE id = $1", [ids.closedJournal]),
    );

    await expect(
      asTenant((client) =>
        client.query(
          "UPDATE journal_lines SET memo = 'edit after submit' WHERE journal_entry_id = $1 AND line_number = 1",
          [ids.closedJournal],
        ),
      ),
    ).rejects.toThrow(/immutable/);

    await asTenant(async (client) => {
      const candidate = await client.query<{ content_hash: string; approval_version: number }>(
        `SELECT content_hash, approval_version
         FROM journal_entries
         WHERE id = $1`,
        [ids.closedJournal],
      );
      await client.query(
        `INSERT INTO journal_approvals (
           organization_id, ledger_id, journal_entry_id, journal_version,
           content_hash, decision, actor_id, reason
         ) VALUES ($1, $2, $3, $4, $5, 'APPROVED', $6, 'Integration approval')`,
        [
          ids.orgA,
          ids.ledger,
          ids.closedJournal,
          candidate.rows[0]?.approval_version,
          candidate.rows[0]?.content_hash,
          ids.actor,
        ],
      );
      await client.query(
        `UPDATE journal_entries
         SET status = 'APPROVED', approved_by = $1, approved_at = now()
         WHERE id = $2`,
        [ids.actor, ids.closedJournal],
      );
    });

    await asTenant((client) =>
      client.query("UPDATE journal_entries SET status = 'DRAFT' WHERE id = $1", [ids.closedJournal]),
    );

    await expect(
      asTenant(async (client) => {
        await client.query(
          "UPDATE journal_lines SET fx_rate = 2 WHERE journal_entry_id = $1 AND line_number = 1",
          [ids.closedJournal],
        );
        const hash = await client.query<{ content_hash: string }>(
          "SELECT app.compute_journal_content_hash($1) AS content_hash",
          [ids.closedJournal],
        );
        await client.query(
          `UPDATE journal_entries
           SET status = 'POSTED', journal_number = 92, content_hash = $1, posted_by = $2
           WHERE id = $3`,
          [hash.rows[0]?.content_hash, ids.actor, ids.closedJournal],
        );
      }),
    ).rejects.toThrow(/FX policy/);
  });

  it("blocks SQL update of posted financial history", async () => {
    await expect(
      asTenant((client) =>
        client.query("UPDATE journal_entries SET description = 'tampered' WHERE id = $1", [ids.postedJournal]),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("enforces tenant isolation for reads and writes", async () => {
    const visibleOrganizations = await asTenant((client) =>
      client.query("SELECT id FROM organizations ORDER BY id"),
    );
    expect(visibleOrganizations.rows.map((row) => row.id)).toEqual([ids.orgA]);

    await expect(
      asTenant((client) =>
        client.query(
          `INSERT INTO parties (
             organization_id, party_number, display_name_ciphertext, search_token
           ) VALUES ($1, 'P-BAD', 'encrypted', 'bad-token')`,
          [ids.orgB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("prevents overlapping fiscal periods in one ledger", async () => {
    await expect(
      asTenant((client) =>
        client.query(
          `INSERT INTO fiscal_periods (
             organization_id, ledger_id, fiscal_year, period_number, label, starts_on, ends_on
           ) VALUES ($1, $2, 2026, 9, 'Overlapping period', '2026-08-15', '2026-09-15')`,
          [ids.orgA, ids.ledger],
        ),
      ),
    ).rejects.toThrow(/fiscal_periods_no_overlapping_dates/);
  });

  it("freezes fiscal-period identity after journal use", async () => {
    await expect(
      asTenant((client) =>
        client.query("UPDATE fiscal_periods SET starts_on = '2026-07-31' WHERE id = $1", [ids.period]),
      ),
    ).rejects.toThrow(/identity and dates are immutable/);
  });

  it("blocks posting after a period hard close", async () => {
    await asTenant(async (client) => {
      await client.query("SELECT set_config('app.request_id', 'close-1', true)");
      await client.query("SELECT set_config('app.reason', 'Month-end close test', true)");
      await client.query("UPDATE fiscal_periods SET state = 'HARD_CLOSED' WHERE id = $1", [ids.period]);
    });

    await expect(
      asTenant(async (client) => {
        await client.query("SELECT set_config('app.request_id', 'post-closed-1', true)");
        await client.query(
          "UPDATE journal_entries SET status = 'POSTED', journal_number = 2, content_hash = 'hash-2', posted_by = $1 WHERE id = $2",
          [ids.actor, ids.closedJournal],
        );
      }),
    ).rejects.toThrow(/closed accounting period/);
  });

  it("requires step-up MFA and reopen permission to reopen a hard-closed period", async () => {
    await expect(
      asTenant(async (client) => {
        await client.query("SELECT set_config('app.request_id', 'reopen-no-mfa', true)");
        await client.query("SELECT set_config('app.reason', 'Reopen test without MFA', true)");
        await client.query("UPDATE fiscal_periods SET state = 'OPEN' WHERE id = $1", [ids.period]);
      }),
    ).rejects.toThrow(/step-up MFA/);

    await asTenant(async (client) => {
      await client.query("SELECT set_config('app.request_id', 'reopen-with-mfa', true)");
      await client.query("SELECT set_config('app.reason', 'Authorized reopen test', true)");
      await client.query("SELECT set_config('app.auth_method', 'password+mfa', true)");
      await client.query("UPDATE fiscal_periods SET state = 'OPEN' WHERE id = $1", [ids.period]);
    });

    const period = await asTenant((client) =>
      client.query<{ state: string; version: number }>(
        "SELECT state, version FROM fiscal_periods WHERE id = $1",
        [ids.period],
      ),
    );
    expect(period.rows[0]).toMatchObject({ state: "OPEN", version: 3 });
  });
});
