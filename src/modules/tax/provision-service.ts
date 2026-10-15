import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import { exact, minorUnits } from "@/kernel/money";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { type SessionPrincipal, transactionAuthMethod } from "@/modules/identity/session";
import { createManualJournal } from "@/modules/ledger/journal-service";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import { TaxFilingError, withAuthorizedTaxWrite } from "./filing-service";
import { provisionAssumptionsSchema } from "./provision-model";
import { loadProvisionPreview, provisionAssumption, type ProvisionAssumptionRow } from "./provision-sources";
const reason = z.string().trim().min(8).max(500), key = z.string().trim().min(1).max(180), version = z.number().int().min(0);
export const provisionAssumptionCommandSchema = z.object({ action: z.enum(["SAVE", "REVIEW"]), legalEntityId: z.uuid(), ledgerId: z.uuid(), fiscalYear: z.number().int().min(1900).max(2500), yearStart: z.iso.date(), yearEnd: z.iso.date(), expectedVersion: version, payload: provisionAssumptionsSchema, reason, idempotencyKey: key }).strict().refine(c => c.yearEnd >= c.yearStart && Date.parse(c.yearEnd) - Date.parse(c.yearStart) < 367 * 86400000, { message: "Use a valid fiscal year of at most 367 days" });
export const provisionPreviewSchema = z.object({ assumptionsId: z.uuid(), periodId: z.uuid(), throughDate: z.iso.date() }).strict();
export const provisionCalculationSchema = provisionPreviewSchema.extend({ expectedVersion: version, reason, idempotencyKey: key });
export const provisionEventSchema = z.object({ calculationId: z.uuid(), action: z.enum(["REVIEW", "DRAFT"]), expectedVersion: version, sourceHash: z.string().regex(/^[a-f0-9]{64}$/), reason, idempotencyKey: key }).strict();
type Context = {
    principal: SessionPrincipal;
    requestId: string;
    sourceSurface?: "API" | "MCP";
};
export type ProvisionCalculationRow = {
    id: string;
    organization_id: string;
    legal_entity_id: string;
    ledger_id: string;
    period_id: string;
    assumptions_id: string;
    fiscal_year: number;
    through_date: string;
    version: number;
    snapshot: Awaited<ReturnType<typeof loadProvisionPreview>>["snapshot"];
    source_hash: string;
    command_hash: string;
    created_by: string;
    created_at: string;
};
export type ProvisionEventRow = {
    id: string;
    calculation_id: string;
    version: number;
    action: "REVIEW" | "DRAFT";
    journal_id: string | null;
    source_hash: string;
    command_hash: string;
    created_by: string;
    created_at: string;
    reason: string;
};
function conflict(message: string, code = "PROVISION_CONFLICT"): never { throw new TaxFilingError(message, 409, code); }
function checkReplay(stored: string, hash: string) { if (stored !== hash)
    conflict("The command key already belongs to different inputs.", "IDEMPOTENCY_CONFLICT"); }
