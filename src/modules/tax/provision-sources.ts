import "server-only";
import type { PoolClient } from "pg";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import { exact, minorUnits, sumExact } from "@/kernel/money";
import { calculateProvision, provisionAssumptionsSchema, type ProvisionBridgeAdjustment } from "./provision-model";
import { TaxFilingError } from "./filing-service";
export type ProvisionAssumptionRow = {
    id: string;
    organization_id: string;
    legal_entity_id: string;
    ledger_id: string;
    fiscal_year: number;
    year_start: string;
    year_end: string;
    version: number;
    state: "DRAFT" | "REVIEWED";
    payload: unknown;
    created_by: string;
    created_at: string;
    reason: string;
    command_hash: string;
};
export async function provisionAssumption(client: PoolClient, org: string, id: string) {
    const row = (await client.query<ProvisionAssumptionRow>("SELECT *,year_start::text,year_end::text FROM tax_provision_assumptions WHERE organization_id=$1 AND id=$2", [org, id])).rows[0];
    if (!row)
        throw new TaxFilingError("The provision assumptions were not found in this organization.", 404, "PROVISION_ASSUMPTIONS_NOT_FOUND");
    return row;
}
type Journal = {
    id: string;
    accountingDate: string;
    description: string;
    journalNumber: number | null;
    contentHash: string;
    bookIncome: string;
    taxExpense: string;
    liabilityMovement: string;
    reversalOf: string | null;
};
export async function loadProvisionPreview(client: PoolClient, org: string, input: {
    assumptionsId: string;
    periodId: string;
    throughDate: string;
}) {
    const assumptions = await provisionAssumption(client, org, input.assumptionsId), a = provisionAssumptionsSchema.parse(assumptions.payload), blockers: string[] = [];
    const scope = (await client.query<{
        currency: string;
        entityName: string;
        ledgerCode: string;
        periodState: string;
        periodStart: string;
        periodEnd: string;
        fiscalYear: number;
    }>(`SELECT ledger.functional_currency AS currency,entity.display_name AS "entityName",ledger.code AS "ledgerCode",
   period.state AS "periodState",period.starts_on::text AS "periodStart",period.ends_on::text AS "periodEnd",period.fiscal_year AS "fiscalYear"
   FROM ledgers ledger JOIN legal_entities entity ON entity.organization_id=ledger.organization_id AND entity.id=ledger.legal_entity_id
   JOIN fiscal_periods period ON period.organization_id=ledger.organization_id AND period.ledger_id=ledger.id AND period.id=$4
   WHERE ledger.organization_id=$1 AND ledger.id=$2 AND entity.id=$3 AND ledger.active AND entity.active`, [org, assumptions.ledger_id, assumptions.legal_entity_id, input.periodId])).rows[0];
    if (!scope)
        throw new TaxFilingError("Choose the assumptions' active entity, ledger and fiscal period.", 400, "PROVISION_SCOPE_INVALID");
    if (scope.fiscalYear !== assumptions.fiscal_year || input.throughDate < scope.periodStart || input.throughDate > scope.periodEnd || input.throughDate < assumptions.year_start || input.throughDate > assumptions.year_end)
        throw new TaxFilingError("The through-date must be in the selected period and fiscal tax year.", 400, "PROVISION_DATE_INVALID");
    const current = (await client.query<{
        id: string;
    }>("SELECT id FROM tax_provision_assumptions WHERE organization_id=$1 AND ledger_id=$2 AND fiscal_year=$3 ORDER BY version DESC LIMIT 1", [org, assumptions.ledger_id, assumptions.fiscal_year])).rows[0];
    if (assumptions.state !== "REVIEWED" || current?.id !== assumptions.id)
        blockers.push("Review the latest assumptions version before calculating or generating a draft.");
    const mappings = (await client.query<{
        id: string;
        accountId: string;
        code: string;
        name: string;
        accountClass: string;
    }>(`SELECT combination.id,account.id AS "accountId",account.code,account.display_name AS name,account.class AS "accountClass"
   FROM account_combinations combination JOIN gl_accounts account ON account.organization_id=combination.organization_id AND account.ledger_id=combination.ledger_id AND account.id=combination.account_id
   WHERE combination.organization_id=$1 AND combination.ledger_id=$2 AND combination.entity_id=$3 AND combination.id=ANY($4::uuid[])
     AND combination.active AND account.active AND account.postable AND account.control_kind='NONE' AND account.valid_from<=$5::date AND (account.valid_to IS NULL OR account.valid_to>=$5::date)`, [org, assumptions.ledger_id, assumptions.legal_entity_id, [a.expenseCombinationId, a.payableCombinationId].filter(Boolean), input.throughDate])).rows;
    const expense = mappings.find(row => row.id === a.expenseCombinationId), payable = mappings.find(row => row.id === a.payableCombinationId);
    const expenseAccounts = (await client.query<{
        id: string;
        code: string;
        name: string;
        accountClass: string;
    }>(`SELECT id,code,display_name AS name,class AS "accountClass" FROM gl_accounts WHERE organization_id=$1 AND ledger_id=$2 AND id=ANY($3::uuid[]) AND active AND postable`, [org, assumptions.ledger_id, a.expenseAccountIds])).rows;
    if (!expense || !payable || expense.accountClass !== "EXPENSE" || payable.accountClass !== "LIABILITY" || expense.id === payable.id || !a.expenseAccountIds.includes(expense.accountId) || expenseAccounts.length !== new Set(a.expenseAccountIds).size || expenseAccounts.some(row => row.accountClass !== "EXPENSE"))
        blockers.push("Use active tenant expense/liability combinations and identify every current-tax expense account excluded from the book base.");
    const periods = (await client.query<{
        id: string;
        startsOn: string;
        endsOn: string;
        state: string;
    }>(`SELECT id,starts_on::text AS "startsOn",ends_on::text AS "endsOn",state FROM fiscal_periods WHERE organization_id=$1 AND ledger_id=$2 AND starts_on<=$4::date AND ends_on>=$3::date ORDER BY starts_on,id`, [org, assumptions.ledger_id, assumptions.year_start, input.throughDate])).rows;
    let covered = Date.parse(assumptions.year_start);
    for (const period of periods) {
        const start = Math.max(Date.parse(period.startsOn), Date.parse(assumptions.year_start)), end = Math.min(Date.parse(period.endsOn), Date.parse(input.throughDate));
        if (start !== covered)
            blockers.push("Fiscal-period coverage has a gap or overlap before the through-date.");
        covered = end + 86400000;
    }
    if (covered !== Date.parse(input.throughDate) + 86400000)
        blockers.push("Complete the fiscal-period coverage through this calculation date.");
    const fingerprint = (await client.query<{
        value: string;
    }>(`SELECT md5(coalesce(string_agg(id::text||':'||content_hash,',' ORDER BY id),'')) AS value FROM journal_entries
   WHERE organization_id=$1 AND ledger_id=$2 AND legal_entity_id=$3 AND status='POSTED' AND accounting_date<=$4::date`, [org, assumptions.ledger_id, assumptions.legal_entity_id, input.throughDate])).rows[0]!.value;
    const journals = (await client.query<Journal>(`SELECT entry.id,entry.accounting_date::text AS "accountingDate",entry.description,entry.journal_number AS "journalNumber",entry.content_hash AS "contentHash",
   coalesce(sum(line.credit_functional-line.debit_functional) FILTER(WHERE account.class IN ('REVENUE','EXPENSE') AND NOT(account.id=ANY($6::uuid[]))),0)::text AS "bookIncome",
   coalesce(sum(line.debit_functional-line.credit_functional) FILTER(WHERE account.id=ANY($6::uuid[])),0)::text AS "taxExpense",
   coalesce(sum(line.credit_functional-line.debit_functional) FILTER(WHERE account.id=$7::uuid),0)::text AS "liabilityMovement",
   (SELECT relation.to_journal_id FROM journal_entry_relations relation WHERE relation.organization_id=entry.organization_id AND relation.from_journal_id=entry.id AND relation.kind='REVERSAL_OF' LIMIT 1) AS "reversalOf"
   FROM journal_entries entry JOIN journal_lines line ON line.organization_id=entry.organization_id AND line.journal_entry_id=entry.id
   JOIN account_combinations combination ON combination.organization_id=line.organization_id AND combination.id=line.account_combination_id
   JOIN gl_accounts account ON account.organization_id=combination.organization_id AND account.id=combination.account_id
   WHERE entry.organization_id=$1 AND entry.ledger_id=$2 AND entry.legal_entity_id=$3 AND entry.status='POSTED' AND entry.accounting_date BETWEEN $4::date AND $5::date
   GROUP BY entry.id ORDER BY entry.accounting_date,entry.id LIMIT 10001`, [org, assumptions.ledger_id, assumptions.legal_entity_id, assumptions.year_start, input.throughDate, a.expenseAccountIds, payable?.accountId ?? null])).rows;
    if (journals.length > 10000)
        blockers.push("The bounded source-journal limit was exceeded; narrow or explicitly extend the reviewed source window.");
    const unposted = (await client.query(`SELECT entry.id,entry.status,entry.accounting_date::text AS "accountingDate",entry.description FROM journal_entries entry
   WHERE entry.organization_id=$1 AND entry.ledger_id=$2 AND entry.legal_entity_id=$3 AND entry.accounting_date BETWEEN $4::date AND $5::date AND entry.status<>'POSTED'
   AND NOT EXISTS(SELECT 1 FROM journal_transaction_controls control WHERE control.organization_id=entry.organization_id AND control.journal_entry_id=entry.id AND control.outcome='DELETED')
   AND NOT EXISTS(SELECT 1 FROM tax_provision_events event WHERE event.organization_id=entry.organization_id AND event.journal_id=entry.id AND event.action='DRAFT')
   ORDER BY entry.accounting_date,entry.id LIMIT 201`, [org, assumptions.ledger_id, assumptions.legal_entity_id, assumptions.year_start, input.throughDate])).rows;
    if (unposted.length)
        blockers.push("Unposted source journals remain before the through-date. Review completeness before approving the provision.");
    const generated = (await client.query<{
        journalId: string;
        fiscalYear: number;
    }>(`SELECT event.journal_id AS "journalId",calculation.fiscal_year AS "fiscalYear" FROM tax_provision_events event
   JOIN tax_provision_calculations calculation ON calculation.organization_id=event.organization_id AND calculation.id=event.calculation_id
   WHERE event.organization_id=$1 AND calculation.ledger_id=$2 AND event.action='DRAFT' AND event.journal_id IS NOT NULL`, [org, assumptions.ledger_id])).rows;
    const classifications = new Map(a.journalClassifications.map(row => [row.journalId, { kind: row.kind, taxYear: row.taxYear, evidence: row.evidence }]));
    for (const row of generated) {
        const inferred = { kind: row.fiscalYear === assumptions.fiscal_year ? "CURRENT_YEAR_PROVISION" as const : "PRIOR_YEAR_TRUE_UP" as const, taxYear: row.fiscalYear, evidence: "Linked immutable provision calculation and journal-generation event" };
        const explicit = classifications.get(row.journalId);
        if (explicit && (explicit.kind !== inferred.kind || explicit.taxYear !== inferred.taxYear))
            blockers.push(`Journal ${row.journalId}: classification conflicts with its provision lineage.`);
        classifications.set(row.journalId, inferred);
    }
    const journalIndex = new Map(journals.map(row => [row.id, row]));
    function classificationFor(id: string, visited = new Set<string>()): ReturnType<typeof classifications.get> { if (visited.has(id))
        return undefined; visited.add(id); const own = classifications.get(id); if (own)
        return own; const parent = journalIndex.get(id)?.reversalOf; return parent ? classificationFor(parent, visited) : undefined; }
    const sourceJournals = journals.map(row => {
        const classification = classificationFor(row.id) ?? null;
        if (!exact(row.taxExpense).isZero() && !classification)
            blockers.push(`Classify tax-expense journal ${row.id} as a current-year provision or a supported prior-year/other adjustment.`);
        if (classification?.kind === "CURRENT_YEAR_PROVISION" && classification.taxYear !== assumptions.fiscal_year)
            blockers.push(`Journal ${row.id}: current-year classification has the wrong tax year.`);
        if (classification?.kind === "PRIOR_YEAR_TRUE_UP" && classification.taxYear >= assumptions.fiscal_year)
            blockers.push(`Journal ${row.id}: prior-year classification needs its actual earlier tax year.`);
        if (classification && ["INSTALMENT", "PAYMENT"].includes(classification.kind) && !exact(row.taxExpense).isZero())
            blockers.push(`Journal ${row.id}: a cash settlement classification cannot hide a tax-expense line.`);
        return { ...row, classification };
    });
    const opening = (await client.query<{
        amount: string;
    }>(`SELECT coalesce(sum(line.credit_functional-line.debit_functional),0)::text AS amount FROM journal_entries entry
   JOIN journal_lines line ON line.organization_id=entry.organization_id AND line.journal_entry_id=entry.id
   JOIN account_combinations combination ON combination.organization_id=line.organization_id AND combination.id=line.account_combination_id
   WHERE entry.organization_id=$1 AND entry.ledger_id=$2 AND entry.legal_entity_id=$3 AND entry.status='POSTED' AND entry.accounting_date<$4::date AND combination.account_id=$5::uuid`, [org, assumptions.ledger_id, assumptions.legal_entity_id, assumptions.year_start, payable?.accountId ?? null])).rows[0]!.amount;
    const ccaSources: Record<string, unknown>[] = [], ccaAdjustments: ProvisionBridgeAdjustment[] = [];
    for (const claim of a.ccaClaims) {
        const source = (await client.query<{
            id: string;
            assetId: string;
            version: number;
            claimedCca: string;
            schedule: unknown;
            ruleVersion: string;
            sourceUri: string;
            bookDepreciation: string;
        }>(`SELECT schedule.id,schedule.asset_id AS "assetId",schedule.version,(SELECT line->>'claimedCca' FROM jsonb_array_elements(schedule.schedule_snapshot) line WHERE (line->>'taxYear')::integer=$7) AS "claimedCca",schedule.schedule_snapshot AS schedule,
    classification.rule_version AS "ruleVersion",classification.source_uri AS "sourceUri",
    (WITH RECURSIVE book_chain AS (
       SELECT journal.id,journal.accounting_date,book.amount::numeric AS signed_amount,ARRAY[journal.id] AS visited FROM asset_schedule_entries book
       JOIN journal_entries journal ON journal.organization_id=book.organization_id AND journal.id=book.journal_entry_id AND journal.status='POSTED'
       WHERE book.organization_id=schedule.organization_id AND book.asset_id=schedule.asset_id
       UNION ALL SELECT reversal.id,reversal.accounting_date,-chain.signed_amount,chain.visited||reversal.id FROM book_chain chain
       JOIN journal_entry_relations relation ON relation.organization_id=schedule.organization_id AND relation.to_journal_id=chain.id AND relation.kind='REVERSAL_OF'
       JOIN journal_entries reversal ON reversal.organization_id=relation.organization_id AND reversal.id=relation.from_journal_id AND reversal.status='POSTED'
       WHERE NOT(reversal.id=ANY(chain.visited))) SELECT coalesce(sum(signed_amount),0)::text FROM book_chain WHERE accounting_date BETWEEN $5::date AND $6::date) AS "bookDepreciation"
    FROM asset_tax_schedules schedule JOIN asset_register asset ON asset.organization_id=schedule.organization_id AND asset.id=schedule.asset_id
    JOIN asset_tax_classifications classification ON classification.organization_id=schedule.organization_id AND classification.id=schedule.classification_id
    WHERE schedule.organization_id=$1 AND schedule.id=$2 AND asset.ledger_id=$3 AND asset.legal_entity_id=$4
      AND schedule.tax_year_start<=$7 AND schedule.tax_year_end>=$7
      AND NOT EXISTS(SELECT 1 FROM asset_tax_classifications newer WHERE newer.organization_id=classification.organization_id AND newer.supersedes_classification_id=classification.id)
      AND NOT EXISTS(SELECT 1 FROM asset_tax_schedules successor WHERE successor.organization_id=schedule.organization_id AND successor.supersedes_schedule_id=schedule.id)`, [org, claim.scheduleId, assumptions.ledger_id, assumptions.legal_entity_id, assumptions.year_start, input.throughDate, assumptions.fiscal_year])).rows[0];
        if (!source || source.claimedCca === null || exact(claim.claimedYtd).gt(source.claimedCca)) {
            blockers.push(`CCA schedule ${claim.scheduleId}: select the exact current schedule and fiscal-year line and a supported YTD claim within its reviewed claim.`);
            continue;
        }
        if (ccaSources.some(row => row.assetId === source.assetId)) {
            blockers.push(`CCA asset ${source.assetId}: use one reviewed schedule per asset to avoid double-counting.`);
            continue;
        }
        ccaSources.push({ ...source, claim });
        ccaAdjustments.push({ key: `book:${source.id}`, category: "BOOK_DEPRECIATION", label: "Posted book depreciation add-back", amount: source.bookDepreciation, evidence: source }, { key: `cca:${source.id}`, category: "CCA", label: "Reviewed YTD capital cost allowance", amount: exact(claim.claimedYtd).negated().toString(), evidence: { scheduleId: source.id, ruleVersion: source.ruleVersion, sourceUri: source.sourceUri, rationale: claim.rationale } });
    }
    const calculation = calculateProvision({ assumptions: a, yearStart: assumptions.year_start, yearEnd: assumptions.year_end, currency: scope.currency,
        bookPreTaxIncome: sumExact(sourceJournals.map(row => row.bookIncome)).toString(), priorPostedProvision: sumExact(sourceJournals.filter(row => row.classification?.kind === "CURRENT_YEAR_PROVISION" && row.classification.taxYear === assumptions.fiscal_year).map(row => row.taxExpense)).toString(), ccaAdjustments, sourceBlockers: blockers });
    const liabilityMovements = sourceJournals.filter(row => !exact(row.liabilityMovement).isZero());
    const snapshot = { ...calculation, scope: { ...scope, legalEntityId: assumptions.legal_entity_id, ledgerId: assumptions.ledger_id, fiscalYear: assumptions.fiscal_year, periodId: input.periodId, throughDate: input.throughDate },
        assumptions: { id: assumptions.id, version: assumptions.version, state: assumptions.state, payload: a, recordedBy: assumptions.created_by, recordedAt: new Date(assumptions.created_at).toISOString() },
        mappings: { expense, payable, excludedTaxExpenseAccounts: expenseAccounts }, sources: { ledgerFingerprint: fingerprint, periods, sourceJournals, unposted, ccaSources },
        liabilityRollforward: { openingCreditBalance: exact(opening).toFixed(minorUnits(scope.currency)), movements: liabilityMovements,
            closingCreditBalance: exact(opening).plus(sumExact(liabilityMovements.map(row => row.liabilityMovement))).toFixed(minorUnits(scope.currency)),
            unclassifiedMovementCount: liabilityMovements.filter(row => !row.classification).length,
            explanation: "Liability movements are shown separately. Unclassified movements need review; a debit is not automatically assumed to be an instalment or payment." } };
    return { snapshot, sourceHash: createCommandFingerprint("tax.provision.source", snapshot) };
}
