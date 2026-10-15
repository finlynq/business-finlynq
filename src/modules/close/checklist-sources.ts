import "server-only";
import type { PoolClient } from "pg";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import { exact } from "@/kernel/money";
import { actorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import { loadProvisionPreview } from "@/modules/tax/provision-sources";
import type { ProvisionCalculationRow } from "@/modules/tax/provision-service";
import { TaxFilingError } from "@/modules/tax/filing-service";
import type { CloseSource } from "./checklist-model";
export type CloseScope = {
    periodId: string;
    ledgerId: string;
    legalEntityId: string;
    fiscalYear: number;
    startsOn: string;
    endsOn: string;
    periodState: string;
    periodVersion: number;
    entityName: string;
    ledgerCode: string;
    currency: string;
    label: string;
};
export type CloseSourceFact = {
    source: CloseSource;
    available: boolean;
    ready: boolean;
    stage: string;
    detail: string;
    href: string;
    evidence: unknown;
    hash: string;
};
const links: Record<CloseSource, string> = { BANK: "/app/banking", RECEIVABLES: "/app/receivables/invoices", PAYABLES: "/app/payables/bills", UNPOSTED: "/app/journals", MAPPINGS: "/app/settings/accounting", ACCRUALS: "/app/journals", PREPAIDS: "/app/assets", DEPRECIATION: "/app/assets", ASSET_RECONCILIATION: "/app/assets", TAX_PROVISION: "/app/tax/provision", STATEMENTS: "/app/reports", SIGNOFF: "/app/controls/period-close", MANUAL: "/app/controls/period-close" };
function fact(source: CloseSource, ready: boolean, stage: string, detail: string, evidence: unknown, available = true): CloseSourceFact { const value = { source, available, ready, stage, detail, href: links[source], evidence }; return { ...value, hash: createCommandFingerprint("close.source", value) }; }
export async function closeScope(client: PoolClient, org: string, periodId: string) {
    const row = (await client.query<CloseScope>(`SELECT period.id AS "periodId",period.ledger_id AS "ledgerId",ledger.legal_entity_id AS "legalEntityId",period.fiscal_year AS "fiscalYear",period.starts_on::text AS "startsOn",period.ends_on::text AS "endsOn",period.state AS "periodState",period.version AS "periodVersion",period.label,entity.display_name AS "entityName",ledger.code AS "ledgerCode",ledger.functional_currency AS currency FROM fiscal_periods period JOIN ledgers ledger ON ledger.organization_id=period.organization_id AND ledger.id=period.ledger_id JOIN legal_entities entity ON entity.organization_id=ledger.organization_id AND entity.id=ledger.legal_entity_id WHERE period.organization_id=$1 AND period.id=$2`, [org, periodId])).rows[0];
    if (!row)
        throw new TaxFilingError("The close period is unavailable in this organization.", 404, "CLOSE_PERIOD_NOT_FOUND");
    return row;
}
export async function loadCloseChecklistSources(client: PoolClient, org: string, actorId: string, periodId: string) {
    const scope = await closeScope(client, org, periodId);
    const safe = async (source: CloseSource, permission: Permission, work: () => Promise<CloseSourceFact>) => {
        const point = `close_source_${source.toLowerCase()}`;
        await client.query(`SAVEPOINT ${point}`);
        try {
            if (!await actorHasActivePermission(client, { organizationId: org, actorId, permission }))
                return fact(source, false, "UNKNOWN", "This source requires its normal read permission before close review.", null, false);
            return await work();
        }
        catch {
            return fact(source, false, "UNKNOWN", "The source could not be checked. Resolve access or availability before reviewing this task.", null, false);
        }
        finally {
            await client.query(`ROLLBACK TO SAVEPOINT ${point}`);
            await client.query(`RELEASE SAVEPOINT ${point}`);
        }
    };
    const books = await safe("STATEMENTS", PERMISSIONS.readMcpLedger, async () => {
        const journals = (await client.query(`SELECT id,status,accounting_date::text AS "accountingDate",content_hash AS "contentHash",total_debit_functional::text AS debit,total_credit_functional::text AS credit FROM journal_entries entry WHERE organization_id=$1 AND ledger_id=$2 AND legal_entity_id=$3 AND accounting_date<=$4::date AND NOT EXISTS(SELECT 1 FROM journal_transaction_controls control WHERE control.organization_id=entry.organization_id AND control.journal_entry_id=entry.id AND control.outcome='DELETED') ORDER BY id LIMIT 10001`, [org, scope.ledgerId, scope.legalEntityId, scope.endsOn])).rows;
        const unposted = journals.filter(row => row.status !== "POSTED");
        return fact("STATEMENTS", journals.length <= 10000 && unposted.length === 0, unposted.length ? "UNPOSTED" : "REVIEW_REQUIRED", `${journals.length} journal records through period end; ${unposted.length} remain unposted. Review trial balance and statements with explicit evidence.`, { journals, bounded: journals.length > 10000 });
    });
    const documents = async (source: "RECEIVABLES" | "PAYABLES", module: string, permission: Permission) => safe(source, permission, async () => {
        const rows = (await client.query(`SELECT document.id,source_number AS "sourceNumber",version,status,content_hash AS "contentHash",snapshot->>'accountingDate' AS "accountingDate" FROM source_documents document WHERE organization_id=$1 AND legal_entity_id=$2 AND owner_module=$3 AND snapshot->>'ledgerId'=$4 AND snapshot->>'accountingDate'<=$5 AND NOT EXISTS(SELECT 1 FROM source_documents successor WHERE successor.organization_id=document.organization_id AND successor.supersedes_source_document_id=document.id) ORDER BY id LIMIT 10001`, [org, scope.legalEntityId, module, scope.ledgerId, scope.endsOn])).rows;
        const unposted = rows.filter(row => !["POSTED", "VOIDED"].includes(row.status));
        return fact(source, rows.length <= 10000 && unposted.length === 0, unposted.length ? "DRAFTED" : "REVIEW_REQUIRED", `${rows.length} current source documents through period end; ${unposted.length} unposted. Explicitly review completeness, cut-off and missing invoices/bills; absence of records is not proof of completeness.`, { documents: rows, bounded: rows.length > 10000 });
    });
    const receivables = await documents("RECEIVABLES", "receivables", PERMISSIONS.readReceivables), payables = await documents("PAYABLES", "payables", PERMISSIONS.readPayables);
    const bank = await safe("BANK", PERMISSIONS.readBanking, async () => {
        const accounts = (await client.query(`SELECT account.id,account.account_kind AS kind,account.currency_code AS currency,coalesce((SELECT jsonb_agg(jsonb_build_object('id',session.id,'status',session.status,'version',session.version,'startsOn',session.statement_start_on,'endsOn',session.statement_end_on) ORDER BY session.id) FROM bank_reconciliation_sessions session WHERE session.organization_id=account.organization_id AND session.external_account_id=account.id AND session.statement_start_on<=$3::date AND session.statement_end_on>=$4::date),'[]') AS reconciliations FROM bank_external_accounts account WHERE account.organization_id=$1 AND account.ledger_id=$2 AND account.active ORDER BY account.id`, [org, scope.ledgerId, scope.startsOn, scope.endsOn])).rows;
        const complete = accounts.filter(row => (row.reconciliations as {
            status: string;
        }[]).some(recon => recon.status === "FINALIZED")).length;
        return fact("BANK", accounts.length > 0 && accounts.length === complete, accounts.length === complete && accounts.length > 0 ? "RECONCILED" : "MISSING", `${complete} of ${accounts.length} active bank/card accounts have finalized statement coverage. Missing or partial statements remain exceptions; review applicability if no accounts exist.`, { accounts });
    });
    const asset = await safe("DEPRECIATION", PERMISSIONS.readMcpLedger, async () => {
        const register = (await client.query(`SELECT asset.id,asset.asset_number AS number,asset.kind,asset.classification,asset.status,asset.version,asset.cost::text,asset.recognized_to_date::text AS "recognizedToDate",asset.in_service_on::text AS "inServiceOn",asset.schedule_end_on::text AS "scheduleEndOn",category.cost_account_combination_id AS "costCombinationId",category.contra_account_combination_id AS "contraCombinationId",category.expense_account_combination_id AS "expenseCombinationId",category.version AS "categoryVersion",category.active AS "categoryActive",category.effective_from::text AS "categoryEffectiveFrom",(SELECT jsonb_agg(jsonb_build_object('combinationId',combination.id,'accountId',account.id,'active',combination.active AND account.active,'postable',account.postable,'class',account.class,'validFrom',account.valid_from,'validTo',account.valid_to) ORDER BY combination.id) FROM account_combinations combination JOIN gl_accounts account ON account.organization_id=combination.organization_id AND account.id=combination.account_id WHERE combination.organization_id=asset.organization_id AND combination.id=ANY(ARRAY[category.cost_account_combination_id,category.contra_account_combination_id,category.expense_account_combination_id])) AS mappings,(SELECT count(*)::int FROM account_combinations combination JOIN gl_accounts account ON account.organization_id=combination.organization_id AND account.id=combination.account_id WHERE combination.organization_id=asset.organization_id AND combination.id=ANY(ARRAY[category.cost_account_combination_id,category.contra_account_combination_id,category.expense_account_combination_id]) AND combination.active AND account.active AND account.postable AND account.valid_from<=$4::date AND (account.valid_to IS NULL OR account.valid_to>=$4::date)) AS "validMappings" FROM asset_register asset JOIN asset_categories category ON category.organization_id=asset.organization_id AND category.id=asset.category_id WHERE asset.organization_id=$1 AND asset.ledger_id=$2 AND asset.legal_entity_id=$3 AND asset.in_service_on<=$4::date ORDER BY asset.id LIMIT 10001`, [org, scope.ledgerId, scope.legalEntityId, scope.endsOn])).rows;
        const schedules = (await client.query(`SELECT schedule.id,schedule.asset_id AS "assetId",asset.kind,schedule.version,schedule.period_start_on::text AS "startsOn",schedule.period_end_on::text AS "endsOn",schedule.due_on::text AS "dueOn",schedule.amount::text,schedule.status,schedule.journal_entry_id AS "journalId",journal.status AS "journalStatus",journal.content_hash AS "journalHash",EXISTS(SELECT 1 FROM journal_entry_relations relation JOIN journal_entries reversal ON reversal.organization_id=relation.organization_id AND reversal.id=relation.from_journal_id AND reversal.status='POSTED' AND reversal.accounting_date<=$4::date WHERE relation.organization_id=schedule.organization_id AND relation.to_journal_id=schedule.journal_entry_id AND relation.kind='REVERSAL_OF') AS reversed FROM asset_schedule_entries schedule JOIN asset_register asset ON asset.organization_id=schedule.organization_id AND asset.id=schedule.asset_id LEFT JOIN journal_entries journal ON journal.organization_id=schedule.organization_id AND journal.id=schedule.journal_entry_id AND journal.accounting_date<=$4::date WHERE schedule.organization_id=$1 AND asset.ledger_id=$2 AND asset.legal_entity_id=$3 AND schedule.due_on<=$4::date ORDER BY schedule.due_on,schedule.id LIMIT 10001`, [org, scope.ledgerId, scope.legalEntityId, scope.endsOn])).rows;
        const balances = (await client.query(`SELECT line.account_combination_id AS "combinationId",sum(line.debit_functional-line.credit_functional)::text AS balance FROM journal_lines line JOIN journal_entries journal ON journal.organization_id=line.organization_id AND journal.id=line.journal_entry_id AND journal.status='POSTED' WHERE journal.organization_id=$1 AND journal.ledger_id=$2 AND journal.legal_entity_id=$3 AND journal.accounting_date<=$4::date GROUP BY line.account_combination_id ORDER BY line.account_combination_id`, [org, scope.ledgerId, scope.legalEntityId, scope.endsOn])).rows;
        return fact("DEPRECIATION", register.length <= 10000 && schedules.length <= 10000, "REVIEW_REQUIRED", "Asset register, schedule and posted GL facts captured.", { register, schedules, balances });
    });
    const assetData = asset.evidence as {
        register: Record<string, unknown>[];
        schedules: Record<string, unknown>[];
        balances: {
            combinationId: string;
            balance: string;
        }[];
    } | null;
    function schedules(source: "PREPAIDS" | "DEPRECIATION") {
        if (!asset.available || !assetData)
            return fact(source, false, "UNKNOWN", asset.detail, null, false);
        const eligible = assetData.register.filter(row => ["ACTIVE", "IMPAIRED"].includes(String(row.status)) && row.classification === "FINITE_LIFE" && (source === "PREPAIDS" ? row.kind === "PREPAID" : row.kind !== "PREPAID"));
        const rows = assetData.schedules.filter(row => eligible.some(a => a.id === row.assetId));
        const missing = eligible.filter(row => (!row.scheduleEndOn || String(row.scheduleEndOn) >= scope.startsOn) && !rows.some(s => s.assetId === row.id && String(s.endsOn) >= scope.startsOn && String(s.endsOn) <= scope.endsOn));
        const outstanding = rows.filter(row => row.journalStatus !== "POSTED" || row.reversed === true);
        const posted = rows.filter(row => row.journalStatus === "POSTED" && row.reversed !== true);
        const stage = outstanding.some(row => row.journalStatus === "APPROVED") ? "APPROVED" : outstanding.some(row => row.journalStatus === "SUBMITTED") ? "SUBMITTED" : outstanding.some(row => row.journalId) ? "DRAFTED" : outstanding.length ? "DUE" : posted.length ? "POSTED" : "MISSING";
        return fact(source, asset.ready && eligible.length > 0 && missing.length === 0 && outstanding.length === 0, stage, `${posted.length} posted schedule entries; ${outstanding.length} due, unposted or reversed; ${missing.length} assets missing period schedules. ${eligible.length === 0 ? "Review not-applicable evidence if no eligible assets exist." : ""}`, { eligible, schedules: rows, missing, postedIds: posted.map(row => row.journalId) });
    }
    const mappings = assetData ? fact("MAPPINGS", asset.ready && assetData.register.every(row => row.categoryActive === true && String(row.categoryEffectiveFrom) <= scope.endsOn && Number(row.validMappings) >= (row.kind === "PREPAID" ? 2 : 3)), "REVIEW_REQUIRED", "Review active account mappings and the completeness of the register against acquisitions and expenses.", { register: assetData.register.map(row => ({ id: row.id, kind: row.kind, costCombinationId: row.costCombinationId, contraCombinationId: row.contraCombinationId, expenseCombinationId: row.expenseCombinationId, categoryVersion: row.categoryVersion, validMappings: row.validMappings, mappings: row.mappings, categoryActive: row.categoryActive, categoryEffectiveFrom: row.categoryEffectiveFrom })) }) : fact("MAPPINGS", false, "UNKNOWN", asset.detail, null, false);
    const recognition = (assetId: unknown) => assetData!.schedules.filter(row => row.assetId === assetId && row.journalStatus === "POSTED" && row.reversed !== true).reduce((sum, row) => sum.plus(String(row.amount)), exact("0"));
    const recon = assetData ? [...new Set(assetData.register.flatMap(row => [row.costCombinationId, row.kind !== "PREPAID" ? row.contraCombinationId : null]).filter(Boolean).map(String))].map(combinationId => {
        const assets = assetData.register.filter(row => row.status !== "DISPOSED");
        const expected = assets.reduce((sum, row) => sum.plus(row.costCombinationId === combinationId ? exact(String(row.cost)).minus(row.kind === "PREPAID" ? recognition(row.id) : "0") : "0").minus(row.kind !== "PREPAID" && row.contraCombinationId === combinationId ? recognition(row.id) : "0"), exact("0"));
        const actual = exact(assetData.balances.find(row => row.combinationId === combinationId)?.balance ?? "0");
        return { combinationId, expected: expected.toFixed(2), actual: actual.toFixed(2), difference: actual.minus(expected).toFixed(2) };
    }) : [];
    const assetRecon = assetData ? fact("ASSET_RECONCILIATION", asset.ready && recon.every(row => exact(row.difference).isZero()), "REVIEW_REQUIRED", "Compare register cost and period-end posted recognition with cost/contra GL balances. Differences require correction or an explicit reviewed exception; substantiate missing register entries, disposals and impairment separately.", { register: assetData.register, reconciliation: recon, balances: assetData.balances.filter(row => assetData.register.some(asset => asset.costCombinationId === row.combinationId || asset.contraCombinationId === row.combinationId)), schedules: assetData.schedules }) : fact("ASSET_RECONCILIATION", false, "UNKNOWN", asset.detail, null, false);
    const tax = await safe("TAX_PROVISION", PERMISSIONS.readTax, async () => {
        const calculation = (await client.query<ProvisionCalculationRow>("SELECT *,through_date::text FROM tax_provision_calculations WHERE organization_id=$1 AND period_id=$2 AND through_date=$3::date ORDER BY created_at DESC,id DESC LIMIT 1", [org, periodId, scope.endsOn])).rows[0];
        if (!calculation)
            return fact("TAX_PROVISION", false, "NOT_COMPUTED", "No period-end current-tax calculation exists. Configure, calculate and review its sources.", null);
        const events = (await client.query(`SELECT event.id,event.version,event.action,event.journal_id AS "journalId",event.source_hash AS "sourceHash",journal.status AS "journalStatus" FROM tax_provision_events event LEFT JOIN journal_entries journal ON journal.organization_id=event.organization_id AND journal.id=event.journal_id WHERE event.organization_id=$1 AND event.calculation_id=$2 ORDER BY event.version`, [org, calculation.id])).rows;
        const latest = events.at(-1), current = await loadProvisionPreview(client, org, { assumptionsId: calculation.assumptions_id, periodId, throughDate: scope.endsOn });
        let fresh = current.sourceHash === calculation.source_hash;
        if (latest?.action === "DRAFT" && latest.journalStatus === "POSTED") {
            const fingerprint = (await client.query<{
                value: string;
            }>(`SELECT md5(coalesce(string_agg(id::text||':'||content_hash,',' ORDER BY id),'')) AS value FROM journal_entries WHERE organization_id=$1 AND ledger_id=$2 AND legal_entity_id=$3 AND status='POSTED' AND accounting_date<=$4::date AND id<>$5::uuid`, [org, scope.ledgerId, scope.legalEntityId, scope.endsOn, latest.journalId])).rows[0]!.value;
            fresh = fingerprint === calculation.snapshot.sources.ledgerFingerprint && current.snapshot.assumptions.id === calculation.assumptions_id && exact(current.snapshot.incrementalAdjustment).isZero() && exact(current.snapshot.ytdCurrentTax).equals(calculation.snapshot.ytdCurrentTax) && createCommandFingerprint("cca", current.snapshot.sources.ccaSources) === createCommandFingerprint("cca", calculation.snapshot.sources.ccaSources);
        }
        const completed = latest?.action === "DRAFT" && (latest.journalId === null || latest.journalStatus === "POSTED");
        return fact("TAX_PROVISION", current.snapshot.ready && fresh && completed, fresh ? (latest?.journalStatus ?? (latest?.action === "DRAFT" ? "NO_ENTRY" : latest?.action === "REVIEW" ? "REVIEWED" : "PREVIEWED")) : "STALE", fresh ? "Calculation evidence and its separate journal stage are shown. A draft does not satisfy posting." : "Books, assumptions or CCA sources changed. Refresh the provision; prior evidence remains retained.", { calculationId: calculation.id, version: calculation.version, sourceHash: calculation.source_hash, currentSourceHash: current.sourceHash, events, fresh, blockers: current.snapshot.blockers, ytdCurrentTax: current.snapshot.ytdCurrentTax, adjustment: current.snapshot.incrementalAdjustment });
    });
    const unposted = fact("UNPOSTED", books.available && receivables.available && payables.available && books.ready && receivables.ready && payables.ready, "SOURCE_CHECK", "All current unposted journals and source documents must be resolved before approval.", { books, receivables, payables }, books.available && receivables.available && payables.available);
    const accruals = fact("ACCRUALS", books.available && books.ready, "REVIEW_REQUIRED", "Review accruals and cut-off against source evidence. This monitor never creates or posts an accrual.", { booksHash: books.hash, receivablesHash: receivables.hash, payablesHash: payables.hash }, books.available);
    const facts: Record<CloseSource, CloseSourceFact> = { BANK: bank, RECEIVABLES: receivables, PAYABLES: payables, UNPOSTED: unposted, MAPPINGS: mappings, ACCRUALS: accruals, PREPAIDS: schedules("PREPAIDS"), DEPRECIATION: schedules("DEPRECIATION"), ASSET_RECONCILIATION: assetRecon, TAX_PROVISION: tax, STATEMENTS: books, SIGNOFF: fact("SIGNOFF", books.available && books.ready, "REVIEW_REQUIRED", "Final sign-off requires all tasks, explicit exceptions and dependencies to be current. It never changes the accounting-period state.", { booksHash: books.hash }, books.available), MANUAL: fact("MANUAL", books.available, "REVIEW_REQUIRED", "Retain exact supporting evidence and reviewer rationale.", { booksHash: books.hash }, books.available) };
    return { scope, facts };
}