export async function commandProvisionAssumptions(input: z.input<typeof provisionAssumptionCommandSchema> & Context) {
    const { principal, requestId, sourceSurface, ...raw } = input, c = provisionAssumptionCommandSchema.parse(raw), org = principal.organizationId;
    const hash = createCommandFingerprint("tax.provision.assumptions", { ...c, idempotencyKey: undefined });
    return withAuthorizedTaxWrite({ principal, requestId, sourceSurface, permission: PERMISSIONS.manageTaxFilingConfiguration, reason: c.reason, idempotencyKey: c.idempotencyKey, isolationLevel: "SERIALIZABLE" }, async (client) => {
        const replay = (await client.query<ProvisionAssumptionRow>("SELECT *,year_start::text,year_end::text FROM tax_provision_assumptions WHERE organization_id=$1 AND idempotency_key=$2", [org, c.idempotencyKey])).rows[0];
        if (replay) {
            checkReplay(replay.command_hash, hash);
            return { assumptions: replay, idempotentReplay: true };
        }
        const previous = (await client.query<ProvisionAssumptionRow>("SELECT *,year_start::text,year_end::text FROM tax_provision_assumptions WHERE organization_id=$1 AND ledger_id=$2 AND fiscal_year=$3 ORDER BY version DESC LIMIT 1", [org, c.ledgerId, c.fiscalYear])).rows[0];
        if ((previous?.version ?? 0) !== c.expectedVersion)
            conflict("Assumptions changed. Reload the latest version.", "PROVISION_VERSION_CONFLICT");
        if (!(await client.query("SELECT 1 FROM ledgers WHERE organization_id=$1 AND id=$2 AND legal_entity_id=$3 AND active", [org, c.ledgerId, c.legalEntityId])).rowCount)
            conflict("The entity and ledger are outside this active organization scope.");
        if (c.action === "REVIEW" && (!previous || previous.state !== "DRAFT" || previous.legal_entity_id !== c.legalEntityId || previous.year_start !== c.yearStart || previous.year_end !== c.yearEnd || createCommandFingerprint("payload", previous.payload) !== createCommandFingerprint("payload", c.payload)))
            conflict("Review requires the exact current draft inputs and fiscal dates.");
        const row = (await client.query<ProvisionAssumptionRow>(`INSERT INTO tax_provision_assumptions(organization_id,legal_entity_id,ledger_id,fiscal_year,year_start,year_end,version,state,payload,supersedes_id,reason,idempotency_key,command_hash,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *,year_start::text,year_end::text`, [org, c.legalEntityId, c.ledgerId, c.fiscalYear, c.yearStart, c.yearEnd, c.expectedVersion + 1, c.action === "REVIEW" ? "REVIEWED" : "DRAFT", c.payload, previous?.id ?? null, c.reason, c.idempotencyKey, hash, principal.userId])).rows[0]!;
        return { assumptions: row, idempotentReplay: false };
    });
}
async function read<T>(principal: SessionPrincipal, work: (client: PoolClient) => Promise<T>) { return withWorkspaceTenantRead({ organizationId: principal.organizationId, actorId: principal.userId, sessionId: principal.sessionId, sessionMode: principal.sessionMode, authMethod: transactionAuthMethod(principal), requestId: randomUUID(), sourceSurface: "API" }, "/app/tax/provision", async (client) => { await assertActorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.readTax }); return work(client); }); }
export async function previewProvision(principal: SessionPrincipal, input: z.input<typeof provisionPreviewSchema>) { const c = provisionPreviewSchema.parse(input); return read(principal, client => loadProvisionPreview(client, principal.organizationId, c)); }
export async function listProvisions(principal: SessionPrincipal) {
    return read(principal, async (client) => {
        const org = principal.organizationId;
        const assumptions = (await client.query<ProvisionAssumptionRow>("SELECT *,year_start::text,year_end::text FROM tax_provision_assumptions WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 500", [org])).rows;
        const calculations = (await client.query<ProvisionCalculationRow>("SELECT *,through_date::text FROM tax_provision_calculations WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 200", [org])).rows;
        const events = (await client.query<ProvisionEventRow & {
            journal_status: string | null;
            journal_deleted: boolean;
        }>(`SELECT event.*,journal.status AS journal_status,EXISTS(SELECT 1 FROM journal_transaction_controls control WHERE control.organization_id=event.organization_id AND control.journal_entry_id=event.journal_id AND control.outcome='DELETED') AS journal_deleted
  FROM tax_provision_events event LEFT JOIN journal_entries journal ON journal.organization_id=event.organization_id AND journal.id=event.journal_id WHERE event.organization_id=$1 AND event.calculation_id=ANY($2::uuid[]) ORDER BY event.version`, [org, calculations.map(c => c.id)])).rows;
        return { assumptions, calculations, events };
    });
}
export async function saveProvisionCalculation(input: z.input<typeof provisionCalculationSchema> & Context) {
    const { principal, requestId, sourceSurface, ...raw } = input, c = provisionCalculationSchema.parse(raw), org = principal.organizationId, hash = createCommandFingerprint("tax.provision.calculate", { ...c, idempotencyKey: undefined });
    return withAuthorizedTaxWrite({ principal, requestId, sourceSurface, permission: PERMISSIONS.prepareTaxFilings, reason: c.reason, idempotencyKey: c.idempotencyKey, isolationLevel: "SERIALIZABLE" }, async (client) => {
        const replay = (await client.query<ProvisionCalculationRow>("SELECT *,through_date::text FROM tax_provision_calculations WHERE organization_id=$1 AND idempotency_key=$2", [org, c.idempotencyKey])).rows[0];
        if (replay) {
            checkReplay(replay.command_hash, hash);
            return { calculation: replay, idempotentReplay: true };
        }
        const preview = await loadProvisionPreview(client, org, c), a = await provisionAssumption(client, org, c.assumptionsId);
        const existing = (await client.query<ProvisionCalculationRow>("SELECT *,through_date::text FROM tax_provision_calculations WHERE organization_id=$1 AND source_hash=$2", [org, preview.sourceHash])).rows[0];
        if (existing)
            return { calculation: existing, idempotentReplay: true };
        const latest = (await client.query<{
            version: number;
        }>("SELECT version FROM tax_provision_calculations WHERE organization_id=$1 AND ledger_id=$2 AND through_date=$3 ORDER BY version DESC LIMIT 1", [org, a.ledger_id, c.throughDate])).rows[0];
        if ((latest?.version ?? 0) !== c.expectedVersion)
            conflict("The calculation changed. Reload its current version.", "PROVISION_VERSION_CONFLICT");
        const row = (await client.query<ProvisionCalculationRow>(`INSERT INTO tax_provision_calculations(organization_id,legal_entity_id,ledger_id,period_id,assumptions_id,fiscal_year,through_date,version,snapshot,source_hash,reason,idempotency_key,command_hash,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *,through_date::text`, [org, a.legal_entity_id, a.ledger_id, c.periodId, a.id, a.fiscal_year, c.throughDate, c.expectedVersion + 1, preview.snapshot, preview.sourceHash, c.reason, c.idempotencyKey, hash, principal.userId])).rows[0]!;
        return { calculation: row, idempotentReplay: false };
    });
}
export async function commandProvisionEvent(input: z.input<typeof provisionEventSchema> & Context) {
    const { principal, requestId, sourceSurface, ...raw } = input, c = provisionEventSchema.parse(raw), org = principal.organizationId, hash = createCommandFingerprint("tax.provision.event", { ...c, idempotencyKey: undefined });
    return withAuthorizedTaxWrite({ principal, requestId, sourceSurface, permission: PERMISSIONS.prepareTaxFilings, reason: c.reason, idempotencyKey: c.idempotencyKey, isolationLevel: "SERIALIZABLE" }, async (client) => {
        if (c.action === "DRAFT")
            await assertActorHasActivePermission(client, { organizationId: org, actorId: principal.userId, permission: PERMISSIONS.draftJournal });
        const replay = (await client.query<ProvisionEventRow>("SELECT * FROM tax_provision_events WHERE organization_id=$1 AND idempotency_key=$2", [org, c.idempotencyKey])).rows[0];
        if (replay) {
            checkReplay(replay.command_hash, hash);
            return { event: replay, idempotentReplay: true };
        }
        const calc = (await client.query<ProvisionCalculationRow>("SELECT *,through_date::text FROM tax_provision_calculations WHERE organization_id=$1 AND id=$2", [org, c.calculationId])).rows[0];
        if (!calc)
            throw new TaxFilingError("This calculation was not found in the organization.", 404, "PROVISION_NOT_FOUND");
        if (calc.source_hash !== c.sourceHash)
            conflict("Use the exact saved calculation hash.", "PROVISION_REVIEW_STALE");
        const current = (await client.query<ProvisionEventRow>("SELECT * FROM tax_provision_events WHERE organization_id=$1 AND calculation_id=$2 ORDER BY version DESC LIMIT 1", [org, calc.id])).rows[0];
        // A completed generation is replayed before checking sources or a subsequently closed period.
        if (current?.action === "DRAFT") {
            if (c.action === "DRAFT")
                return { event: current, idempotentReplay: true };
            conflict("This calculation already has a generation decision. Calculate a new version for changes.");
        }
        if ((current?.version ?? 0) !== c.expectedVersion)
            conflict("The review changed. Reload its latest event.", "PROVISION_VERSION_CONFLICT");
        const preview = await loadProvisionPreview(client, org, { assumptionsId: calc.assumptions_id, periodId: calc.period_id, throughDate: calc.through_date });
        if (preview.sourceHash !== calc.source_hash)
            conflict("Books, mappings, periods or assumptions changed. Save and review a fresh calculation.", "PROVISION_REVIEW_STALE");
        if (!preview.snapshot.ready)
            conflict(`Resolve calculation blockers: ${preview.snapshot.blockers.join(" ")}`, "PROVISION_BLOCKED");
        let journalId: string | null = null;
        if (c.action === "DRAFT") {
            if (current?.action !== "REVIEW")
                conflict("Review the exact calculation before requesting its draft journal.");
            if (["HARD_CLOSED", "SEALED"].includes(preview.snapshot.scope.periodState))
                conflict("The selected period cannot accept a provision draft.", "PROVISION_PERIOD_CLOSED");
            const outstanding = (await client.query(`SELECT event.journal_id FROM tax_provision_events event JOIN tax_provision_calculations calculation ON calculation.organization_id=event.organization_id AND calculation.id=event.calculation_id
    JOIN journal_entries journal ON journal.organization_id=event.organization_id AND journal.id=event.journal_id
    WHERE event.organization_id=$1 AND calculation.ledger_id=$2 AND calculation.fiscal_year=$3 AND event.action='DRAFT' AND journal.status<>'POSTED'
    AND NOT EXISTS(SELECT 1 FROM journal_transaction_controls control WHERE control.organization_id=journal.organization_id AND control.journal_entry_id=journal.id AND control.outcome='DELETED') LIMIT 1`, [org, calc.ledger_id, calc.fiscal_year])).rows[0];
            if (outstanding)
                conflict(`Resolve outstanding provision journal ${outstanding.journal_id} before generating another adjustment.`);
            const amount = exact(preview.snapshot.incrementalAdjustment), a = preview.snapshot.assumptions.payload;
            if (!amount.isZero()) {
                const value = amount.abs().toFixed(minorUnits(preview.snapshot.currency)), positive = amount.gt(0);
                const line = (accountCombinationId: string, debit: boolean) => ({ accountCombinationId, debitFunctional: debit ? value : "0", creditFunctional: debit ? "0" : value, transactionCurrency: preview.snapshot.currency, debitTransaction: debit ? value : "0", creditTransaction: debit ? "0" : value, fxRate: "1", fxRateSource: "Functional-currency provision", fxRateEffectiveAt: `${calc.through_date}T00:00:00.000Z`, memo: `Provision calculation ${calc.id}` });
                const journal = await createManualJournal({ context: { organizationId: org, actorId: principal.userId, sessionId: principal.sessionId, sessionMode: principal.sessionMode, authMethod: transactionAuthMethod(principal), requestId, sourceSurface: sourceSurface ?? "API", reason: c.reason },
                    ledgerId: calc.ledger_id, legalEntityId: calc.legal_entity_id, periodId: calc.period_id, accountingDate: calc.through_date, purpose: "TAX_ADJUSTMENT", origin: sourceSurface ?? "API", description: `Current income-tax provision ${calc.fiscal_year} through ${calc.through_date}; calculation ${calc.id}`, idempotencyKey: `provision:${calc.id}`, lines: [line(a.expenseCombinationId!, positive), line(a.payableCombinationId!, !positive)] }, client);
                if (journal.status !== "DRAFT")
                    conflict("Provision generation must create an unposted draft.");
                journalId = journal.journalId;
            }
        }
        const event = (await client.query<ProvisionEventRow>(`INSERT INTO tax_provision_events(organization_id,calculation_id,version,action,journal_id,source_hash,reason,idempotency_key,command_hash,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [org, calc.id, c.expectedVersion + 1, c.action, journalId, c.sourceHash, c.reason, c.idempotencyKey, hash, principal.userId])).rows[0]!;
        return { event, idempotentReplay: false };
    });
}
export async function provisionWorkspaceOptions(principal: SessionPrincipal) {
    return read(principal, async (client) => {
        const org = principal.organizationId;
        const ledgers = (await client.query<{
            id: string;
            entityId: string;
            label: string;
            currency: string;
        }>(`SELECT ledger.id,ledger.legal_entity_id AS "entityId",entity.display_name||' · '||ledger.code AS label,ledger.functional_currency AS currency FROM ledgers ledger JOIN legal_entities entity ON entity.organization_id=ledger.organization_id AND entity.id=ledger.legal_entity_id WHERE ledger.organization_id=$1 AND ledger.active AND entity.active ORDER BY label`, [org])).rows;
        const periods = (await client.query<{
            id: string;
            ledgerId: string;
            fiscalYear: number;
            label: string;
            startsOn: string;
            endsOn: string;
            state: string;
        }>(`SELECT id,ledger_id AS "ledgerId",fiscal_year AS "fiscalYear",label,starts_on::text AS "startsOn",ends_on::text AS "endsOn",state FROM fiscal_periods WHERE organization_id=$1 ORDER BY ends_on DESC,id LIMIT 500`, [org])).rows;
        const combinations = (await client.query<{
            id: string;
            accountId: string;
            ledgerId: string;
            label: string;
            accountClass: string;
        }>(`SELECT combination.id,account.id AS "accountId",combination.ledger_id AS "ledgerId",account.code||' · '||account.display_name||' · '||combination.id AS label,account.class AS "accountClass" FROM account_combinations combination JOIN gl_accounts account ON account.organization_id=combination.organization_id AND account.id=combination.account_id WHERE combination.organization_id=$1 AND combination.active AND account.active AND account.postable AND account.control_kind='NONE' ORDER BY account.code,combination.id`, [org])).rows;
        const capabilities = (await client.query<{
            configure: boolean;
            prepare: boolean;
            draft: boolean;
        }>("SELECT app.current_actor_has_permission('tax.filing.configuration.manage') AS configure,app.current_actor_has_permission('tax.filings.prepare') AS prepare,app.current_actor_has_permission('ledger.journal.draft') AS draft")).rows[0]!;
        return { ledgers, periods, combinations, capabilities };
    });
}
