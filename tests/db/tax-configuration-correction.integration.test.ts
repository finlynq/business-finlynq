import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import type { SessionPrincipal } from "@/modules/identity/session";
import {
  correctTaxFilingConfiguration, createTaxFiling,
  previewTaxFilingConfigurationCorrection, saveTaxAccountMappings,
  saveTaxFilingConfiguration,
} from "@/modules/tax/filing-service";
import { previewTaxFilingReadiness } from "@/modules/tax/filing-workspace";

const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const id = { org: randomUUID(), actor: randomUUID(), member: randomUUID(), role: randomUUID(),
  entity: randomUUID(), ledger: randomUUID(), account: randomUUID(), period: randomUUID() };
const templateId = "f2000000-0000-4000-8000-000000000002";
const filingTypeKey = "ca.t2.corporation-income-tax";
const principal: SessionPrincipal = { sessionId: randomUUID(), userId: id.actor, organizationId: id.org,
  membershipId: id.member, organizationName: "Synthetic tax correction", roleLabel: "Test tax role",
  displayName: "Synthetic actor", initials: "ST", sessionMode: "real", authMethod: "OIDC",
  expiresAt: new Date(Date.now() + 3600000), mfaVerifiedAt: null, stepUpExpiresAt: null, organizationWritesEnabled: true };
const context = () => ({ principal, requestId: randomUUID(), sourceSurface: "MCP" as const });
const scope = { legalEntityId: id.entity, ledgerId: id.ledger, templateId };
const mappings = [{ fieldKey: "wp_book_net_income", glAccountId: id.account,
  balanceBasis: "NET_CREDIT" as const, multiplier: "1.000000" }];

