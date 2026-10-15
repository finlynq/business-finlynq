import {exact} from "@/kernel/money";
import { transitionFiscalPeriod } from "@/modules/ledger/period-service";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { Pool } from "pg";
import { closeDatabasePool } from "@/db/transaction";
import type { SessionPrincipal } from "@/modules/identity/session";
import { createManualJournal, reversePostedJournal } from "@/modules/ledger/journal-service";
import { postJournal } from "@/modules/ledger/posting-service";
import { createAssetCategory, createAssetRecord, generateAssetScheduleJournal } from "@/modules/assets/service";
import { defaultCloseTemplate } from "@/modules/close/checklist-model";
import { saveCloseTemplate, createCloseInstance, inspectCloseInstance, commandCloseTask, carryCloseTask, loadCloseChecklistWorkspace, configureCloseNotifications, listCloseNotifications, acknowledgeCloseNotice } from "@/modules/close/checklist-service";
const run = process.env.TEST_DATABASE_URL && process.env.TEST_APP_DATABASE_URL ? describe : describe.skip;
const id = { org: randomUUID(), actor: randomUUID(), member: randomUUID(), role: randomUUID(), entity: randomUUID(), ledger: randomUUID(), period: randomUUID(), revenue: randomUUID(), expense: randomUUID(), cash: randomUUID(), expenseCombination: randomUUID(), cashCombination: randomUUID(), outsider: randomUUID(), payable: randomUUID(), payableCombination: randomUUID(), revenueCombination: randomUUID() };
const principal: SessionPrincipal = { sessionId: randomUUID(), userId: id.actor, organizationId: id.org, membershipId: id.member, organizationName: "Synthetic provision", roleLabel: "Synthetic tax role", displayName: "Synthetic actor", initials: "ST", sessionMode: "real", authMethod: "OIDC", expiresAt: new Date(Date.now() + 3600000), mfaVerifiedAt: null, stepUpExpiresAt: null, organizationWritesEnabled: true };
const context = () => ({ organizationId: id.org, actorId: id.actor, sessionId: principal.sessionId, sessionMode: "real" as const, requestId: randomUUID(), authMethod: "oidc+mfa", sourceSurface: "API" as const, reason: "Synthetic provision acceptance" });
const commandContext = () => ({ principal, requestId: randomUUID(), sourceSurface: "API" as const, reason: "Synthetic provision acceptance", idempotencyKey: randomUUID() });
run("persistent close checklist", () => {
    const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    let instanceId = "", laterId = "", templateRevisionId = "", scheduleId = "";
    const inspect = () => inspectCloseInstance(principal, instanceId);
    const task = async (key: string) => (await inspect()).tasks.find(t => t.key === key)!;
    async function update(key: string) { const t = await task(key); return commandCloseTask({ ...commandContext(), instanceId, taskKey: key, expectedVersion: t.version, action: "UPDATE", input: { ...t.input, ownerId: id.actor, reviewerId: id.actor, status: "IN_PROGRESS", blockingReason: null, evidence: ["Synthetic source completeness review"] } }); }
    async function decide(key: string, action: "REVIEW" | "COMPLETE" | "NOT_APPLICABLE") { const t = await task(key); return commandCloseTask({ ...commandContext(), instanceId, taskKey: key, expectedVersion: t.version, sourceHash: t.sourceHash, action }); }
    async function journal(debit: string, credit: string, amount: string, post = true) {
        const line = (accountCombinationId: string, isDebit: boolean) => ({ accountCombinationId, debitFunctional: isDebit ? amount : "0", creditFunctional: isDebit ? "0" : amount, debitTransaction: isDebit ? amount : "0", creditTransaction: isDebit ? "0" : amount, transactionCurrency: "CAD", fxRate: "1", fxRateSource: "functional", fxRateEffectiveAt: "2025-09-15T00:00:00Z" });
        const created = await createManualJournal({ context: context(), legalEntityId: id.entity, ledgerId: id.ledger, periodId: id.period, accountingDate: "2025-09-15", purpose: "ROUTINE", origin: "API", description: "Synthetic provision source", idempotencyKey: randomUUID(), lines: [line(debit, true), line(credit, false)] });
        if (post)
            await postJournal({ context: context(), journalId: created.journalId });
        return created.journalId;
    }
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
        await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) SELECT $1,$2,unnest($3::text[])", [id.org, id.role, ["organization.settings.manage", "tax.mappings.manage", "tax.read", "tax.filings.prepare", "tax.filing.configuration.manage", "ledger.journal.draft", "ledger.journal.post", "ledger.journal.reverse", "ledger.posting_policy.manage", "ledger.period.close", "ledger.period.reopen", "mcp.ledger.read", "banking.read", "payables.read", "receivables.read"]]);
        await owner.query("INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by) VALUES($1,$2,$3,$4)", [id.org, id.member, id.role, id.actor]);
        await owner.query("INSERT INTO legal_entities(id,organization_id,code,display_name,country_code,region_code) VALUES($1,$2,'TAX','Synthetic entity','CA','ON')", [id.entity, id.org]);
        await owner.query("INSERT INTO ledgers(id,organization_id,legal_entity_id,code,display_name,kind,accounting_profile,functional_currency) VALUES($1,$2,$3,'PRIMARY','Synthetic ledger','PRIMARY','CAN_ASPE','CAD')", [id.ledger, id.org, id.entity]);
        await owner.query("INSERT INTO fiscal_periods(id,organization_id,ledger_id,fiscal_year,period_number,label,starts_on,ends_on) VALUES($1,$2,$3,2025,9,'September 2025','2025-09-01','2025-09-30')", [id.period, id.org, id.ledger]);
        await owner.query(`INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES
      ($1,$4,$5,'4100','Synthetic revenue','REVENUE','NONE',true,true,'2025-01-01'),
      ($2,$4,$5,'6200','New expense','EXPENSE','NONE',true,true,'2025-01-01'),
      ($3,$4,$5,'1000','Synthetic cash','ASSET','NONE',true,true,'2025-01-01')`, [id.revenue, id.expense, id.cash, id.org, id.ledger]);
        await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$3,$4,$5,$6),($2,$3,$4,$5,$7)", [id.expenseCombination, id.cashCombination, id.org, id.ledger, id.entity, id.expense, id.cash]);
        await owner.query("INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES($1,$2,$3,'2100','Synthetic tax payable','LIABILITY','NONE',true,true,'2025-01-01')", [id.payable, id.org, id.ledger]);
        await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$3,$4,$5,$6),($2,$3,$4,$5,$7)", [id.payableCombination, id.revenueCombination, id.org, id.ledger, id.entity, id.payable, id.revenue]);
    }, 30000);
    afterAll(async () => { await closeDatabasePool(); await owner.end(); vi.unstubAllEnvs(); });
    it("persists scoped immutable templates and resumes an instance without read side effects", async () => {
        const definition = { ...defaultCloseTemplate, tasks: [...defaultCloseTemplate.tasks, { key: "manual", label: "Manual source evidence", source: "MANUAL" as const, prerequisites: [], ownerId: id.actor, reviewerId: id.actor, dueOffsetDays: 5 }] };
        const saved = await saveCloseTemplate({ ...commandContext(), templateId: randomUUID(), expectedVersion: 0, definition });
        templateRevisionId = saved.template.id;
        const created = await createCloseInstance({ ...commandContext(), periodId: id.period, templateRevisionId });
        instanceId = created.instance.id;
        expect((await createCloseInstance({ ...commandContext(), periodId: id.period, templateRevisionId })).instance.id).toBe(instanceId);
        const before = (await owner.query("SELECT count(*) FROM close_task_revisions WHERE organization_id=$1", [id.org])).rows;
        const view = await inspect();
        expect(view.tasks).toHaveLength(13);
        expect(view.ready).toBe(false);
        expect(view.tasks.filter(t => !t.source.available).map(t => t.key)).toEqual([]);
        expect(view.tasks.find(t => t.key === "bank")!.source.stage).toBe("MISSING");
        expect(view.tasks.find(t => t.key === "tax-provision")!.source.stage).toBe("NOT_COMPUTED");
        expect((await listCloseNotifications(principal, instanceId)).pending).toEqual([]);
        expect((await owner.query("SELECT count(*) FROM close_task_revisions WHERE organization_id=$1", [id.org])).rows).toEqual(before);
        await expect(owner.query("UPDATE close_instances SET reason='Attempted alteration' WHERE id=$1", [instanceId])).rejects.toMatchObject({ code: "23514" });
    });
    it("shows 37.50 depreciation due, posted prepaid and uncomputed tax as distinct real source facts", async () => {
        const contraAccount = randomUUID(), contraCombination = randomUUID();
        await owner.query("INSERT INTO gl_accounts(id,organization_id,ledger_id,code,display_name,class,control_kind,postable,active,valid_from) VALUES($1,$2,$3,'1500','Synthetic contra','ASSET','NONE',true,true,'2025-01-01')", [contraAccount, id.org, id.ledger]);
        await owner.query("INSERT INTO account_combinations(id,organization_id,ledger_id,entity_id,account_id) VALUES($1,$2,$3,$4,$5)", [contraCombination, id.org, id.ledger, id.entity, contraAccount]);
        for (const kind of ["TANGIBLE", "PREPAID"] as const) {
            const cat = await createAssetCategory({ context: context(), legalEntityId: id.entity, ledgerId: id.ledger, kind, code: kind, displayName: "Synthetic close category", costAccountCombinationId: id.cashCombination, contraAccountCombinationId: kind === "TANGIBLE" ? contraCombination : undefined, expenseAccountCombinationId: id.expenseCombination, effectiveFrom: "2025-01-01", reason: "Synthetic close category", idempotencyKey: randomUUID() });
            const asset = await createAssetRecord({ context: context(), categoryId: cat.categoryId, assetNumber: kind, displayName: "Synthetic close asset", acquisitionDate: "2025-09-01", inServiceOn: "2025-09-01", cost: kind === "TANGIBLE" ? "900" : "120", scheduleEndOn: kind === "PREPAID" ? "2025-09-30" : undefined, usefulLifeMonths: kind === "TANGIBLE" ? 24 : 1, idempotencyKey: randomUUID() });
            const entry = (await owner.query("SELECT id FROM asset_schedule_entries WHERE asset_id=$1 ORDER BY due_on LIMIT 1", [asset.assetId])).rows[0];
            if (kind === "TANGIBLE")
                scheduleId = entry.id;
            else {
                const created = await generateAssetScheduleJournal({ context: context(), scheduleEntryId: entry.id, idempotencyKey: randomUUID() });
                await postJournal({ context: context(), journalId: created.journalId });
            }
        }
        const dep = await task("depreciation"), prepaid = await task("prepaids");
        expect(dep.source).toMatchObject({ available: true, ready: false, stage: "DUE" });
        expect(JSON.stringify(dep.source.evidence)).toContain("37.500");
        expect(prepaid.source).toMatchObject({ ready: true, stage: "POSTED" });
        expect((await task("tax-provision")).source.stage).toBe("NOT_COMPUTED");
        const generated = await generateAssetScheduleJournal({ context: context(), scheduleEntryId: scheduleId, idempotencyKey: randomUUID() });
        expect((await task("depreciation")).source).toMatchObject({ ready: false, stage: "DRAFTED" });
        expect((await generateAssetScheduleJournal({ context: context(), scheduleEntryId: scheduleId, idempotencyKey: randomUUID() })).journalId).toBe(generated.journalId);
        await postJournal({ context: context(), journalId: generated.journalId });
        expect((await task("depreciation")).source).toMatchObject({ ready: true, stage: "POSTED" });
        await reversePostedJournal({ context: { ...context(), reason: "Synthetic schedule reversal" }, originalJournalId: generated.journalId, periodId: id.period, accountingDate: "2025-09-25", description: "Synthetic schedule reversal", reason: "Synthetic schedule reversal", idempotencyKey: randomUUID() });
        expect((await task("depreciation")).source.ready).toBe(false);
    });
    it("requires the assigned reviewer, exact current hashes and evidence, retaining stale reviews", async () => {
        await update("manual");
        await decide("manual", "REVIEW");
        await decide("manual", "COMPLETE");
        expect((await task("manual")).effectiveStatus).toBe("COMPLETE");
        const historyBefore = (await inspect()).history.length;
        await journal(id.cashCombination, id.revenueCombination, "10.00");
        const stale = await task("manual");
        expect(stale).toMatchObject({ stale: true, effectiveStatus: "BLOCKED" });
        expect(stale.review).not.toBeNull();
        expect((await inspect()).history).toHaveLength(historyBefore);
        await expect(commandCloseTask({ ...commandContext(), instanceId, taskKey: "manual", expectedVersion: stale.version, sourceHash: "a".repeat(64), action: "REVIEW" })).rejects.toMatchObject({ code: "CLOSE_SOURCE_STALE" });
        await update("bank");
        await expect(decide("bank", "REVIEW")).rejects.toMatchObject({ code: "CLOSE_SOURCE_BLOCKED" });
        await decide("bank", "NOT_APPLICABLE");
        expect((await task("bank")).effectiveStatus).toBe("NOT_APPLICABLE");
        await update("signoff");
        await expect(decide("signoff", "NOT_APPLICABLE")).rejects.toBeDefined();
    });
    it("rejects stale concurrent edits and cross-tenant/unauthorized review", async () => {
        const t = await task("manual"), c = { ...commandContext(), instanceId, taskKey: "manual", expectedVersion: t.version, action: "UPDATE" as const, input: { ...t.input, status: "IN_PROGRESS" as const } };
        const results = await Promise.allSettled([commandCloseTask(c), commandCloseTask({ ...c, idempotencyKey: randomUUID() })]);
        expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
        await expect(inspectCloseInstance({ ...principal, organizationId: randomUUID() }, instanceId)).rejects.toBeDefined();
        await expect(commandCloseTask({ ...c, principal: { ...principal, userId: id.outsider }, idempotencyKey: randomUUID() })).rejects.toBeDefined();
        await owner.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_key='banking.read'", [id.role]);
        expect((await task("bank")).source).toMatchObject({ available: false, ready: false, stage: "UNKNOWN" });
        expect((await task("bank")).effectiveStatus).toBe("BLOCKED");
        await owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,'banking.read')", [id.org, id.role]);
    });
    it("carries unresolved work with original source dates and no copied completion or journals", async () => {
        const period = randomUUID();
        await owner.query("INSERT INTO fiscal_periods(id,organization_id,ledger_id,fiscal_year,period_number,label,starts_on,ends_on) VALUES($1,$2,$3,2025,10,'October 2025','2025-10-01','2025-10-31')", [period, id.org, id.ledger]);
        laterId = (await createCloseInstance({ ...commandContext(), periodId: period, templateRevisionId })).instance.id;
        const t = await task("depreciation"), count = (await owner.query("SELECT count(*) FROM journal_entries WHERE organization_id=$1", [id.org])).rows[0].count, c = { ...commandContext(), fromInstanceId: instanceId, taskKey: t.key, expectedVersion: t.version, toInstanceId: laterId, dueOn: t.input.dueOn };
        const carried = await carryCloseTask(c);
        expect((await carryCloseTask(c)).task.id).toBe(carried.task.id);
        const later = await inspectCloseInstance(principal, laterId), next = later.tasks.find(t => t.key === carried.task.task_key)!;
        expect(next.sourcePeriodId).toBe(id.period);
        expect(next.input.status).toBe("NOT_STARTED");
        expect(next.review).toBeNull();
        expect((await task("depreciation")).effectiveStatus).not.toBe("COMPLETE");
        expect((await owner.query("SELECT count(*) FROM journal_entries WHERE organization_id=$1", [id.org])).rows[0].count).toBe(count);
        expect(later.tasks.find(t => t.key === "signoff")!.dependencies.some(dep => dep.key === next.key)).toBe(true);
    });
    it("requires recipient opt-in, deduplicates acknowledged notices and never changes period state", async () => {
        const before = (await owner.query("SELECT state,version FROM fiscal_periods WHERE id=$1", [id.period])).rows[0];
        expect((await listCloseNotifications(principal, instanceId)).preference).toBeNull();
        const c = { ...commandContext(), instanceId, recipientId: id.actor, expectedVersion: 0, enabled: true, dueWithinDays: 3, events: ["OVERDUE", "BLOCKER"] as ("OVERDUE" | "BLOCKER")[] };
        await configureCloseNotifications(c);
        const notices = await listCloseNotifications(principal, instanceId);
        expect(notices.pending.length).toBeGreaterThan(0);
        const notice = notices.pending[0]!;
        const ack = { ...commandContext(), instanceId, noticeKey: notice.noticeKey };
        await acknowledgeCloseNotice(ack);
        expect((await acknowledgeCloseNotice(ack)).idempotentReplay).toBe(true);
        expect((await listCloseNotifications(principal, instanceId)).pending.some(n => n.noticeKey === notice.noticeKey)).toBe(false);
        await expect(configureCloseNotifications({ ...c, recipientId: id.outsider, idempotencyKey: randomUUID() })).rejects.toBeDefined();
        expect((await owner.query("SELECT state,version FROM fiscal_periods WHERE id=$1", [id.period])).rows[0]).toEqual(before);
        expect((await loadCloseChecklistWorkspace(principal)).instances).toHaveLength(2);
    });
    it("keeps sub-cent register-to-GL differences visible",async()=>{
        const source=(await task("asset-reconciliation")).source.evidence as {reconciliation:{combinationId:string;difference:string}[]};const cash=source.reconciliation.find(row=>row.combinationId===id.cashCombination)!;const difference=exact(cash.difference);
        await journal(difference.isNegative()?id.cashCombination:id.revenueCombination,difference.isNegative()?id.revenueCombination:id.cashCombination,difference.abs().toFixed(9));expect((await task("asset-reconciliation")).source.ready).toBe(true);
        await journal(id.cashCombination,id.revenueCombination,"0.000000001");const changed=await task("asset-reconciliation");expect(changed.source.ready).toBe(false);expect(JSON.stringify(changed.source.evidence)).toContain('"difference":"0.000000001"');
    });
    it("retains locked-period state when opening and managing its evidence", async () => {
        await transitionFiscalPeriod({ context: context(), periodId: id.period, expectedVersion: 1, toState: "ADJUSTMENT_ONLY", idempotencyKey: randomUUID() });
        await transitionFiscalPeriod({ context: context(), periodId: id.period, expectedVersion: 2, toState: "HARD_CLOSED", idempotencyKey: randomUUID() });
        expect((await inspect()).scope.periodState).toBe("HARD_CLOSED");
        await update("manual");
        expect((await inspect()).scope.periodState).toBe("HARD_CLOSED");
        expect((await owner.query("SELECT version FROM fiscal_periods WHERE id=$1", [id.period])).rows[0].version).toBe(3);
    });
});
