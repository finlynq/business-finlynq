import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { Pool } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import type { SessionPrincipal } from "@/modules/identity/session";
import { createManualJournal, reversePostedJournal } from "@/modules/ledger/journal-service";
import { createAssetCategory, createAssetRecord, generateAssetScheduleJournal } from "@/modules/assets/service";
import { saveAssetTaxClassification, createAssetTaxSchedule } from "@/modules/assets/tax-depreciation-service";
import { postJournal } from "@/modules/ledger/posting-service";
import { setLedgerPostingPolicy } from "@/modules/ledger/posting-policy-service";
import { transitionFiscalPeriod } from "@/modules/ledger/period-service";
import { commandProvisionAssumptions, previewProvision, saveProvisionCalculation, commandProvisionEvent, listProvisions, type ProvisionCalculationRow } from "@/modules/tax/provision-service";
import type { ProvisionAssumptions } from "@/modules/tax/provision-model";
const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const id = { org: randomUUID(), actor: randomUUID(), member: randomUUID(), role: randomUUID(), entity: randomUUID(), ledger: randomUUID(), period: randomUUID(), revenue: randomUUID(), expense: randomUUID(), cash: randomUUID(), expenseCombination: randomUUID(), cashCombination: randomUUID(), outsider: randomUUID(), payable: randomUUID(), payableCombination: randomUUID(), revenueCombination: randomUUID() };
const principal: SessionPrincipal = { sessionId: randomUUID(), userId: id.actor, organizationId: id.org, membershipId: id.member, organizationName: "Synthetic provision", roleLabel: "Synthetic tax role", displayName: "Synthetic actor", initials: "ST", sessionMode: "real", authMethod: "OIDC", expiresAt: new Date(Date.now() + 3600000), mfaVerifiedAt: null, stepUpExpiresAt: null, organizationWritesEnabled: true };
const context = () => ({ organizationId: id.org, actorId: id.actor, sessionId: principal.sessionId, sessionMode: "real" as const, requestId: randomUUID(), authMethod: "oidc+mfa", sourceSurface: "API" as const, reason: "Synthetic provision acceptance" });
const commandContext = () => ({ principal, requestId: randomUUID(), sourceSurface: "API" as const, reason: "Synthetic provision acceptance", idempotencyKey: randomUUID() });
const payload: ProvisionAssumptions = { jurisdiction: "SYNTHETIC", province: "TEST", corporationStatus: "OTHER", eligibility: "REVIEWED_NOT_ELIGIBLE", eligibilityEvidence: "Synthetic reviewed status", incomeCategory: "GENERAL", rules: [{ component: "Synthetic tax", version: "fixture-1", effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31", legislation: "ENACTED", sources: [{ url: "https://example.org/synthetic-tax-rule", title: "Synthetic fixture, not a legal rate", accessedOn: "2025-01-01", reference: "Synthetic deterministic test rule" }], rationale: "Synthetic test rate", bands: [{ upTo: null, ratePercent: "10" }] }], lossCarryforward: "0", lossEvidence: null, credits: "0", creditEvidence: null, adjustments: [], ccaClaims: [], expenseAccountIds: [id.expense], expenseCombinationId: id.expenseCombination, payableCombinationId: id.payableCombination, journalClassifications: [], completenessEvidence: "Synthetic complete posted book coverage", rationale: "Synthetic reviewed tax assumptions" };
run("reviewed income-tax provision", () => {
    const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    let assumptionsId = "", assumptionVersion = 0, calculationVersion = 0, postedProvision = "";
    const assumptionCommand = (action: "SAVE" | "REVIEW", extra: Partial<ProvisionAssumptions> = {}) => commandProvisionAssumptions({ ...commandContext(), action, legalEntityId: id.entity, ledgerId: id.ledger, fiscalYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31", expectedVersion: assumptionVersion, payload: { ...payload, ...extra } });
    const inspect = () => previewProvision(principal, { assumptionsId, periodId: id.period, throughDate: "2025-12-31" });
    async function calculate() { const result = await saveProvisionCalculation({ ...commandContext(), assumptionsId, periodId: id.period, throughDate: "2025-12-31", expectedVersion: calculationVersion }); calculationVersion = result.calculation.version; return result.calculation; }
    const event = (calc: ProvisionCalculationRow, action: "REVIEW" | "DRAFT", version: number, key = randomUUID()) => commandProvisionEvent({ ...commandContext(), calculationId: calc.id, sourceHash: calc.source_hash, action, expectedVersion: version, idempotencyKey: key });
    async function journal(debit: string, credit: string, amount: string, post = true) { const line = (accountCombinationId: string, isDebit: boolean) => ({ accountCombinationId, debitFunctional: isDebit ? amount : "0", creditFunctional: isDebit ? "0" : amount, debitTransaction: isDebit ? amount : "0", creditTransaction: isDebit ? "0" : amount, transactionCurrency: "CAD", fxRate: "1", fxRateSource: "functional", fxRateEffectiveAt: "2025-12-15T00:00:00Z" }); const created = await createManualJournal({ context: context(), legalEntityId: id.entity, ledgerId: id.ledger, periodId: id.period, accountingDate: "2025-12-15", purpose: "ROUTINE", origin: "API", description: "Synthetic provision source", idempotencyKey: randomUUID(), lines: [line(debit, true), line(credit, false)] }); if (post)
        await postJournal({ context: context(), journalId: created.journalId }); return created.journalId; }
    beforeAll(async () => {
        vi.stubEnv("DATABASE_URL", process.env.TEST_APP_DATABASE_URL!);
        vi.stubEnv("BUSINESS_WRITES_ENABLED", "true");
        await closeDatabasePool();
        await owner.query("INSERT INTO organizations(id,slug,display_name,active,is_demo,organization_mode,writes_enabled_at) VALUES($1,$2,'Synthetic tax regression',true,false,'REAL',now())", [id.org, `tax-refresh-${id.org}`]);
        for (const actor of [id.actor, id.outsider])
            await owner.query("INSERT INTO users(id,email_lookup_hash,email_ciphertext,password_hash,active) VALUES($1,$2,'synthetic-encrypted','synthetic-hash',true)", [actor, `tax-refresh-${actor}`]);
        await owner.query("INSERT INTO organization_memberships(id,organization_id,user_id,active) VALUES($1,$2,$3,true)", [id.member, id.org, id.actor]);
        await owner.query(`INSERT INTO auth_sessions(id,token_hash,user_id,organization_id,membership_id,auth_method,session_mode,user_agent_hash,idle_timeout_seconds,idle_expires_at,expires_at,mfa_verified_at,step_up_expires_at) VALUES($1,$2,$3,$4,$5,'OIDC','REAL',repeat('u',64),7200,now()+interval '2 hours',now()+interval '24 hours',now(),now()+interval '10 minutes')`, [principal.sessionId, `provision-${principal.sessionId}`, id.actor, id.org, id.member]);
        await owner.query("INSERT INTO roles(id,organization_id,key,display_name,system_template) VALUES($1,$2,'TAX_REFRESH_TEST','Synthetic tax role',false)", [id.role, id.org]);
        await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,unnest($3::text[])", [id.org, id.role, ["organization.settings.manage", "tax.mappings.manage", "tax.read", "tax.filings.prepare", "tax.filing.configuration.manage", "ledger.journal.draft", "ledger.journal.post", "ledger.journal.reverse", "ledger.posting_policy.manage", "ledger.period.close", "ledger.period.reopen"]]);
        await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)", [id.org, id.member, id.role, id.actor]);
        await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code) VALUES($1,$2,'TAX','Synthetic entity','CA','ON')", [id.entity, id.org]);
        await owner.query("INSERT INTO ledgers(id,organization_id,legal_entity_id,code,display_name,kind,accounting_profile,functional_currency) VALUES($1,$2,$3,'PRIMARY','Synthetic ledger','PRIMARY','CAN_ASPE','CAD')", [id.ledger, id.org, id.entity]);
        await owner.query("INSERT INTO fiscal_periods(id,organization_id,ledger_id,fiscal_year,period_number,label,starts_on,ends_on) VALUES($1,$2,$3,2025,12,'Synthetic annual period','2025-01-01','2025-12-31')", [id.period, id.org, id.ledger]);
        await owner.query(`INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES
      ($1,$4,$5,'4100','Synthetic revenue','REVENUE','NONE',true,true,'2025-01-01'),
      ($2,$4,$5,'6200','New expense','EXPENSE','NONE',true,true,'2025-01-01'),
      ($3,$4,$5,'1000','Synthetic cash','ASSET','NONE',true,true,'2025-01-01')`, [id.revenue, id.expense, id.cash, id.org, id.ledger]);
        await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$3,$4,$5,$6),($2,$3,$4,$5,$7)", [id.expenseCombination, id.cashCombination, id.org, id.ledger, id.entity, id.expense, id.cash]);
        await owner.query("INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES($1,$2,$3,'2100','Synthetic tax payable','LIABILITY','NONE',true,true,'2025-01-01')", [id.payable, id.org, id.ledger]);
        await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$3,$4,$5,$6),($2,$3,$4,$5,$7)", [id.payableCombination, id.revenueCombination, id.org, id.ledger, id.entity, id.payable, id.revenue]);
    }, 30000);
    afterAll(async () => { await closeDatabasePool(); await owner.end(); vi.unstubAllEnvs(); });
    it("keeps explicit reviewed assumptions, zero evidence and immutable no-entry decisions", async () => {
        const saved = await assumptionCommand("SAVE");
        assumptionsId = saved.assumptions.id;
        assumptionVersion = saved.assumptions.version;
        expect((await inspect()).snapshot.ready).toBe(false);
        const reviewed = await assumptionCommand("REVIEW");
        assumptionsId = reviewed.assumptions.id;
        assumptionVersion = reviewed.assumptions.version;
        const preview = await inspect();
        expect(preview.snapshot).toMatchObject({ ready: true, bookPreTaxIncome: "0.00", incrementalAdjustment: "0.00" });
        const calc = await calculate();
        await event(calc, "REVIEW", 0);
        const generated = await event(calc, "DRAFT", 1);
        expect(generated.event.journal_id).toBeNull();
        expect((await event(calc, "DRAFT", 999)).event.id).toBe(generated.event.id);
        await expect(owner.query("UPDATE tax_provision_calculations SET reason='Overwrite frozen calculation' WHERE id=$1", [calc.id])).rejects.toMatchObject({ code: "23514" });
    });
    it("generates only an exact unposted adjustment under AUTO_POST and replays after posting", async () => {
        await journal(id.cashCombination, id.revenueCombination, "1000.00");
        await setLedgerPostingPolicy({ context: context(), ledgerId: id.ledger, manualMode: "AUTO_POST", expectedVersion: 0 });
        const calc = await calculate();
        expect(calc.snapshot).toMatchObject({ ready: true, bookPreTaxIncome: "1000.00", ytdCurrentTax: "100.00", incrementalAdjustment: "100.00" });
        await expect(event(calc, "DRAFT", 0)).rejects.toBeDefined();
        await event(calc, "REVIEW", 0);
        const key = randomUUID(), generated = await event(calc, "DRAFT", 1, key);
        postedProvision = generated.event.journal_id!;
        expect((await owner.query("SELECT status FROM journal_entries WHERE id=$1", [postedProvision])).rows[0].status).toBe("DRAFT");
        await expect(owner.query("UPDATE journal_lines SET memo='Changed generated line' WHERE journal_entry_id=$1", [postedProvision])).rejects.toMatchObject({ code: "23514" });
        await postJournal({ context: context(), journalId: postedProvision });
        expect((await event(calc, "DRAFT", 1, key)).event.journal_id).toBe(postedProvision);
        expect((await event(calc, "DRAFT", 1)).event.journal_id).toBe(postedProvision);
        expect((await inspect()).snapshot).toMatchObject({ bookPreTaxIncome: "1000.00", priorPostedProvision: "100.00", incrementalAdjustment: "0.00" });
    });
    it("keeps cash settlements separate from provision expense and rejects ambiguous tax expense", async () => {
        await journal(id.payableCombination, id.cashCombination, "20.00");
        const preview = await inspect();
        expect(preview.snapshot).toMatchObject({ bookPreTaxIncome: "1000.00", priorPostedProvision: "100.00", incrementalAdjustment: "0.00", liabilityRollforward: { closingCreditBalance: "80.00", unclassifiedMovementCount: 1 } });
        const prior = await journal(id.expenseCombination, id.payableCombination, "5.00");
        expect((await inspect()).snapshot.ready).toBe(false);
        const classifications: ProvisionAssumptions["journalClassifications"] = [{ journalId: prior, kind: "PRIOR_YEAR_TRUE_UP", taxYear: 2024, evidence: "Synthetic supported prior-year true-up" }];
        let saved = await assumptionCommand("SAVE", { journalClassifications: classifications });
        assumptionVersion = saved.assumptions.version;
        saved = await assumptionCommand("REVIEW", { journalClassifications: classifications });
        assumptionsId = saved.assumptions.id;
        assumptionVersion = saved.assumptions.version;
        payload.journalClassifications = classifications;
        expect((await inspect()).snapshot).toMatchObject({ ready: true, bookPreTaxIncome: "1000.00", priorPostedProvision: "100.00", incrementalAdjustment: "0.00" });
    });
    it("rejects closed-period generation, stale reviews, cross-tenant access and unauthorized actors", async () => {
        const calc = await calculate();
        await event(calc, "REVIEW", 0);
        await transitionFiscalPeriod({ context: context(), periodId: id.period, expectedVersion: 1, toState: "ADJUSTMENT_ONLY", idempotencyKey: randomUUID() });
        await transitionFiscalPeriod({ context: context(), periodId: id.period, expectedVersion: 2, toState: "HARD_CLOSED", idempotencyKey: randomUUID() });
        await expect(event(calc, "DRAFT", 1)).rejects.toMatchObject({ code: "PROVISION_REVIEW_STALE" });
        const closed = await calculate();
        await event(closed, "REVIEW", 0);
        await expect(event(closed, "DRAFT", 1)).rejects.toMatchObject({ code: "PROVISION_PERIOD_CLOSED" });
        await expect(previewProvision({ ...principal, organizationId: randomUUID() }, { assumptionsId, periodId: id.period, throughDate: "2025-12-31" })).rejects.toBeDefined();
        await expect(commandProvisionEvent({ ...commandContext(), principal: { ...principal, userId: id.outsider }, calculationId: closed.id, action: "REVIEW", expectedVersion: 1, sourceHash: closed.source_hash })).rejects.toBeDefined();
        await transitionFiscalPeriod({ context: context(), periodId: id.period, expectedVersion: 3, toState: "OPEN", idempotencyKey: randomUUID() });
    });
    it("nets a posted provision reversal and blocks stale generated journals after later book posting", async () => {
        await reversePostedJournal({ context: { ...context(), reason: "Synthetic full provision reversal" }, originalJournalId: postedProvision, periodId: id.period, accountingDate: "2025-12-20", description: "Synthetic full provision reversal", reason: "Synthetic full provision reversal", idempotencyKey: randomUUID() });
        expect((await inspect()).snapshot).toMatchObject({ ready: true, priorPostedProvision: "0.00", incrementalAdjustment: "100.00" });
        const calc = await calculate();
        await event(calc, "REVIEW", 0);
        const generated = await event(calc, "DRAFT", 1);
        await journal(id.cashCombination, id.revenueCombination, "100.00");
        await expect(postJournal({ context: context(), journalId: generated.event.journal_id! })).rejects.toThrow(/Provision sources changed/);
        const next = await calculate();
        await event(next, "REVIEW", 0);
        await expect(event(next, "DRAFT", 1)).rejects.toThrow(/outstanding provision journal/);
        expect((await listProvisions(principal)).events.some(e => e.journal_id === generated.event.journal_id && e.journal_status === "DRAFT")).toBe(true);
    });
    it("serializes competing assumption revisions and retains the exact prior history", async () => {
        const outcomes = await Promise.allSettled([assumptionCommand("SAVE"), assumptionCommand("SAVE")]);
        expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
        expect((await inspect()).snapshot.ready).toBe(false);
        await expect(owner.query("DELETE FROM tax_provision_assumptions WHERE id=$1", [assumptionsId])).rejects.toMatchObject({ code: "23514" });
    });
    it("uses the exact fiscal-year CCA line and nets posted book depreciation reversals", async () => {
        const depAccount = randomUUID(), contraAccount = randomUUID(), depCombination = randomUUID(), contraCombination = randomUUID();
        await owner.query(`INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES($1,$3,$4,'6300','Synthetic depreciation','EXPENSE','NONE',true,true,'2025-01-01'),($2,$3,$4,'1500','Synthetic accumulated depreciation','ASSET','NONE',true,true,'2025-01-01')`, [depAccount, contraAccount, id.org, id.ledger]);
        await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$3,$4,$5,$6),($2,$3,$4,$5,$7)", [depCombination, contraCombination, id.org, id.ledger, id.entity, depAccount, contraAccount]);
        const category = await createAssetCategory({ context: context(), legalEntityId: id.entity, ledgerId: id.ledger, kind: "TANGIBLE", code: "SYNCCA", displayName: "Synthetic CCA fixture", costAccountCombinationId: id.cashCombination, contraAccountCombinationId: contraCombination, expenseAccountCombinationId: depCombination, effectiveFrom: "2025-01-01", reason: "Synthetic asset category", idempotencyKey: randomUUID() });
        const asset = await createAssetRecord({ context: context(), categoryId: category.categoryId, assetNumber: "SYN-CCA", displayName: "Synthetic computer", acquisitionDate: "2025-01-01", inServiceOn: "2025-01-01", cost: "1200", usefulLifeMonths: 24, idempotencyKey: randomUUID() });
        const classification = await saveAssetTaxClassification({ context: context(), assetId: asset.assetId, expectedVersion: 0, ruleKey: "CA-CCA-CLASS-50-STANDARD", poolKey: "synthetic", availableForUseOn: "2025-01-01", businessUsePercent: "100", costBeforeSalesTax: "1200", eligibilityEvidence: "Synthetic standard-treatment fixture, not a live tax decision", reason: "Synthetic reviewed CCA classification", idempotencyKey: randomUUID() });
        const schedule = await createAssetTaxSchedule({ context: context(), classificationId: classification.classificationId, expectedScheduleVersion: 0, years: [{ taxYear: 2025, additions: "1200", claimedCca: "100" }, { taxYear: 2026, claimedCca: "200" }], idempotencyKey: randomUUID() });
        const entry = (await owner.query("SELECT id FROM asset_schedule_entries WHERE asset_id=$1 ORDER BY due_on LIMIT 1", [asset.assetId])).rows[0];
        const book = await generateAssetScheduleJournal({ context: context(), scheduleEntryId: entry.id, idempotencyKey: randomUUID() });
        await postJournal({ context: context(), journalId: book.journalId });
        assumptionVersion = Math.max(...(await listProvisions(principal)).assumptions.map(a => a.version));
        const claims = [{ scheduleId: schedule.scheduleId, claimedYtd: "80", rationale: "Synthetic reviewed YTD CCA claim" }];
        let saved = await assumptionCommand("SAVE", { ccaClaims: claims });
        assumptionVersion = saved.assumptions.version;
        saved = await assumptionCommand("REVIEW", { ccaClaims: claims });
        assumptionsId = saved.assumptions.id;
        assumptionVersion = saved.assumptions.version;
        const before = await inspect();
        expect(before.snapshot.ready).toBe(true);
        expect(before.snapshot.adjustments).toEqual(expect.arrayContaining([expect.objectContaining({ category: "BOOK_DEPRECIATION", amount: "50.000000000" }), expect.objectContaining({ category: "CCA", amount: "-80" })]));
        await reversePostedJournal({ context: { ...context(), reason: "Synthetic depreciation reversal" }, originalJournalId: book.journalId, periodId: id.period, accountingDate: "2025-12-20", description: "Synthetic depreciation reversal", reason: "Synthetic depreciation reversal", idempotencyKey: randomUUID() });
        expect((await inspect()).snapshot.adjustments).toEqual(expect.arrayContaining([expect.objectContaining({ category: "BOOK_DEPRECIATION", amount: "0.000000000" })]));
        saved = await assumptionCommand("SAVE", { ccaClaims: [{ ...claims[0]!, claimedYtd: "150" }] });
        assumptionsId = saved.assumptions.id;
        assumptionVersion = saved.assumptions.version;
        expect((await inspect()).snapshot.blockers.join(" ")).toContain("within its reviewed claim");
    });
});