run("unused committed tax configuration correction", () => {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let wrongConfigurationId: string;
  let correctedConfigurationId: string;
  let originalFilingId: string;
  let originalSnapshot: unknown;
  let mappingSetId: string;

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", process.env.TEST_APP_DATABASE_URL!);
    vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
    await closeDatabasePool();
    await owner.query("INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES($1,$2,'Synthetic tax correction',true,false,'REAL',now())", [id.org, `tax-correction-${id.org}`]);
    await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES($1,$2,'synthetic-encrypted','synthetic-hash',true)", [id.actor, `tax-correction-${id.actor}`]);
    await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,true)", [id.member, id.org, id.actor]);
    await owner.query("INSERT INTO roles(id,organization_id,key,display_name,system_template) VALUES($1,$2,'TAX_CORRECTION_TEST','Synthetic tax role',false)", [id.role, id.org]);
    await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,unnest($3::text[])", [id.org, id.role, ["tax.read", "tax.mappings.manage", "tax.filing.configuration.manage", "tax.filings.prepare"]]);
    await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)", [id.org, id.member, id.role, id.actor]);
    await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code) VALUES($1,$2,'COR','Synthetic company','CA','ON')", [id.entity, id.org]);
    await owner.query("INSERT INTO ledgers(id,organization_id,legal_entity_id,code,display_name,kind,accounting_profile,functional_currency) VALUES($1,$2,$3,'PRIMARY','Synthetic ledger','PRIMARY','CAN_ASPE','CAD')", [id.ledger, id.org, id.entity]);
    await owner.query("INSERT INTO fiscal_periods(id,organization_id,ledger_id,fiscal_year,period_number,label,starts_on,ends_on) VALUES($1,$2,$3,2025,12,'2025 reporting period','2025-01-01','2025-12-31')", [id.period, id.org, id.ledger]);
    await owner.query("INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES($1,$2,$3,'4100','Synthetic revenue','REVENUE','NONE',true,true,'2025-01-01')", [id.account, id.org, id.ledger]);
    const firstMapping = await saveTaxAccountMappings({ ...context(), ...scope, expectedTemplateVersion: 2,
      expectedMappingVersion: 0, effectiveFrom: "2025-01-01", mappings,
      reason: "Initial synthetic tax mapping", idempotencyKey: randomUUID() });
    const firstConfiguration = await saveTaxFilingConfiguration({ ...context(), ...scope,
      mappingSetId: firstMapping.mappingSetId, filingTypeKey, expectedConfigurationVersion: 0,
      effectiveFrom: "2025-01-01", reason: "Initial synthetic tax configuration", idempotencyKey: randomUUID() });
    const filing = await createTaxFiling({ ...context(), ...scope, configurationId: firstConfiguration.configurationId,
      filingType: "HISTORICAL_IMPORT", periodStart: "2025-01-01", periodEnd: "2025-12-31",
      externalReference: "Original synthetic filing", reportedValues: { line_300: "0" },
      idempotencyKey: randomUUID() });
    originalFilingId = filing.filingId;
    originalSnapshot = (await owner.query("SELECT to_jsonb(filing) AS data FROM tax_filings filing WHERE id=$1", [originalFilingId])).rows[0].data;
    const secondMapping = await saveTaxAccountMappings({ ...context(), ...scope, expectedTemplateVersion: 2,
      expectedMappingVersion: 1, effectiveFrom: "2025-01-03", mappings,
      reason: "Reviewed corrected tax mapping", idempotencyKey: randomUUID() });
    mappingSetId = secondMapping.mappingSetId;
    const wrong = await saveTaxFilingConfiguration({ ...context(), ...scope, mappingSetId,
      filingTypeKey, expectedConfigurationVersion: 1, effectiveFrom: "2026-10-14",
      reason: "Mistaken synthetic effective date", idempotencyKey: randomUUID() });
    wrongConfigurationId = wrong.configurationId;
  }, 30000);

  afterAll(async () => { await closeDatabasePool(); await owner.end(); vi.unstubAllEnvs(); });

  it("retains the wrong revision and original workpaper while resolving 2025 to an audited correction", async () => {
    const proposal = { configurationId: wrongConfigurationId, ...scope, registrationId: null,
      filingTypeKey, mappingSetId, expectedConfigurationVersion: 2, state: "ACTIVE" as const,
      effectiveFrom: "2025-01-03", effectiveTo: null,
      reason: "Correct the reviewed effective date" };
    const preview = await previewTaxFilingConfigurationCorrection(principal, proposal);
    expect(preview.eligible).toBe(true);
    expect(preview.current.effective_from).toBe("2026-10-14");
    expect(preview.references).toMatchObject({ workpaper_count: 0, successor_count: 0 });
    const command = { ...context(), proposal, previewHash: preview.previewHash, idempotencyKey: randomUUID() };
    const corrected = await correctTaxFilingConfiguration(command);
    correctedConfigurationId = corrected.configurationId;
    expect(corrected).toMatchObject({ version: 3, correctedConfigurationId: wrongConfigurationId, idempotentReplay: false });
    expect(await correctTaxFilingConfiguration(command)).toMatchObject({ configurationId: correctedConfigurationId, idempotentReplay: true });
    await expect(correctTaxFilingConfiguration({ ...command, previewHash: "f".repeat(64) })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const rows = (await owner.query("SELECT id,version,effective_from::text,correction_of_configuration_id FROM tax_filing_configurations WHERE organization_id=$1 ORDER BY version", [id.org])).rows;
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ id: wrongConfigurationId, version: 2, effective_from: "2026-10-14", correction_of_configuration_id: null });
    expect(rows[2]).toMatchObject({ id: correctedConfigurationId, version: 3, effective_from: "2025-01-03", correction_of_configuration_id: wrongConfigurationId });
    const audit = (await owner.query(
      "SELECT safe_metadata,reason FROM audit_events WHERE organization_id=$1 AND action='tax.filing.configuration-version-created' AND entity_id=$2",
      [id.org, correctedConfigurationId],
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      reason: proposal.reason,
      safe_metadata: {
        correctionOfConfigurationId: wrongConfigurationId,
        effectiveFrom: "2025-01-03",
        mappingSetId,
      },
    });
    expect((await previewTaxFilingReadiness(principal, { ...scope, periodStart: "2025-01-01", periodEnd: "2025-12-31" })).configuration?.id).toBe(correctedConfigurationId);
    expect((await owner.query("SELECT to_jsonb(filing) AS data FROM tax_filings filing WHERE id=$1", [originalFilingId])).rows[0].data).toEqual(originalSnapshot);
  }, 30000);

  it("rejects stale and referenced corrections without creating a new revision", async () => {
    const staleProposal = { configurationId: wrongConfigurationId, ...scope, registrationId: null,
      filingTypeKey, mappingSetId, expectedConfigurationVersion: 2, state: "ACTIVE" as const,
      effectiveFrom: "2025-01-03", effectiveTo: null, reason: "Attempt stale synthetic correction" };
    const stalePreview = await previewTaxFilingConfigurationCorrection(principal, staleProposal);
    expect(stalePreview.eligible).toBe(false);
    await expect(correctTaxFilingConfiguration({ ...context(), proposal: staleProposal,
      previewHash: stalePreview.previewHash, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "CONFIGURATION_VERSION_CONFLICT" });
    const filing = await createTaxFiling({ ...context(), ...scope, configurationId: correctedConfigurationId,
      filingType: "HISTORICAL_IMPORT", periodStart: "2025-01-01", periodEnd: "2025-12-31",
      externalReference: "After correction synthetic filing", reportedValues: { line_300: "0" },
      idempotencyKey: randomUUID() });
    expect(filing.configurationId).toBe(correctedConfigurationId);
    const referencedProposal = { ...staleProposal, configurationId: correctedConfigurationId,
      expectedConfigurationVersion: 3, reason: "Attempt referenced synthetic correction" };
    const preview = await previewTaxFilingConfigurationCorrection(principal, referencedProposal);
    expect(preview.eligible).toBe(false);
    await expect(correctTaxFilingConfiguration({ ...context(), proposal: referencedProposal,
      previewHash: preview.previewHash, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "CONFIGURATION_CORRECTION_REFERENCED" });
    expect((await owner.query("SELECT count(*)::int AS n FROM tax_filing_configurations WHERE organization_id=$1", [id.org])).rows[0].n).toBe(3);
  }, 30000);
});
