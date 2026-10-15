import { decryptIdentityField } from "@/security/identity-secret";
import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { createCommandFingerprint } from "@/kernel/command-fingerprint";
import { assertActorHasActivePermission, actorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { type SessionPrincipal, transactionAuthMethod } from "@/modules/identity/session";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import { withAuthorizedTaxWrite, TaxFilingError } from "@/modules/tax/filing-service";
import { closeTemplateSchema, closeTaskInputSchema, closeReason, closeKey, closeDueDate, completedCloseStatus, type CloseTaskDefinition, type CloseTaskInput, defaultCloseTemplate } from "./checklist-model";
import { loadCloseChecklistSources, type CloseSourceFact } from "./checklist-sources";
export type CloseTemplateRow = {
    id: string;
    template_id: string;
    version: number;
    definition: z.infer<typeof closeTemplateSchema>;
    created_by: string;
    created_at: string;
    reason: string;
    command_hash: string;
};
export type CloseInstanceRow = {
    id: string;
    legal_entity_id: string;
    ledger_id: string;
    period_id: string;
    template_revision_id: string;
    task_definitions: CloseTaskDefinition[];
    created_by: string;
    created_at: string;
    reason: string;
    command_hash: string;
};
export type CloseTaskRow = {
    id: string;
    instance_id: string;
    task_key: string;
    version: number;
    definition: CloseTaskDefinition;
    input: CloseTaskInput;
    review: Record<string, unknown> | null;
    source_hash: string | null;
    carried_from_revision_id: string | null;
    created_by: string;
    created_at: string;
    reason: string;
    command_hash: string;
};
type Context = {
    principal: SessionPrincipal;
    requestId: string;
    sourceSurface?: "API" | "MCP";
};
export const saveCloseTemplateSchema = z.object({ templateId: z.uuid(), expectedVersion: z.number().int().min(0), definition: closeTemplateSchema, reason: closeReason, idempotencyKey: closeKey }).strict();
export const createCloseInstanceSchema = z.object({ periodId: z.uuid(), templateRevisionId: z.uuid(), reason: closeReason, idempotencyKey: closeKey }).strict();
export const commandCloseTaskSchema = z.object({ instanceId: z.uuid(), taskKey: z.string().min(1).max(180), action: z.enum(["UPDATE", "REVIEW", "COMPLETE", "NOT_APPLICABLE"]), expectedVersion: z.number().int().min(0), input: closeTaskInputSchema.optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), reason: closeReason, idempotencyKey: closeKey }).strict();
export const carryCloseTaskSchema = z.object({ fromInstanceId: z.uuid(), taskKey: z.string().min(1).max(180), expectedVersion: z.number().int().min(0), toInstanceId: z.uuid(), dueOn: z.iso.date(), reason: closeReason, idempotencyKey: closeKey }).strict();
export const closeInstanceQuerySchema = z.object({ instanceId: z.uuid() }).strict();
function fail(message: string, code = "CLOSE_CONFLICT"): never { throw new TaxFilingError(message, 409, code); }
function replay(stored: string, expected: string) {
    if (stored !== expected)
        fail("This command key was used for different close inputs.", "IDEMPOTENCY_CONFLICT");
}
async function read<T>(principal: SessionPrincipal, work: (client: PoolClient) => Promise<T>) { return withWorkspaceTenantRead({ organizationId: principal.organizationId, actorId: principal.userId, sessionId: principal.sessionId, sessionMode: principal.sessionMode, authMethod: transactionAuthMethod(principal), requestId: randomUUID(), sourceSurface: principal.mcpConnectionId ? "MCP" : "API" }, "/app/controls/period-close", async (client) => { await assertActorHasActivePermission(client, { organizationId: principal.organizationId, actorId: principal.userId, permission: PERMISSIONS.readMcpLedger }); return work(client); }, { isolationLevel: "REPEATABLE READ" }); }
async function members(client: PoolClient, org: string, ids: (string | null)[]) {
    for (const id of new Set(ids.filter((id): id is string => !!id))) {
        if (!(await client.query("SELECT 1 FROM app.close_assignable_members() person WHERE app.current_organization_id()=$1 AND person.id=$2", [org, id])).rowCount)
            fail("Owners and reviewers must be active members of this organization.", "CLOSE_MEMBER_INVALID");
    }
}
async function instance(client: PoolClient, org: string, id: string) {
    const row = (await client.query<CloseInstanceRow>("SELECT * FROM close_instances WHERE organization_id=$1 AND id=$2", [org, id])).rows[0];
    if (!row)
        throw new TaxFilingError("The close instance was not found in this organization.", 404, "CLOSE_NOT_FOUND");
    return row;
}
export type CloseTaskView = {
    key: string;
    definition: CloseTaskDefinition;
    version: number;
    input: CloseTaskInput;
    effectiveStatus: CloseTaskInput["status"];
    stale: boolean;
    blockers: string[];
    source: CloseSourceFact;
    sourceHash: string;
    review: Record<string, unknown> | null;
    record: CloseTaskRow | null;
    sourcePeriodId: string;
    carriedFromRevisionId: string | null;
    allowedActions: string[];
    dependencies: {
        key: string;
        version: number;
        status: CloseTaskInput["status"];
        sourceHash: string;
    }[];
};
export async function loadCloseInstanceInTransaction(client: PoolClient, org: string, actorId: string, instanceId: string) {
    const saved = await instance(client, org, instanceId), sources = await loadCloseChecklistSources(client, org, actorId, saved.period_id);
    const history = (await client.query<CloseTaskRow>("SELECT * FROM close_task_revisions WHERE organization_id=$1 AND instance_id=$2 ORDER BY task_key,version", [org, instanceId])).rows;
    const current = new Map<string, CloseTaskRow>();
    for (const row of history)
        current.set(row.task_key, row);
    const definitions = new Map(saved.task_definitions.map(definition => [definition.key, definition]));
    for (const row of current.values())
        if (row.carried_from_revision_id)
            definitions.set(row.task_key, row.definition);
    const sourceCache = new Map([[saved.period_id, sources]]), sourcePeriods = new Map<string, string>();
    for (const row of current.values()) {
        if (!row.carried_from_revision_id)
            continue;
        const origin = (await client.query<{
            periodId: string;
        }>(`WITH RECURSIVE lineage AS (SELECT id,instance_id,carried_from_revision_id,ARRAY[id] AS visited FROM close_task_revisions WHERE organization_id=$1 AND id=$2 UNION ALL SELECT prior.id,prior.instance_id,prior.carried_from_revision_id,lineage.visited||prior.id FROM lineage JOIN close_task_revisions prior ON prior.organization_id=$1 AND prior.id=lineage.carried_from_revision_id WHERE NOT(prior.id=ANY(lineage.visited))) SELECT instance.period_id AS "periodId" FROM lineage JOIN close_instances instance ON instance.organization_id=$1 AND instance.id=lineage.instance_id WHERE lineage.carried_from_revision_id IS NULL LIMIT 1`, [org, row.carried_from_revision_id])).rows[0];
        if (!origin)
            fail("The carry-forward origin could not be verified.");
        sourcePeriods.set(row.task_key, origin.periodId);
        if (!sourceCache.has(origin.periodId))
            sourceCache.set(origin.periodId, await loadCloseChecklistSources(client, org, actorId, origin.periodId));
    }
    const canManage = await actorHasActivePermission(client, { organizationId: org, actorId, permission: PERMISSIONS.closePeriod });
    const resolved = new Map<string, CloseTaskView>();
    function resolveTask(key: string, path = new Set<string>()): CloseTaskView {
        const existing = resolved.get(key);
        if (existing)
            return existing;
        if (path.has(key))
            fail("Close prerequisites contain a cycle.");
        const definition = definitions.get(key);
        if (!definition)
            fail("A close prerequisite is missing.");
        const row = current.get(key) ?? null, input = row?.input ?? { ownerId: definition.ownerId, reviewerId: definition.reviewerId, dueOn: closeDueDate(sources.scope.endsOn, definition.dueOffsetDays), status: "NOT_STARTED" as const, blockingReason: null, evidence: [] };
        const sourcePeriodId = sourcePeriods.get(key) ?? saved.period_id, source = sourceCache.get(sourcePeriodId)!.facts[definition.source];
        const prereqs = definition.source === "SIGNOFF" ? [...definitions.keys()].filter(item => item !== key) : definition.prerequisites;
        const dependencies = prereqs.map(dep => resolveTask(dep, new Set(path).add(key))).map(dep => ({ key: dep.key, version: dep.version, status: dep.effectiveStatus, sourceHash: dep.sourceHash }));
        const sourceHash = createCommandFingerprint("close.task.review", { definition, sourcePeriodId, sourceHash: source.hash, ownerId: input.ownerId, reviewerId: input.reviewerId, dueOn: input.dueOn, evidence: input.evidence, dependencies });
        const reviewed = ["REVIEWED", "COMPLETE", "NOT_APPLICABLE"].includes(input.status), stale = reviewed && row?.source_hash !== sourceHash;
        const blockers = [...(!source.available ? [source.detail] : !source.ready && input.status !== "NOT_APPLICABLE" ? [source.detail] : []), ...dependencies.filter(dep => !completedCloseStatus(dep.status)).map(dep => `Prerequisite ${dep.key} is ${dep.status.toLowerCase().replaceAll("_", " ")}.`), ...(stale ? ["Source facts, inputs or prerequisites changed after review. Review current evidence again."] : []), ...(input.blockingReason ? [input.blockingReason] : [])];
        let effectiveStatus = input.status;
        if (stale || (input.status !== "NOT_STARTED" && blockers.length))
            effectiveStatus = "BLOCKED";
        else if (input.status === "NOT_STARTED")
            effectiveStatus = source.ready && dependencies.every(dep => completedCloseStatus(dep.status)) ? "READY" : "NOT_STARTED";
        const assigned = canManage && input.reviewerId === actorId && !!input.ownerId && input.evidence.length > 0 && !input.blockingReason && source.available && dependencies.every(dep => completedCloseStatus(dep.status));
        const allowedActions = ["READ_SOURCE", ...(canManage ? ["UPDATE"] : []), ...(assigned && source.ready ? ["REVIEW"] : []), ...(assigned && source.ready && input.status === "REVIEWED" && !stale ? ["COMPLETE"] : []), ...(assigned && definition.source !== "SIGNOFF" ? ["NOT_APPLICABLE"] : []), ...(canManage && !completedCloseStatus(effectiveStatus) && definition.source !== "SIGNOFF" ? ["CARRY_FORWARD"] : [])];
        const view = { allowedActions, key, definition, version: row?.version ?? 0, input, effectiveStatus, stale, blockers, source, sourceHash, review: row?.review ?? null, record: row, sourcePeriodId, carriedFromRevisionId: row?.carried_from_revision_id ?? null, dependencies };
        resolved.set(key, view);
        return view;
    }
    const tasks = [...definitions.keys()].map(key => resolveTask(key));
    return { instance: saved, scope: sources.scope, tasks, history, ready: tasks.every(task => completedCloseStatus(task.effectiveStatus)), checkedAt: new Date().toISOString() };
}
export async function inspectCloseInstance(principal: SessionPrincipal, instanceId: string) { z.uuid().parse(instanceId); return read(principal, client => loadCloseInstanceInTransaction(client, principal.organizationId, principal.userId, instanceId)); }
export async function saveCloseTemplate(input: z.input<typeof saveCloseTemplateSchema> & Context) {
    const { principal, requestId, sourceSurface, ...raw } = input, c = saveCloseTemplateSchema.parse(raw), org = principal.organizationId, hash = createCommandFingerprint("close.template", { ...c, idempotencyKey: undefined });
    return withAuthorizedTaxWrite({ principal, requestId, sourceSurface, permission: PERMISSIONS.closePeriod, reason: c.reason, idempotencyKey: c.idempotencyKey, isolationLevel: "SERIALIZABLE" }, async (client) => {
        const old = (await client.query<CloseTemplateRow>("SELECT * FROM close_template_revisions WHERE organization_id=$1 AND idempotency_key=$2", [org, c.idempotencyKey])).rows[0];
        if (old) {
            replay(old.command_hash, hash);
            return { template: old, idempotentReplay: true };
        }
        const latest = (await client.query<{
            version: number;
        }>("SELECT version FROM close_template_revisions WHERE organization_id=$1 AND template_id=$2 ORDER BY version DESC LIMIT 1", [org, c.templateId])).rows[0];
        if ((latest?.version ?? 0) !== c.expectedVersion)
            fail("The template changed. Reload its current revision.", "CLOSE_VERSION_CONFLICT");
        await members(client, org, c.definition.tasks.flatMap(task => [task.ownerId, task.reviewerId]));
        const template = (await client.query<CloseTemplateRow>("INSERT INTO close_template_revisions(organization_id,template_id,version,definition,reason,idempotency_key,command_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [org, c.templateId, c.expectedVersion + 1, c.definition, c.reason, c.idempotencyKey, hash, principal.userId])).rows[0]!;
        return { template, idempotentReplay: false };
    });
}
export async function createCloseInstance(input: z.input<typeof createCloseInstanceSchema> & Context) {
    const { principal, requestId, sourceSurface, ...raw } = input, c = createCloseInstanceSchema.parse(raw), org = principal.organizationId, hash = createCommandFingerprint("close.instance", { ...c, idempotencyKey: undefined });
    return withAuthorizedTaxWrite({ principal, requestId, sourceSurface, permission: PERMISSIONS.closePeriod, reason: c.reason, idempotencyKey: c.idempotencyKey, isolationLevel: "SERIALIZABLE" }, async (client) => {
        const old = (await client.query<CloseInstanceRow>("SELECT * FROM close_instances WHERE organization_id=$1 AND idempotency_key=$2", [org, c.idempotencyKey])).rows[0];
        if (old) {
            replay(old.command_hash, hash);
            return { instance: old, idempotentReplay: true };
        }
        const existing = (await client.query<CloseInstanceRow>("SELECT * FROM close_instances WHERE organization_id=$1 AND period_id=$2", [org, c.periodId])).rows[0];
        if (existing) {
            if (existing.template_revision_id !== c.templateRevisionId)
                fail("This period already has a close instance with its original template. Resume that instance.");
            return { instance: existing, idempotentReplay: true };
        }
        const template = (await client.query<CloseTemplateRow>("SELECT * FROM close_template_revisions WHERE organization_id=$1 AND id=$2", [org, c.templateRevisionId])).rows[0];
        if (!template)
            fail("Choose a template revision from this organization.");
        const period = await loadCloseChecklistSources(client, org, principal.userId, c.periodId);
        await members(client, org, template.definition.tasks.flatMap(task => [task.ownerId, task.reviewerId]));
        const created = (await client.query<CloseInstanceRow>("INSERT INTO close_instances(organization_id,legal_entity_id,ledger_id,period_id,template_revision_id,task_definitions,reason,idempotency_key,command_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *", [org, period.scope.legalEntityId, period.scope.ledgerId, c.periodId, template.id, JSON.stringify(template.definition.tasks), c.reason, c.idempotencyKey, hash, principal.userId])).rows[0]!;
        return { instance: created, idempotentReplay: false };
    });
}
async function insertTask(client: PoolClient, org: string, actor: string, task: CloseTaskView, instanceId: string, input: CloseTaskInput, review: Record<string, unknown> | null, sourceHash: string | null, reason: string, key: string, hash: string) { return (await client.query<CloseTaskRow>("INSERT INTO close_task_revisions(organization_id,instance_id,task_key,version,definition,input,review,source_hash,carried_from_revision_id,reason,idempotency_key,command_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *", [org, instanceId, task.key, task.version + 1, task.definition, input, review, sourceHash, task.carriedFromRevisionId, reason, key, hash, actor])).rows[0]!; }
export async function commandCloseTask(input: z.input<typeof commandCloseTaskSchema> & Context) {
    const { principal, requestId, sourceSurface, ...raw } = input, c = commandCloseTaskSchema.parse(raw), org = principal.organizationId, hash = createCommandFingerprint("close.task", { ...c, idempotencyKey: undefined });
    return withAuthorizedTaxWrite({ principal, requestId, sourceSurface, permission: PERMISSIONS.closePeriod, reason: c.reason, idempotencyKey: c.idempotencyKey, isolationLevel: "SERIALIZABLE" }, async (client) => {
        const old = (await client.query<CloseTaskRow>("SELECT * FROM close_task_revisions WHERE organization_id=$1 AND idempotency_key=$2", [org, c.idempotencyKey])).rows[0];
        if (old) {
            replay(old.command_hash, hash);
            return { task: old, idempotentReplay: true };
        }
        const view = await loadCloseInstanceInTransaction(client, org, principal.userId, c.instanceId), task = view.tasks.find(task => task.key === c.taskKey);
        if (!task)
            fail("Choose a task in this close instance.");
        if (task.version !== c.expectedVersion)
            fail("This task changed. Reload its current revision.", "CLOSE_VERSION_CONFLICT");
        let next = c.input ?? task.input, review: Record<string, unknown> | null = null, sourceHash: string | null = null;
        await members(client, org, [next.ownerId, next.reviewerId]);
        if (c.action === "UPDATE") {
            if (!c.input || ["REVIEWED", "COMPLETE", "NOT_APPLICABLE"].includes(next.status))
                fail("Save working inputs before a separate review or completion decision.");
            if (next.status === "BLOCKED" && !next.blockingReason)
                fail("Explain the blocking reason.");
        }
        else {
            if (c.input && createCommandFingerprint("input", c.input) !== createCommandFingerprint("input", task.input))
                fail("Save changed inputs before reviewing their current sources.");
            if (task.input.reviewerId !== principal.userId || !task.input.ownerId)
                fail("An active assigned owner and the assigned reviewer are required.", "CLOSE_REVIEWER_REQUIRED");
            if (!task.input.evidence.length || task.input.blockingReason)
                fail("Record supporting evidence and resolve the explicit blocking reason first.");
            if (c.sourceHash !== task.sourceHash)
                fail("Source facts changed. Inspect their current fingerprint before review.", "CLOSE_SOURCE_STALE");
            if (!task.source.available)
                fail(task.source.detail, "CLOSE_SOURCE_UNKNOWN");
            if (task.dependencies.some(dep => !completedCloseStatus(dep.status)))
                fail("Complete the current prerequisites first.", "CLOSE_PREREQUISITES");
            if (c.action === "NOT_APPLICABLE") {
                if (task.definition.source === "SIGNOFF")
                    fail("Final sign-off cannot be marked not applicable.");
            }
            else if (!task.source.ready)
                fail(task.source.detail, "CLOSE_SOURCE_BLOCKED");
            if (c.action === "COMPLETE" && (task.input.status !== "REVIEWED" || task.stale))
                fail("Review these exact current inputs and sources before completion.", "CLOSE_REVIEW_REQUIRED");
            next = { ...task.input, status: c.action === "REVIEW" ? "REVIEWED" : c.action === "COMPLETE" ? "COMPLETE" : "NOT_APPLICABLE" };
            sourceHash = task.sourceHash;
            review = { actorId: principal.userId, reviewedAt: new Date().toISOString(), reason: c.reason, sourcePeriodId: task.sourcePeriodId, source: task.source, dependencies: task.dependencies, priorRevisionId: task.record?.id ?? null };
        }
        return { task: await insertTask(client, org, principal.userId, task, c.instanceId, next, review, sourceHash, c.reason, c.idempotencyKey, hash), idempotentReplay: false };
    });
}
export async function carryCloseTask(input: z.input<typeof carryCloseTaskSchema> & Context) {
    const { principal, requestId, sourceSurface, ...raw } = input, c = carryCloseTaskSchema.parse(raw), org = principal.organizationId, hash = createCommandFingerprint("close.carry", { ...c, idempotencyKey: undefined });
    return withAuthorizedTaxWrite({ principal, requestId, sourceSurface, permission: PERMISSIONS.closePeriod, reason: c.reason, idempotencyKey: c.idempotencyKey, isolationLevel: "SERIALIZABLE" }, async (client) => {
        const old = (await client.query<CloseTaskRow>("SELECT * FROM close_task_revisions WHERE organization_id=$1 AND idempotency_key=$2", [org, c.idempotencyKey])).rows[0];
        if (old) {
            replay(old.command_hash, hash);
            return { task: old, idempotentReplay: true };
        }
        const from = await loadCloseInstanceInTransaction(client, org, principal.userId, c.fromInstanceId), to = await loadCloseInstanceInTransaction(client, org, principal.userId, c.toInstanceId), task = from.tasks.find(task => task.key === c.taskKey);
        if (!task || task.version !== c.expectedVersion)
            fail("The originating task changed. Reload before carrying it forward.", "CLOSE_VERSION_CONFLICT");
        if (completedCloseStatus(task.effectiveStatus) || task.definition.source === "SIGNOFF")
            fail("Only unresolved individual tasks can be carried forward.");
        if (from.scope.legalEntityId !== to.scope.legalEntityId || from.scope.ledgerId !== to.scope.ledgerId || to.scope.startsOn <= from.scope.endsOn)
            fail("Choose a later period in the same entity and ledger.");
        const key = `carry:${from.instance.id}:${createCommandFingerprint("origin", task.key).slice(0, 32)}`;
        if (to.tasks.some(item => item.key === key))
            fail("This unresolved task already exists in the target period. Resume its existing record.");
        const original = task.record ?? await insertTask(client, org, principal.userId, task, c.fromInstanceId, task.input, null, null, c.reason, `origin:${randomUUID()}`, createCommandFingerprint("close.materialize", { instance: c.fromInstanceId, key: task.key }));
        const carried = { ...task, key, version: 0, definition: { ...task.definition, label: `Carried: ${task.definition.label}`.slice(0, 160), prerequisites: [] }, carriedFromRevisionId: original.id };
        return { task: await insertTask(client, org, principal.userId, carried, c.toInstanceId, { ...task.input, dueOn: c.dueOn, status: "NOT_STARTED", blockingReason: `Unresolved work from ${from.scope.label}. ${c.reason}`, evidence: [] }, null, null, c.reason, c.idempotencyKey, hash), idempotentReplay: false };
    });
}
export const closeNotificationSchema = z.object({ instanceId: z.uuid(), recipientId: z.uuid(), expectedVersion: z.number().int().min(0), enabled: z.boolean(), dueWithinDays: z.number().int().min(0).max(30), events: z.array(z.enum(["DUE", "OVERDUE", "BLOCKER"])).max(3), reason: closeReason, idempotencyKey: closeKey }).strict();
type Preference = {
    instance_id: string;
    recipient_id: string;
    version: number;
    enabled: boolean;
    due_within_days: number;
    events: string[];
    command_hash: string;
};
export async function configureCloseNotifications(input: z.input<typeof closeNotificationSchema> & Context) {
    const { principal, requestId, sourceSurface, ...raw } = input, c = closeNotificationSchema.parse(raw), org = principal.organizationId, hash = createCommandFingerprint("close.notifications", { ...c, idempotencyKey: undefined });
    return withAuthorizedTaxWrite({ principal, requestId, sourceSurface, permission: PERMISSIONS.closePeriod, reason: c.reason, idempotencyKey: c.idempotencyKey, isolationLevel: "SERIALIZABLE" }, async (client) => {
        if (c.recipientId !== principal.userId)
            fail("Each recipient must explicitly opt in to their own in-app notices.");
        await instance(client, org, c.instanceId);
        await members(client, org, [c.recipientId]);
        const old = (await client.query<Preference>("SELECT * FROM close_notification_preferences WHERE organization_id=$1 AND idempotency_key=$2", [org, c.idempotencyKey])).rows[0];
        if (old) {
            replay(old.command_hash, hash);
            return { preference: old, idempotentReplay: true };
        }
        const latest = (await client.query<Preference>("SELECT * FROM close_notification_preferences WHERE organization_id=$1 AND instance_id=$2 AND recipient_id=$3 ORDER BY version DESC LIMIT 1", [org, c.instanceId, c.recipientId])).rows[0];
        if ((latest?.version ?? 0) !== c.expectedVersion)
            fail("Notice preferences changed. Reload first.", "CLOSE_VERSION_CONFLICT");
        const preference = (await client.query<Preference>("INSERT INTO close_notification_preferences(organization_id,instance_id,recipient_id,version,enabled,due_within_days,events,reason,idempotency_key,command_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *", [org, c.instanceId, c.recipientId, c.expectedVersion + 1, c.enabled, c.dueWithinDays, JSON.stringify([...new Set(c.events)]), c.reason, c.idempotencyKey, hash, principal.userId])).rows[0]!;
        return { preference, idempotentReplay: false };
    });
}
async function notices(client: PoolClient, principal: SessionPrincipal, instanceId: string) {
    const org = principal.organizationId, asOfDate = new Date().toISOString().slice(0, 10), view = await loadCloseInstanceInTransaction(client, org, principal.userId, instanceId);
    const preference = (await client.query<Preference>("SELECT * FROM close_notification_preferences WHERE organization_id=$1 AND instance_id=$2 AND recipient_id=$3 ORDER BY version DESC LIMIT 1", [org, instanceId, principal.userId])).rows.at(0) ?? null;
    const receipts = new Set((await client.query<{
        notice_key: string;
    }>("SELECT notice_key FROM close_notification_receipts WHERE organization_id=$1 AND instance_id=$2 AND recipient_id=$3", [org, instanceId, principal.userId])).rows.map(row => row.notice_key));
    const pending = preference?.enabled ? view.tasks.filter(task => !completedCloseStatus(task.effectiveStatus)).flatMap(task => {
        const delta = (Date.parse(task.input.dueOn) - Date.parse(asOfDate)) / 86400000;
        return [...(delta < 0 ? ["OVERDUE"] : delta <= preference.due_within_days ? ["DUE"] : []), ...(task.blockers.length ? ["BLOCKER"] : [])].filter(event => preference.events.includes(event)).map(event => ({ noticeKey: createCommandFingerprint("close.notice", { instanceId, recipientId: principal.userId, key: task.key, event, dueOn: task.input.dueOn, sourceHash: task.sourceHash, version: task.version }), event, taskKey: task.key, label: task.definition.label, dueOn: task.input.dueOn, blockers: task.blockers, sourceHref: task.source.href }));
    }).filter(notice => !receipts.has(notice.noticeKey)) : [];
    return { channel: "IN_APP" as const, asOfDate, preference, pending };
}
export async function listCloseNotifications(principal: SessionPrincipal, instanceId: string) { z.uuid().parse(instanceId); return read(principal, client => notices(client, principal, instanceId)); }
export const acknowledgeCloseNoticeSchema = z.object({ instanceId: z.uuid(), noticeKey: z.string().regex(/^[a-f0-9]{64}$/), reason: closeReason, idempotencyKey: closeKey }).strict();
export async function acknowledgeCloseNotice(input: z.input<typeof acknowledgeCloseNoticeSchema> & Context) {
    const { principal, requestId, sourceSurface, ...raw } = input, c = acknowledgeCloseNoticeSchema.parse(raw), org = principal.organizationId, hash = createCommandFingerprint("close.notice.ack", { ...c, idempotencyKey: undefined });
    return withAuthorizedTaxWrite({ principal, requestId, sourceSurface, permission: PERMISSIONS.closePeriod, reason: c.reason, idempotencyKey: c.idempotencyKey, isolationLevel: "SERIALIZABLE" }, async (client) => {
        const old = (await client.query<{
            command_hash: string;
        }>("SELECT * FROM close_notification_receipts WHERE organization_id=$1 AND idempotency_key=$2", [org, c.idempotencyKey])).rows[0];
        if (old) {
            replay(old.command_hash, hash);
            return { acknowledged: true, idempotentReplay: true };
        }
        const current = await notices(client, principal, c.instanceId);
        if (!current.pending.some(notice => notice.noticeKey === c.noticeKey))
            fail("This notice is no longer pending for this recipient.");
        await client.query("INSERT INTO close_notification_receipts(organization_id,instance_id,recipient_id,notice_key,as_of_date,reason,idempotency_key,command_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [org, c.instanceId, principal.userId, c.noticeKey, current.asOfDate, c.reason, c.idempotencyKey, hash, principal.userId]);
        return { acknowledged: true, idempotentReplay: false };
    });
}
export async function loadCloseChecklistWorkspace(principal: SessionPrincipal) {
    return read(principal, async (client) => {
        const org = principal.organizationId;
        const templates = (await client.query<CloseTemplateRow>("SELECT * FROM close_template_revisions WHERE organization_id=$1 ORDER BY template_id,version DESC", [org])).rows;
        const instances = (await client.query<CloseInstanceRow>("SELECT * FROM close_instances WHERE organization_id=$1 ORDER BY created_at DESC,id", [org])).rows;
        const periods = (await client.query<{
            id: string;
            ledgerId: string;
            entityId: string;
            label: string;
            startsOn: string;
            endsOn: string;
            state: string;
        }>(`SELECT period.id,period.ledger_id AS "ledgerId",ledger.legal_entity_id AS "entityId",entity.display_name||' · '||ledger.code||' · '||period.label AS label,period.starts_on::text AS "startsOn",period.ends_on::text AS "endsOn",period.state FROM fiscal_periods period JOIN ledgers ledger ON ledger.organization_id=period.organization_id AND ledger.id=period.ledger_id JOIN legal_entities entity ON entity.organization_id=ledger.organization_id AND entity.id=ledger.legal_entity_id WHERE period.organization_id=$1 ORDER BY period.starts_on DESC,period.id`, [org])).rows;
        const people = (await client.query<{
            id: string;
            display_name_ciphertext: string | null;
        }>("SELECT person.id,person.display_name_ciphertext FROM app.close_assignable_members() person WHERE app.current_organization_id()=$1 ORDER BY person.id", [org])).rows;
        return { templates, instances, periods, people: people.map(person => {
                let label = `Member ${person.id}`;
                if (person.display_name_ciphertext) {
                    try {
                        label = decryptIdentityField(person.display_name_ciphertext, "display-name", person.id);
                    }
                    catch { /* Retain the unambiguous member ID when a display name is unavailable. */ }
                }
                return { id: person.id, label };
            }), actorId: principal.userId, canManage: await actorHasActivePermission(client, { organizationId: org, actorId: principal.userId, permission: PERMISSIONS.closePeriod }), defaultTemplate: defaultCloseTemplate };
    });
}
