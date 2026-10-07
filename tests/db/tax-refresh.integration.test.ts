import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import type { SessionPrincipal } from "@/modules/identity/session";
import { saveTaxAccountMappings, saveTaxFilingConfiguration, createTaxFiling, setTaxFilingCanonical, transitionTaxFilingLifecycle } from "@/modules/tax/filing-service";
import { loadTaxFilingWorkspace, previewTaxFilingReadiness } from "@/modules/tax/filing-workspace";
import { createManualJournal } from "@/modules/ledger/journal-service";
import { postJournal } from "@/modules/ledger/posting-service";

const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const id = { org: randomUUID(), actor: randomUUID(), member: randomUUID(), role: randomUUID(),
  entity: randomUUID(), ledger: randomUUID(), period: randomUUID(),
  revenue: randomUUID(), expense: randomUUID(), cash: randomUUID(),
  expenseCombination: randomUUID(), cashCombination: randomUUID(), outsider: randomUUID() };
const templateId = "f2000000-0000-4000-8000-000000000002";
const scope = { legalEntityId: id.entity, ledgerId: id.ledger, templateId };
const period = { periodStart: "2025-01-01", periodEnd: "2025-12-31" };
const principal: SessionPrincipal = { sessionId: randomUUID(), userId: id.actor, organizationId: id.org,
  membershipId: id.member, organizationName: "Synthetic tax regressions", roleLabel: "Test tax role",
  displayName: "Synthetic actor", initials: "ST", sessionMode: "real", authMethod: "OIDC",
  expiresAt: new Date(Date.now() + 3600000), mfaVerifiedAt: null, stepUpExpiresAt: null, organizationWritesEnabled: true };
const mappingLine = (glAccountId: string) => ({ fieldKey: "wp_book_net_income", glAccountId, balanceBasis: "NET_CREDIT" as const, multiplier: "1.000000" });
const commandContext = () => ({ principal, requestId: randomUUID(), sourceSurface: "MCP" as const });

