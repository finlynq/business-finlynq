import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import { createManualJournal, reversePostedJournal } from "@/modules/ledger/journal-service";
import { transitionFiscalPeriod } from "@/modules/ledger/period-service";
import { setLedgerPostingPolicy } from "@/modules/ledger/posting-policy-service";
import { postJournal } from "@/modules/ledger/posting-service";
import { onboardOrganization } from "@/modules/onboarding/organization-service";
import { createParty, searchPartiesByExactName } from "@/modules/parties/party-service";
import { LocalRootKeyProvider, serializeWrappedKey } from "@/security/organization-encryption";

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
  controlPeriod: "55555555-5555-4555-8555-555555555554",
  workflowPeriod: "55555555-5555-4555-8555-555555555553",
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
  makerActor: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
  makerMembership: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  orgBMembership: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  makerRole: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  validSession: "abababab-abab-4bab-8bab-ababababab01",
  staleSession: "abababab-abab-4bab-8bab-ababababab02",
  wrongActorSession: "abababab-abab-4bab-8bab-ababababab03",
  wrongOrgSession: "abababab-abab-4bab-8bab-ababababab04",
  forgedSession: "abababab-abab-4bab-8bab-ababababab05",
};

const previousWritesSetting = process.env.BUSINESS_WRITES_ENABLED;
const previousRootKey = process.env.ORGANIZATION_ROOT_KEK;
const previousRootKeyFile = process.env.ORGANIZATION_ROOT_KEK_FILE;
const testRootKey = Buffer.alloc(32, 17);
const testOrganizationDek = Buffer.alloc(32, 23);
const onboardingSlug = `workflow-${randomUUID().slice(0, 12)}`;

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
      await admin.query("REVOKE DELETE ON ledger_posting_policies FROM business_finlynq_test_runtime");
      await admin.query("REVOKE DELETE ON parties, party_addresses FROM business_finlynq_test_runtime");

      await admin.query(
        "INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'org-a', 'Organization A'), ($2, 'org-b', 'Organization B')",
        [ids.orgA, ids.orgB],
      );
      await admin.query(
        `INSERT INTO users (id, email_lookup_hash, email_ciphertext, password_hash)
         VALUES
           ($1, 'actor-email-lookup', 'encrypted-email', 'password-hash'),
           ($2, 'maker-email-lookup', 'encrypted-maker-email', 'password-hash')`,
        [ids.actor, ids.makerActor],
      );
      await admin.query(
        `INSERT INTO organization_memberships (id, organization_id, user_id)
         VALUES ($1, $2, $3), ($4, $2, $5), ($6, $7, $3)`,
        [
          ids.membership,
          ids.orgA,
          ids.actor,
          ids.makerMembership,
          ids.makerActor,
          ids.orgBMembership,
          ids.orgB,
        ],
      );
      await admin.query(
        `INSERT INTO auth_sessions (
           id, token_hash, user_id, organization_id, membership_id,
           auth_method, session_mode, idle_timeout_seconds,
           idle_expires_at, expires_at, mfa_verified_at, step_up_expires_at
         ) VALUES
           ($1, 'integration-valid-session', $5, $6, $7, 'PASSWORD', 'REAL', 7200,
             now() + interval '2 hours', now() + interval '24 hours', now(), now() + interval '10 minutes'),
           ($2, 'integration-stale-session', $5, $6, $7, 'PASSWORD', 'REAL', 7200,
             now() + interval '2 hours', now() + interval '24 hours', now() - interval '20 minutes', now() - interval '10 minutes'),
           ($3, 'integration-wrong-actor-session', $8, $6, $9, 'PASSWORD', 'REAL', 7200,
             now() + interval '2 hours', now() + interval '24 hours', now(), now() + interval '10 minutes'),
           ($4, 'integration-wrong-org-session', $5, $10, $11, 'PASSWORD', 'REAL', 7200,
             now() + interval '2 hours', now() + interval '24 hours', now(), now() + interval '10 minutes')`,
        [
          ids.validSession,
          ids.staleSession,
          ids.wrongActorSession,
          ids.wrongOrgSession,
          ids.actor,
          ids.orgA,
          ids.membership,
          ids.makerActor,
          ids.makerMembership,
          ids.orgB,
          ids.orgBMembership,
        ],
      );
      await admin.query(
        `INSERT INTO roles (id, organization_id, key, display_name)
         VALUES
           ($1, $2, 'ACCOUNTING_TEST', 'Accounting test role'),
           ($3, $2, 'MAKER_TEST', 'Maker test role')`,
        [ids.postingRole, ids.orgA, ids.makerRole],
      );
      await admin.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission_key)
         VALUES
           ($1, $2, 'ledger.journal.draft'),
           ($1, $2, 'ledger.journal.post'),
           ($1, $2, 'ledger.journal.post_adjustment'),
           ($1, $2, 'ledger.journal.reverse'),
           ($1, $2, 'ledger.journal.submit'),
           ($1, $2, 'ledger.journal.approve'),
           ($1, $2, 'ledger.posting_policy.manage'),
           ($1, $2, 'ledger.period.close'),
           ($1, $2, 'ledger.period.reopen'),
           ($1, $2, 'ledger.period.seal'),
           ($1, $2, 'parties.read'),
           ($1, $2, 'parties.manage'),
           ($1, $3, 'ledger.journal.draft')`,
        [ids.orgA, ids.postingRole, ids.makerRole],
      );
      await admin.query(
        `INSERT INTO membership_roles (organization_id, membership_id, role_id, assigned_by)
         VALUES ($1, $2, $3, $4), ($1, $5, $6, $4)`,
        [ids.orgA, ids.membership, ids.postingRole, ids.actor, ids.makerMembership, ids.makerRole],
      );
      const wrappedDek = new LocalRootKeyProvider(testRootKey)
        .wrapOrganizationKey(ids.orgA, 1, testOrganizationDek);
      await admin.query(
        `INSERT INTO organization_key_versions
           (id, organization_id, version, key_provider, wrapped_dek)
         VALUES ($1, $2, 1, $3, $4)`,
        [ids.keyVersion, ids.orgA, wrappedDek.provider, serializeWrappedKey(wrappedDek)],
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
        `INSERT INTO fiscal_periods (
           id, organization_id, ledger_id, fiscal_year, period_number, label, starts_on, ends_on
         ) VALUES
           ($1, $3, $4, 2026, 9, 'September 2026', '2026-09-01', '2026-09-30'),
           ($2, $3, $4, 2026, 10, 'October 2026', '2026-10-01', '2026-10-31')`,
        [ids.controlPeriod, ids.workflowPeriod, ids.orgA, ids.ledger],
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
        `INSERT INTO journal_type_definitions (id, key, version, owner_module, display_name, correction_route)
         VALUES ($1, 'ledger.manual', 1, 'ledger', 'Manual journal', '/app/journals')
         ON CONFLICT (key, version) DO UPDATE SET
           owner_module = EXCLUDED.owner_module,
           display_name = EXCLUDED.display_name,
           correction_route = EXCLUDED.correction_route`,
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
    delete process.env.ORGANIZATION_ROOT_KEK_FILE;
    process.env.ORGANIZATION_ROOT_KEK = testRootKey.toString("base64");
  });

  afterAll(async () => {
    try {
      await Promise.all([closeDatabasePool(), runtimePool?.end(), adminPool.end()]);
    } finally {
      if (previousWritesSetting === undefined) {
        delete process.env.BUSINESS_WRITES_ENABLED;
      } else {
        process.env.BUSINESS_WRITES_ENABLED = previousWritesSetting;
      }
      if (previousRootKey === undefined) delete process.env.ORGANIZATION_ROOT_KEK;
      else process.env.ORGANIZATION_ROOT_KEK = previousRootKey;
      if (previousRootKeyFile === undefined) delete process.env.ORGANIZATION_ROOT_KEK_FILE;
      else process.env.ORGANIZATION_ROOT_KEK_FILE = previousRootKeyFile;
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
           ) VALUES ($1, 'P-BAD', 'encrypted', $2)`,
          [ids.orgB, `hmac-sha256-v1:${"0".repeat(64)}`],
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
           ) VALUES ($1, $2, 2026, 11, 'Overlapping period', '2026-08-15', '2026-09-15')`,
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
      await client.query("SELECT set_config('app.request_id', 'close-adjustment-1', true)");
      await client.query("SELECT set_config('app.reason', 'Begin the month-end adjustment window', true)");
      await client.query("UPDATE fiscal_periods SET state = 'ADJUSTMENT_ONLY' WHERE id = $1", [ids.period]);
    });
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
    ).rejects.toThrow(/stepped-up session/i);

    await asTenant(async (client) => {
      await client.query("SELECT set_config('app.request_id', 'reopen-with-mfa', true)");
      await client.query("SELECT set_config('app.reason', 'Authorized reopen test', true)");
      await client.query("SELECT set_config('app.auth_method', 'password+mfa', true)");
      await client.query("SELECT set_config('app.session_id', $1, true)", [ids.validSession]);
      await client.query("UPDATE fiscal_periods SET state = 'OPEN' WHERE id = $1", [ids.period]);
    });

    const period = await asTenant((client) =>
      client.query<{ state: string; version: number }>(
        "SELECT state, version FROM fiscal_periods WHERE id = $1",
        [ids.period],
      ),
    );
    expect(period.rows[0]).toMatchObject({ state: "OPEN", version: 4 });
  });

  it("onboards a complete organization foundation idempotently", async () => {
    const input = {
      slug: onboardingSlug,
      organizationName: "Workflow Integration Company",
      entityCode: "CA99",
      entityName: "Workflow Ontario Entity",
      countryCode: "CA" as const,
      regionCode: "ON",
      functionalCurrency: "CAD" as const,
      accountingProfile: "CAN_ASPE" as const,
      fiscalYear: 2026,
    };
    const first = await onboardOrganization(adminPool, input);
    const replay = await onboardOrganization(adminPool, input);
    expect(first.created).toBe(true);
    expect(replay).toEqual({ ...first, created: false });

    const foundation = await adminPool.query<{
      active_keys: number;
      periods: number;
      accounts: number;
      roles: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM organization_key_versions WHERE organization_id = $1 AND active) AS active_keys,
         (SELECT count(*)::int FROM fiscal_periods WHERE organization_id = $1) AS periods,
         (SELECT count(*)::int FROM gl_accounts WHERE organization_id = $1) AS accounts,
         (SELECT count(*)::int FROM roles WHERE organization_id = $1 AND system_template) AS roles`,
      [first.organizationId],
    );
    expect(foundation.rows[0]).toEqual({ active_keys: 1, periods: 12, accounts: 8, roles: 5 });
  });

  it("denies cross-tenant and public-demo journal writes at the service boundary", async () => {
    const journal = {
      ledgerId: ids.ledger,
      legalEntityId: ids.entity,
      periodId: ids.workflowPeriod,
      accountingDate: "2026-10-15",
      purpose: "ROUTINE" as const,
      origin: "USER" as const,
      description: "Cross-boundary write must fail",
      idempotencyKey: "cross-boundary-write",
      lines: [
        {
          accountCombinationId: ids.debitCombination,
          debitFunctional: "10.00",
          creditFunctional: "0",
          transactionCurrency: "CAD",
          debitTransaction: "10.00",
          creditTransaction: "0",
          fxRate: "1",
          fxRateSource: "functional-currency",
          fxRateEffectiveAt: "2026-10-15T12:00:00.000Z",
        },
        {
          accountCombinationId: ids.creditCombination,
          debitFunctional: "0",
          creditFunctional: "10.00",
          transactionCurrency: "CAD",
          debitTransaction: "0",
          creditTransaction: "10.00",
          fxRate: "1",
          fxRateSource: "functional-currency",
          fxRateEffectiveAt: "2026-10-15T12:00:00.000Z",
        },
      ],
    };
    await expect(createManualJournal({
      context: {
        organizationId: ids.orgB,
        actorId: ids.actor,
        requestId: "cross-tenant-service",
        authMethod: "password",
        sourceSurface: "UI",
      },
      ...journal,
    })).rejects.toThrow(/permission|organization|ledger/i);
    await expect(createManualJournal({
      context: {
        organizationId: "10000000-0000-4000-8000-000000000001",
        actorId: "10000000-0000-4000-8000-000000000002",
        requestId: "demo-write-service",
        authMethod: "demo-link",
        sourceSurface: "UI",
      },
      ...journal,
      idempotencyKey: "demo-boundary-write",
    })).rejects.toThrow(/non-demo organization/i);
  });

  it("creates journals concurrently with bound idempotency, role-aware auto-post, and one full reversal", async () => {
    const policyContext = {
      organizationId: ids.orgA,
      actorId: ids.actor,
      requestId: "posting-policy-review",
      authMethod: "password",
      sourceSurface: "UI" as const,
    };
    expect(await setLedgerPostingPolicy({
      context: policyContext,
      ledgerId: ids.ledger,
      manualMode: "REVIEW_REQUIRED",
      expectedVersion: 0,
    })).toEqual({ ledgerId: ids.ledger, manualMode: "REVIEW_REQUIRED", version: 1 });
    await expect(asTenant((client) => client.query(
      "DELETE FROM ledger_posting_policies WHERE ledger_id = $1",
      [ids.ledger],
    ))).rejects.toThrow(/permission denied/i);
    const baseCommand = {
      ledgerId: ids.ledger,
      legalEntityId: ids.entity,
      periodId: ids.workflowPeriod,
      accountingDate: "2026-10-15",
      purpose: "ROUTINE" as const,
      origin: "USER" as const,
      description: "Concurrent exact-decimal accrual",
      idempotencyKey: "workflow-concurrent-1",
      lines: [
        {
          accountCombinationId: ids.debitCombination,
          debitFunctional: "125.25",
          creditFunctional: "0",
          transactionCurrency: "CAD",
          debitTransaction: "125.25",
          creditTransaction: "0",
          fxRate: "1",
          fxRateSource: "functional-currency",
          fxRateEffectiveAt: "2026-10-15T12:00:00.000Z",
        },
        {
          accountCombinationId: ids.creditCombination,
          debitFunctional: "0",
          creditFunctional: "125.25",
          transactionCurrency: "CAD",
          debitTransaction: "0",
          creditTransaction: "125.25",
          fxRate: "1",
          fxRateSource: "functional-currency",
          fxRateEffectiveAt: "2026-10-15T12:00:00.000Z",
        },
      ],
    };
    const results = await Promise.all(["a", "b"].map((suffix) => createManualJournal({
      context: {
        organizationId: ids.orgA,
        actorId: ids.actor,
        requestId: `concurrent-${suffix}`,
        authMethod: "password",
        sourceSurface: "UI",
      },
      ...baseCommand,
    })));
    expect(new Set(results.map((result) => result.journalId)).size).toBe(1);
    expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true]);
    await expect(createManualJournal({
      context: {
        organizationId: ids.orgA,
        actorId: ids.actor,
        requestId: "concurrent-conflict",
        authMethod: "password",
        sourceSurface: "UI",
      },
      ...baseCommand,
      description: "Different command under reused key",
    })).rejects.toThrow(/Idempotency key/i);

    expect(await setLedgerPostingPolicy({
      context: { ...policyContext, requestId: "posting-policy-auto" },
      ledgerId: ids.ledger,
      manualMode: "AUTO_POST",
      expectedVersion: 1,
    })).toEqual({ ledgerId: ids.ledger, manualMode: "AUTO_POST", version: 2 });
    await expect(setLedgerPostingPolicy({
      context: { ...policyContext, requestId: "posting-policy-stale" },
      ledgerId: ids.ledger,
      manualMode: "REVIEW_REQUIRED",
      expectedVersion: 1,
    })).rejects.toThrow(/changed after it was loaded/i);
    const posted = await createManualJournal({
      context: {
        organizationId: ids.orgA,
        actorId: ids.actor,
        requestId: "auto-post-authorized",
        authMethod: "password",
        sourceSurface: "UI",
      },
      ...baseCommand,
      description: "Authorized auto-post journal",
      idempotencyKey: "workflow-auto-post-1",
    });
    expect(posted).toMatchObject({ status: "POSTED", autoPosted: true });

    const makerDraft = await createManualJournal({
      context: {
        organizationId: ids.orgA,
        actorId: ids.makerActor,
        requestId: "auto-post-maker",
        authMethod: "password",
        sourceSurface: "UI",
      },
      ...baseCommand,
      description: "Maker remains draft under auto-post policy",
      idempotencyKey: "workflow-maker-draft-1",
    });
    expect(makerDraft).toMatchObject({ status: "DRAFT", autoPosted: false });

    const reversalCommand = {
      context: {
        organizationId: ids.orgA,
        actorId: ids.actor,
        requestId: "reversal-service-1",
        authMethod: "password" as const,
        sourceSurface: "UI" as const,
        reason: "Reverse the duplicate accrual in full",
      },
      originalJournalId: posted.journalId,
      periodId: ids.workflowPeriod,
      accountingDate: "2026-10-16",
      description: "Full reversal of duplicate accrual",
      reason: "Reverse the duplicate accrual in full",
      idempotencyKey: "workflow-reversal-1",
    };
    const reversal = await reversePostedJournal(reversalCommand);
    expect(reversal).toMatchObject({ status: "POSTED", idempotentReplay: false });
    expect(await reversePostedJournal({
      ...reversalCommand,
      context: { ...reversalCommand.context, requestId: "reversal-service-replay" },
    })).toMatchObject({ journalId: reversal.journalId, idempotentReplay: true });
    await expect(reversePostedJournal({
      ...reversalCommand,
      context: { ...reversalCommand.context, requestId: "reversal-service-conflict" },
      idempotencyKey: "workflow-reversal-conflict",
    })).rejects.toThrow(/different full reversal/i);

    const relation = await asTenant((client) => client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM journal_entry_relations
       WHERE to_journal_id = $1 AND kind = 'REVERSAL_OF'`,
      [posted.journalId],
    ));
    expect(relation.rows[0]?.count).toBe(1);
  });

  it("round-trips encrypted party master data and rejects a conflicting replay", async () => {
    const context = {
      organizationId: ids.orgA,
      actorId: ids.actor,
      requestId: "party-create-1",
      authMethod: "password",
      sourceSurface: "UI" as const,
    };
    const command = {
      context,
      partyNumber: "CUST-9001",
      displayName: "Maple Ridge Advisory",
      idempotencyKey: "party-maple-ridge-1",
      address: {
        kind: "BILLING" as const,
        line1: "100 King Street West",
        city: "Toronto",
        region: "ON",
        postalCode: "M5X 1A9",
        countryCode: "CA",
        validFrom: "2026-10-01",
      },
    };
    const created = await createParty(command);
    expect(created).toMatchObject({
      idempotentReplay: false,
      party: { partyNumber: "CUST-9001", displayName: "Maple Ridge Advisory" },
    });
    const replay = await createParty({ ...command, context: { ...context, requestId: "party-create-replay" } });
    expect(replay).toMatchObject({ idempotentReplay: true, party: { id: created.party.id } });
    await expect(createParty({
      ...command,
      context: { ...context, requestId: "party-create-conflict" },
      address: { ...command.address, city: "Ottawa" },
    })).rejects.toThrow(/different master data/i);

    const matches = await searchPartiesByExactName(
      { ...context, requestId: "party-search-1" },
      "  MAPLE   RIDGE ADVISORY ",
    );
    expect(matches).toEqual([expect.objectContaining({ id: created.party.id, displayName: "Maple Ridge Advisory" })]);
    const stored = await adminPool.query<{ display_name_ciphertext: string; ciphertext: string }>(
      `SELECT party.display_name_ciphertext, address.ciphertext
       FROM parties party
       JOIN party_addresses address ON address.party_id = party.id
       WHERE party.id = $1`,
      [created.party.id],
    );
    expect(stored.rows[0]?.display_name_ciphertext).not.toContain("Maple Ridge Advisory");
    expect(stored.rows[0]?.ciphertext).not.toContain("100 King Street West");

    await expect(asTenant((client) => client.query(
      "DELETE FROM party_addresses WHERE party_id = $1",
      [created.party.id],
    ))).rejects.toThrow(/permission denied/i);
    await expect(asTenant((client) => client.query(
      "DELETE FROM parties WHERE id = $1",
      [created.party.id],
    ))).rejects.toThrow(/permission denied/i);

    await adminPool.query("GRANT DELETE ON parties, party_addresses TO business_finlynq_test_runtime");
    try {
      await expect(asTenant((client) => client.query(
        "DELETE FROM party_addresses WHERE party_id = $1",
        [created.party.id],
      ))).rejects.toThrow(/cannot be hard-deleted/i);
      await expect(asTenant((client) => client.query(
        "DELETE FROM parties WHERE id = $1",
        [created.party.id],
      ))).rejects.toThrow(/cannot be hard-deleted/i);
    } finally {
      await adminPool.query("REVOKE DELETE ON parties, party_addresses FROM business_finlynq_test_runtime");
    }
  });

  it("transitions, reopens, and seals a period with optimistic, MFA, audit, outbox, and replay controls", async () => {
    const transition = (
      expectedVersion: number,
      toState: "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED",
      idempotencyKey: string,
      authMethod = "password",
      sessionId?: string,
    ) => transitionFiscalPeriod({
      context: {
        organizationId: ids.orgA,
        actorId: ids.actor,
        sessionId,
        requestId: `trace-${idempotencyKey}`,
        authMethod,
        sourceSurface: "UI",
        reason: `Controlled integration transition ${idempotencyKey}`,
      },
      periodId: ids.controlPeriod,
      expectedVersion,
      toState,
      idempotencyKey,
    });

    expect(await transition(1, "ADJUSTMENT_ONLY", "period-adjustment-1"))
      .toMatchObject({ state: "ADJUSTMENT_ONLY", version: 2, idempotentReplay: false });
    expect(await transition(1, "ADJUSTMENT_ONLY", "period-adjustment-1"))
      .toMatchObject({ version: 2, idempotentReplay: true });
    expect(await transition(2, "HARD_CLOSED", "period-hard-close-1"))
      .toMatchObject({ state: "HARD_CLOSED", version: 3 });
    await expect(transition(3, "OPEN", "period-reopen-without-mfa"))
      .rejects.toThrow(/stepped-up session/i);
    await expect(transition(3, "OPEN", "period-reopen-forged", "password+mfa", ids.forgedSession))
      .rejects.toThrow(/stepped-up session/i);
    await expect(transition(3, "OPEN", "period-reopen-stale", "password+mfa", ids.staleSession))
      .rejects.toThrow(/stepped-up session/i);
    await expect(transition(3, "OPEN", "period-reopen-wrong-actor", "password+mfa", ids.wrongActorSession))
      .rejects.toThrow(/stepped-up session/i);
    await expect(transition(3, "OPEN", "period-reopen-wrong-org", "password+mfa", ids.wrongOrgSession))
      .rejects.toThrow(/stepped-up session/i);
    expect(await transition(3, "OPEN", "period-reopen-mfa", "password+mfa", ids.validSession))
      .toMatchObject({ state: "OPEN", version: 4 });
    expect(await transition(4, "ADJUSTMENT_ONLY", "period-adjustment-2"))
      .toMatchObject({ version: 5 });
    expect(await transition(5, "HARD_CLOSED", "period-hard-close-2"))
      .toMatchObject({ version: 6 });
    expect(await transition(6, "SEALED", "period-seal-1", "password+mfa", ids.validSession))
      .toMatchObject({ state: "SEALED", version: 7, idempotentReplay: false });
    expect(await transition(6, "SEALED", "period-seal-1", "password+mfa", ids.validSession))
      .toMatchObject({ version: 7, idempotentReplay: true });
    await expect(transition(7, "OPEN", "period-reopen-sealed", "password+mfa", ids.validSession))
      .rejects.toThrow(/sealed period/i);

    const evidence = await asTenant((client) => client.query<{
      events: number;
      audits: number;
      outbox: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM period_events WHERE period_id = $1) AS events,
         (SELECT count(*)::int FROM audit_events WHERE entity_type = 'fiscal_period' AND entity_id = $1::text) AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE topic = 'ledger.period-transitioned' AND aggregate_id = $1::text) AS outbox`,
      [ids.controlPeriod],
    ));
    expect(evidence.rows[0]).toEqual({ events: 6, audits: 6, outbox: 6 });
  });
});