run("committed tax mapping → configuration → immutable comparison refresh", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const app = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL });
  let v1: Awaited<ReturnType<typeof saveTaxAccountMappings>>;
  let original: Awaited<ReturnType<typeof createTaxFiling>>;
  let originalSnapshot: unknown;
  let refreshedFilingId: string;

  async function transaction(work: (client: PoolClient) => Promise<unknown>) {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.auth_method','oidc',true),set_config('app.session_mode','real',true),set_config('app.source_surface','MCP',true),set_config('app.request_id',$3,true),set_config('app.reason','Synthetic deferred mapping regression',true)", [id.org, id.actor, randomUUID()]);
      await work(client);
      await client.query("COMMIT"); // The regression must reach the deferred constraint.
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", process.env.TEST_APP_DATABASE_URL!);
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    await closeDatabasePool();
    await owner.query("INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES($1,$2,'Synthetic tax regression',true,false,'REAL',now())", [id.org, `tax-refresh-${id.org}`]);
    for (const actor of [id.actor, id.outsider]) await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES($1,$2,'synthetic-encrypted','synthetic-hash',true)", [actor, `tax-refresh-${actor}`]);
    await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,true)", [id.member, id.org, id.actor]);
    await owner.query("INSERT INTO roles(id,organization_id,key,display_name,system_template) VALUES($1,$2,'TAX_REFRESH_TEST','Synthetic tax role',false)", [id.role, id.org]);
    await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,unnest($3::text[])", [id.org, id.role, ["tax.read", "tax.mappings.manage", "tax.filings.prepare", "tax.filing.configuration.manage", "ledger.journal.draft", "ledger.journal.post"]]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)", [id.org, id.member, id.role, id.actor]);
    await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code) VALUES($1,$2,'TAX','Synthetic entity','CA','ON')", [id.entity, id.org]);
    await owner.query("INSERT INTO ledgers(id,organization_id,legal_entity_id,code,display_name,kind,accounting_profile,functional_currency) VALUES($1,$2,$3,'PRIMARY','Synthetic ledger','PRIMARY','CAN_ASPE','CAD')", [id.ledger, id.org, id.entity]);
    await owner.query("INSERT INTO fiscal_periods(id,organization_id,ledger_id,fiscal_year,period_number,label,starts_on,ends_on) VALUES($1,$2,$3,2025,12,'Synthetic annual period','2025-01-01','2025-12-31')", [id.period, id.org, id.ledger]);
    await owner.query(`INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES
      ($1,$4,$5,'4100','Synthetic revenue','REVENUE','NONE',true,true,'2025-01-01'),
      ($2,$4,$5,'6200','New expense','EXPENSE','NONE',true,true,'2025-01-01'),
      ($3,$4,$5,'1000','Synthetic cash','ASSET','NONE',true,true,'2025-01-01')`, [id.revenue, id.expense, id.cash, id.org, id.ledger]);
    await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$3,$4,$5,$6),($2,$3,$4,$5,$7)", [id.expenseCombination, id.cashCombination, id.org, id.ledger, id.entity, id.expense, id.cash]);
    v1 = await saveTaxAccountMappings({ ...commandContext(), ...scope, expectedTemplateVersion: 2, expectedMappingVersion: 0,
      effectiveFrom: "2025-01-01", mappings: [mappingLine(id.revenue)], reason: "Initial synthetic mapping", idempotencyKey: randomUUID() });
    const configuration = await saveTaxFilingConfiguration({ ...commandContext(), ...scope, mappingSetId: v1.mappingSetId,
      filingTypeKey: "ca.t2.corporation-income-tax", expectedConfigurationVersion: 0, effectiveFrom: "2025-01-01", reason: "Initial synthetic configuration", idempotencyKey: randomUUID() });
    original = await createTaxFiling({ ...commandContext(), ...scope, ...period, configurationId: configuration.configurationId,
      filingType: "HISTORICAL_IMPORT", externalReference: "Synthetic original return", sourceFileName: "synthetic.csv",
      reportedValues: { line_300: "0" }, manualValues: { wp_schedule_1_additions: "0", wp_schedule_1_deductions: "3.25" }, idempotencyKey: randomUUID() });
    originalSnapshot = (await owner.query("SELECT to_jsonb(filing) AS data FROM tax_filings filing WHERE id=$1", [original.filingId])).rows[0].data;
  }, 30000);

  afterAll(async () => { await closeDatabasePool(); await Promise.all([owner.end(), app.end()]); vi.unstubAllEnvs(); });

  it("detects a later posted expense, blocks incomplete coverage, commits v2 and refreshes without rewriting history", async () => {
    const context = { organizationId: id.org, actorId: id.actor, requestId: randomUUID(), authMethod: "oidc", sourceSurface: "API" as const };
    const draft = await createManualJournal({ context, legalEntityId: id.entity, ledgerId: id.ledger,
      periodId: id.period, accountingDate: "2025-12-15", purpose: "ROUTINE", description: "Synthetic late expense",
      idempotencyKey: randomUUID(), lines: [
        { accountCombinationId: id.expenseCombination, debitFunctional: "125.50", creditFunctional: "0", debitTransaction: "125.50", creditTransaction: "0", transactionCurrency: "CAD", fxRate: "1", fxRateSource: "functional", fxRateEffectiveAt: "2025-12-15T00:00:00Z" },
        { accountCombinationId: id.cashCombination, debitFunctional: "0", creditFunctional: "125.50", debitTransaction: "0", creditTransaction: "125.50", transactionCurrency: "CAD", fxRate: "1", fxRateSource: "functional", fxRateEffectiveAt: "2025-12-15T00:00:00Z" },
      ] });
    await postJournal({ context: { ...context, requestId: randomUUID() }, journalId: draft.journalId });
    const missing = await previewTaxFilingReadiness(principal, { ...scope, ...period });
    expect(missing.coverage).toMatchObject({ omittedNetIncome: "-125.500000000", currentBookNetIncome: "-125.500000000" });
    expect(missing.coverage.unmappedAccounts).toEqual([expect.objectContaining({ id: id.expense, hasActivity: true })]);
    expect(missing.blockers.map((blocker) => blocker.code)).toContain("MAPPING_COVERAGE_INCOMPLETE");
    const stale = (await loadTaxFilingWorkspace(principal)).filings.find((filing) => filing.id === original.filingId)!;
    expect(stale.freshness.mayBeStale).toBe(true);
    expect(stale.manualValues).toEqual({ wp_schedule_1_additions: "0", wp_schedule_1_deductions: "3.25" });
    expect(stale.reportedValues).toEqual({ line_300: "0" });
    const refresh = { ...commandContext(), ...scope, ...period, refreshFromFilingId: original.filingId,
      filingType: "HISTORICAL_IMPORT" as const, externalReference: stale.externalReference!, sourceFileName: stale.sourceFileName!,
      manualValues: stale.manualValues, reportedValues: stale.reportedValues, idempotencyKey: randomUUID() };
    await expect(createTaxFiling(refresh)).rejects.toMatchObject({ code: "MAPPING_COVERAGE_INCOMPLETE" });
    const mappingCommand = { ...commandContext(), ...scope, expectedTemplateVersion: 2, expectedMappingVersion: 1,
      effectiveFrom: "2025-01-02", mappings: [mappingLine(id.revenue), mappingLine(id.expense)], reason: "Include newly posted expense", idempotencyKey: randomUUID() };
    await expect(saveTaxAccountMappings({ ...mappingCommand, effectiveFrom: "2025-01-01" })).rejects.toMatchObject({ code: "MAPPING_EFFECTIVE_DATE_INVALID" });
    const v2 = await saveTaxAccountMappings(mappingCommand);
    expect(v2.version).toBe(2);
    expect(await saveTaxAccountMappings(mappingCommand)).toMatchObject({ mappingSetId: v2.mappingSetId, idempotentReplay: true });
    await expect(saveTaxAccountMappings({ ...mappingCommand, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "MAPPING_VERSION_CONFLICT" });
    await expect(saveTaxAccountMappings({ ...mappingCommand, reason: "Changed replay request" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await owner.query("SELECT count(*)::int AS n FROM tax_account_mapping_lines WHERE mapping_set_id=$1", [v1.mappingSetId])).rows[0].n).toBe(1);
    await expect(createTaxFiling(refresh)).rejects.toMatchObject({ code: "CONFIGURATION_MAPPING_OUTDATED" });
    const configCommand = { ...commandContext(), ...scope, mappingSetId: v2.mappingSetId, filingTypeKey: "ca.t2.corporation-income-tax",
      expectedConfigurationVersion: 1, effectiveFrom: "2025-01-02", reason: "Activate reviewed expense mapping", idempotencyKey: randomUUID() };
    await expect(saveTaxFilingConfiguration({ ...configCommand, principal: { ...principal, userId: id.outsider } })).rejects.toThrow(/permission|authorized/i);
    const configuration = await saveTaxFilingConfiguration(configCommand);
    expect(configuration.version).toBe(2);
    expect(await saveTaxFilingConfiguration(configCommand)).toMatchObject({ configurationId: configuration.configurationId, idempotentReplay: true });
    await expect(saveTaxFilingConfiguration({ ...configCommand, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "CONFIGURATION_VERSION_CONFLICT" });
    const updated = await createTaxFiling({ ...refresh, configurationId: configuration.configurationId });
    refreshedFilingId = updated.filingId;
    expect(updated.filingId).not.toBe(original.filingId);
    expect(await createTaxFiling({ ...refresh, configurationId: configuration.configurationId })).toMatchObject({ filingId: updated.filingId, idempotentReplay: true });
    const saved = (await owner.query("SELECT calculated_values,template_snapshot,reported_values FROM tax_filings WHERE id=$1", [updated.filingId])).rows[0];
    expect(saved.calculated_values.wp_book_net_income).toBe("-125.50");
    expect(saved.reported_values).toEqual({ line_300: "0" });
    expect(saved.template_snapshot).toMatchObject({ mappingVersion: 2, configurationVersion: 2,
      manualValues: stale.manualValues, refreshedFromFilingId: original.filingId });
    expect((await owner.query("SELECT to_jsonb(filing) AS data FROM tax_filings filing WHERE id=$1", [original.filingId])).rows[0].data).toEqual(originalSnapshot);
    const workspace = await loadTaxFilingWorkspace(principal);
    expect(workspace.filings.find((filing) => filing.id === updated.filingId)?.freshness.mayBeStale).toBe(false);
    expect(workspace.canManageConfigurations).toBe(true);
    expect(workspace.canManageCanonical).toBe(false);
    await expect(setTaxFilingCanonical({ ...commandContext(), filingId: updated.filingId, expectedSelectionVersion: 0, reason: "No canonical permission granted", idempotencyKey: randomUUID() })).rejects.toThrow(/permission|authorized/i);
    expect((await owner.query("SELECT count(*)::int AS n FROM tax_filing_canonical_selections WHERE organization_id=$1", [id.org])).rows[0].n).toBe(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE organization_id=$1 AND action='tax.filing.configuration-version-created'", [id.org])).rows[0].n).toBe(2);
  }, 30000);

  it("keeps canonical and lifecycle writes independently authorized and usable with append-only grants", async () => {
    // This explicit grant is confined to the synthetic role; no production role is changed.
    await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,'tax.filing.canonical.manage')", [id.org,id.role]);
    const selection = { ...commandContext(), filingId: refreshedFilingId, expectedSelectionVersion: 0,
      reason: "Explicitly select reviewed synthetic comparison", idempotencyKey: randomUUID() };
    const selected = await setTaxFilingCanonical(selection);
    expect(selected.version).toBe(1);
    expect(await setTaxFilingCanonical(selection)).toMatchObject({ selectionId: selected.selectionId, idempotentReplay: true });
    const lifecycle = { ...commandContext(), filingId: original.filingId, expectedLifecycleVersion: 1,
      state: "SUPERSEDED" as const, replacementFilingId: refreshedFilingId,
      reason: "Retain original synthetic comparison with replacement", idempotencyKey: randomUUID() };
    const changed = await transitionTaxFilingLifecycle(lifecycle);
    expect(changed.version).toBe(2);
    expect(await transitionTaxFilingLifecycle(lifecycle)).toMatchObject({ lifecycleEventId: changed.lifecycleEventId, idempotentReplay: true });
    await expect(transitionTaxFilingLifecycle({ ...lifecycle, filingId: refreshedFilingId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "CANONICAL_DEPENDENCY" });
    const privileges = (await owner.query("SELECT has_table_privilege('business_finlynq_app','tax_filing_configurations','UPDATE') AS config, has_table_privilege('business_finlynq_app','tax_filing_canonical_selections','UPDATE') AS canonical, has_table_privilege('business_finlynq_app','tax_filing_lifecycle_events','UPDATE') AS lifecycle")).rows[0];
    expect(privileges).toEqual({ config: false, canonical: false, lifecycle: false });
  });

  it("rejects out-of-scope references and competing mapping successors", async () => {
    await expect(saveTaxFilingConfiguration({ ...commandContext(), ...scope, mappingSetId: randomUUID(),
      filingTypeKey: "ca.t2.corporation-income-tax", expectedConfigurationVersion: 2, effectiveFrom: "2025-01-03",
      reason: "Synthetic foreign mapping pointer", idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "CONFIGURATION_MAPPING_STALE" });
    await expect(createTaxFiling({ ...commandContext(), ...scope, ...period, refreshFromFilingId: randomUUID(),
      filingType: "HISTORICAL_IMPORT", externalReference: "Foreign comparison", reportedValues: { line_300: "0" },
      idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "REFRESH_SCOPE_MISMATCH" });
    const command = { ...commandContext(), ...scope, expectedTemplateVersion: 2, expectedMappingVersion: 2,
      effectiveFrom: "2026-01-01", mappings: [mappingLine(id.revenue), mappingLine(id.expense)], reason: "Competing future synthetic revision" };
    const results = await Promise.allSettled([1,2].map(() => saveTaxAccountMappings({ ...command, requestId: randomUUID(), idempotencyKey: randomUUID() })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "MAPPING_VERSION_CONFLICT" });
    // The later mapping is not yet effective for the original 2025 period.
    expect((await previewTaxFilingReadiness(principal, { ...scope, ...period })).ready).toBe(true);
  });

  it("rolls back mapping headers and lines when the deferred guard rejects a bad date or scope", async () => {
    const current = (await owner.query("SELECT id,version FROM tax_account_mapping_sets WHERE organization_id=$1 ORDER BY version DESC LIMIT 1", [id.org])).rows[0];
    for (const predecessor of [current.id, randomUUID()]) {
      const failedId = randomUUID();
      await expect(transaction(async (client) => {
        await client.query(`INSERT INTO tax_account_mapping_sets(id,organization_id,legal_entity_id,ledger_id,template_id,version,state,effective_from,supersedes_mapping_set_id,reason,idempotency_key,command_hash,created_by)
          VALUES($1,$2,$3,$4,$5,$6,'ACTIVE','2025-01-01',$7,'Synthetic rejected revision',$8,$9,$10)`,
        [failedId,id.org,id.entity,id.ledger,templateId,current.version+1,predecessor,randomUUID(),"d".repeat(64),id.actor]);
        await client.query("INSERT INTO tax_account_mapping_lines(organization_id,mapping_set_id,field_key,gl_account_id,balance_basis,multiplier) VALUES($1,$2,'wp_book_net_income',$3,'NET_CREDIT',1)", [id.org,failedId,id.revenue]);
      })).rejects.toMatchObject({ code: expect.stringMatching(/23514|23503/) });
      expect((await owner.query("SELECT count(*)::int AS n FROM tax_account_mapping_sets WHERE id=$1", [failedId])).rows[0].n).toBe(0);
      expect((await owner.query("SELECT count(*)::int AS n FROM tax_account_mapping_lines WHERE mapping_set_id=$1", [failedId])).rows[0].n).toBe(0);
    }
  });
});
