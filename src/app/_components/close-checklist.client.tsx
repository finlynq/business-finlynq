"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { loadCloseChecklistWorkspace, inspectCloseInstance, listCloseNotifications, CloseTaskView } from "@/modules/close/checklist-service";
import type { CloseTaskInput, CloseTaskDefinition } from "@/modules/close/checklist-model";
type Workspace = Awaited<ReturnType<typeof loadCloseChecklistWorkspace>>;
type View = Awaited<ReturnType<typeof inspectCloseInstance>>;
type Notices = Awaited<ReturnType<typeof listCloseNotifications>>;
type Command = (path: string, body: Record<string, unknown>) => Promise<boolean>;
const label = (value: string) => value.toLowerCase().replaceAll("_", " ");
export function CloseChecklist({ workspace }: {
    workspace: Workspace;
}) {
    const router = useRouter();
    const [periodId, setPeriodId] = useState(workspace.periods[0]?.id ?? ""), [templateId, setTemplateId] = useState(workspace.templates[0]?.id ?? ""), [view, setView] = useState<View | null>(null), [notices, setNotices] = useState<Notices | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [reason, setReason] = useState(""), [definition, setDefinition] = useState(workspace.defaultTemplate), [editingTemplate, setEditingTemplate] = useState<{
        id: string;
        version: number;
    } | null>(null), [entity, setEntity] = useState(""), [ledger, setLedger] = useState("");
    const periods = workspace.periods.filter(p => (!entity || p.entityId === entity) && (!ledger || p.ledgerId === ledger));
    async function load(instanceId: string) {
        try {
            const response = await fetch(`/api/close/checklist/preview?instanceId=${encodeURIComponent(instanceId)}`, { cache: "no-store" });
            const data = await response.json();
            if (!response.ok)
                throw new Error(data.error ?? "Close sources could not be checked.");
            setView(data.view);
            setNotices(data.notices);
        }
        catch (e) {
            setView(null);
            setNotices(null);
            setError(e instanceof Error ? e.message : "Close sources could not be checked.");
        }
    }
    const command: Command = async (path, body) => {
        setBusy(true);
        setError("");
        try {
            const response = await fetch(`/api/close/checklist/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, idempotencyKey: crypto.randomUUID() }) });
            const data = await response.json();
            if (!response.ok)
                throw new Error(data.error ?? "The close change failed.");
            if (data.template) {
                setTemplateId(data.template.id);
                setEditingTemplate({ id: data.template.template_id, version: data.template.version });
                setDefinition(data.template.definition);
            }
            if (data.instance)
                await load(data.instance.id);
            else if (view)
                await load(view.instance.id);
            router.refresh();
            return true;
        }
        catch (e) {
            setError(e instanceof Error ? e.message : "The close change failed.");
            return false;
        }
        finally {
            setBusy(false);
        }
    };
    const selected = workspace.instances.find(instance => instance.period_id === periodId);
    function updateDefinition(index: number, patch: Partial<CloseTaskDefinition>) { setDefinition({ ...definition, tasks: definition.tasks.map((task, i) => i === index ? { ...task, ...patch } : task) }); }
    return <section className="panel form-panel" aria-labelledby="persistent-close-title"><div className="panel-heading"><div><p className="eyebrow">Sources, review and permanent evidence</p><h2 id="persistent-close-title">Persistent close checklist</h2></div></div>
 <p>Resume a saved checklist or create a period instance from a reusable template. Source checks are read-only. Review and completion never post journals or change a period’s state.</p>
 {error && <p role="alert">{error}</p>}
 <div className="form-grid"><label>Entity filter<select value={entity} onChange={e => { setEntity(e.target.value); setLedger(""); setPeriodId(""); }}><option value="">All entities</option>{[...new Map(workspace.periods.map(p => [p.entityId, p])).values()].map(p => <option key={p.entityId} value={p.entityId}>{p.label.split(" · ")[0]}</option>)}</select></label><label>Ledger filter<select value={ledger} onChange={e => { setLedger(e.target.value); setPeriodId(""); }}><option value="">All ledgers</option>{[...new Map(workspace.periods.filter(p => !entity || p.entityId === entity).map(p => [p.ledgerId, p])).values()].map(p => <option key={p.ledgerId} value={p.ledgerId}>{p.label.split(" · ").slice(0, 2).join(" · ")}</option>)}</select></label>
 <label>Close period<select value={periodId} onChange={e => { setPeriodId(e.target.value); setView(null); setNotices(null); }}><option value="">Choose period</option>{periods.map(p => <option key={p.id} value={p.id}>{p.label} · {label(p.state)}</option>)}</select></label>
 <label>Template revision<select value={templateId} onChange={e => setTemplateId(e.target.value)}><option value="">Choose template</option>{workspace.templates.map(t => <option key={t.id} value={t.id}>{t.definition.name} · v{t.version}</option>)}</select></label></div>
 <label>Reason for starting or revising the template<input value={reason} onChange={e => setReason(e.target.value)} minLength={8}/></label>
 {selected ? <button type="button" disabled={busy} onClick={() => { setError(""); void load(selected.id); }}>Resume this close</button> : <button type="button" disabled={busy || !workspace.canManage || !periodId || !templateId || reason.trim().length < 8} onClick={() => void command("instances", { periodId, templateRevisionId: templateId, reason })}>Start period checklist</button>}
 <details><summary>Reusable template and prerequisites</summary><p>Every template keeps the required source checks. Final sign-off always depends on every task. Existing instances retain their saved template.</p>
 <button type="button" onClick={() => {
            const selectedTemplate = workspace.templates.find(t => t.id === templateId);
            if (selectedTemplate) {
                setDefinition(selectedTemplate.definition);
                setEditingTemplate({ id: selectedTemplate.template_id, version: selectedTemplate.version });
            }
        }}>Edit selected revision</button><button type="button" onClick={() => { setDefinition(workspace.defaultTemplate); setEditingTemplate(null); }}>New template</button>
 <label>Template name<input value={definition.name} onChange={e => setDefinition({ ...definition, name: e.target.value })}/></label>
 {definition.tasks.map((task, index) => <fieldset key={task.key}><legend>{task.key} · {label(task.source)}</legend><div className="form-grid"><label>Task label<input value={task.label} onChange={e => updateDefinition(index, { label: e.target.value })}/></label><label>Prerequisite keys, comma separated<input value={task.prerequisites.join(",")} disabled={task.source === "SIGNOFF"} onChange={e => updateDefinition(index, { prerequisites: e.target.value.split(",").map(v => v.trim()).filter(Boolean) })}/></label><Person label="Default owner" value={task.ownerId} workspace={workspace} onChange={ownerId => updateDefinition(index, { ownerId })}/><Person label="Default reviewer" value={task.reviewerId} workspace={workspace} onChange={reviewerId => updateDefinition(index, { reviewerId })}/><label>Days after period end<input type="number" min={-90} max={365} value={task.dueOffsetDays} onChange={e => updateDefinition(index, { dueOffsetDays: Number(e.target.value) })}/></label></div></fieldset>)}
 <button type="button" disabled={definition.tasks.length >= 40} onClick={() => setDefinition({ ...definition, tasks: [...definition.tasks, { key: `manual-${definition.tasks.length}`, label: "Additional close evidence", source: "MANUAL", prerequisites: [], ownerId: null, reviewerId: null, dueOffsetDays: 5 }] })}>Add manual evidence task</button>
 <button type="button" disabled={busy || !workspace.canManage || reason.trim().length < 8} onClick={() => void command("templates", { templateId: editingTemplate?.id ?? crypto.randomUUID(), expectedVersion: editingTemplate?.version ?? 0, definition, reason })}>Save template revision</button></details>
 {view && <div><h3>{view.scope.entityName} · {view.scope.ledgerCode} · {view.scope.label}</h3><p>{view.tasks.filter(t => t.effectiveStatus === "COMPLETE" || t.effectiveStatus === "NOT_APPLICABLE").length} of {view.tasks.length} tasks resolved · {view.ready ? "Ready for separate period-control review" : "Close work remains"} · Period: {label(view.scope.periodState)}</p><button type="button" disabled={busy} onClick={() => void load(view.instance.id)}>Refresh source facts</button>
 {view.tasks.map(task => <Task key={`${view.instance.id}:${task.key}:${task.version}`} task={task} view={view} workspace={workspace} busy={busy} command={command}/>)}
 {notices && <NoticeSettings key={`${view.instance.id}:${notices.preference?.version ?? 0}`} notices={notices} instanceId={view.instance.id} workspace={workspace} command={command} busy={busy}/>}
 <details><summary>Permanent task history ({view.history.length} revisions)</summary><ul>{view.history.map(row => <li key={row.id}>{row.task_key} v{row.version} · {label(row.input.status)} · {row.created_at} · {row.reason}{row.source_hash && <small> Source fingerprint {row.source_hash}</small>}</li>)}</ul></details></div>}
 </section>;
}
function Person({ label: caption, value, workspace, onChange }: {
    label: string;
    value: string | null;
    workspace: Workspace;
    onChange: (id: string | null) => void;
}) { return <label>{caption}<select value={value ?? ""} onChange={e => onChange(e.target.value || null)}><option value="">Unassigned</option>{workspace.people.map(p => <option key={p.id} value={p.id}>{p.id === workspace.actorId ? "Me" : p.label}</option>)}</select></label>; }
function Task({ task, view, workspace, busy, command }: {
    task: CloseTaskView;
    view: View;
    workspace: Workspace;
    busy: boolean;
    command: Command;
}) {
    const [input, setInput] = useState<CloseTaskInput>(task.input), [evidence, setEvidence] = useState(task.input.evidence.join("\n")), [reason, setReason] = useState(""), [target, setTarget] = useState("");
    const dirty = JSON.stringify({ ...input, evidence: evidence.split("\n").map(v => v.trim()).filter(Boolean) }) !== JSON.stringify(task.input);
    const send = (action: string) => command("tasks", { instanceId: view.instance.id, taskKey: task.key, expectedVersion: task.version, action, reason, ...(action === "UPDATE" ? { input: { ...input, status: ["REVIEWED", "COMPLETE", "NOT_APPLICABLE"].includes(input.status) ? "IN_PROGRESS" : input.status, evidence: evidence.split("\n").map(v => v.trim()).filter(Boolean) } } : { sourceHash: task.sourceHash }) });
    const disabled = busy || !workspace.canManage || reason.trim().length < 8;
    return <details className="compact-disclosure"><summary><strong>{task.definition.label}</strong> · {label(task.effectiveStatus)} · Source: {label(task.source.stage)} · Due {task.input.dueOn}{task.stale ? " · Review stale" : ""}</summary>
 <p>{task.source.detail} <Link href={task.source.href}>Open source workflow</Link></p>{task.carriedFromRevisionId && <p>Carried from source period {task.sourcePeriodId}; origin revision {task.carriedFromRevisionId}. The originating task remains unresolved until separately reviewed.</p>}
 <ul>{task.blockers.map((blocker, i) => <li key={i}>{blocker}</li>)}</ul><p>Prerequisites: {task.dependencies.length ? task.dependencies.map(dep => `${dep.key} (${label(dep.status)}, v${dep.version})`).join(", ") : "None"}.</p>
 <div className="form-grid"><Person label="Owner" value={input.ownerId} workspace={workspace} onChange={ownerId => setInput({ ...input, ownerId })}/><Person label="Reviewer" value={input.reviewerId} workspace={workspace} onChange={reviewerId => setInput({ ...input, reviewerId })}/><label>Due date<input type="date" value={input.dueOn} onChange={e => setInput({ ...input, dueOn: e.target.value })}/></label><label>Working state<select value={["REVIEWED", "COMPLETE", "NOT_APPLICABLE"].includes(input.status) ? "IN_PROGRESS" : input.status} onChange={e => setInput({ ...input, status: e.target.value as CloseTaskInput["status"] })}>{["NOT_STARTED", "READY", "IN_PROGRESS", "BLOCKED"].map(status => <option key={status} value={status}>{label(status)}</option>)}</select></label></div>
 <label>Blocking reason<input value={input.blockingReason ?? ""} onChange={e => setInput({ ...input, blockingReason: e.target.value || null })}/></label><label>Supporting evidence, one reference or explanation per line<textarea value={evidence} onChange={e => setEvidence(e.target.value)}/></label><label>Reason for this decision<input value={reason} onChange={e => setReason(e.target.value)}/></label>
 {dirty && <p role="status">Changed inputs must be saved and reviewed again.</p>}
 <div className="form-actions"><button type="button" disabled={disabled} onClick={() => void send("UPDATE")}>Save task changes</button><button type="button" disabled={disabled || dirty || task.input.reviewerId !== workspace.actorId} onClick={() => void send("REVIEW")}>Review current evidence</button><button type="button" disabled={disabled || dirty || task.effectiveStatus !== "REVIEWED"} onClick={() => void send("COMPLETE")}>Complete reviewed task</button>{task.definition.source !== "SIGNOFF" && <button type="button" disabled={disabled || dirty || task.input.reviewerId !== workspace.actorId} onClick={() => void send("NOT_APPLICABLE")}>Record not-applicable exception</button>}</div>
 {!['COMPLETE', 'NOT_APPLICABLE'].includes(task.effectiveStatus) && task.definition.source !== "SIGNOFF" && <div><label>Carry unresolved work to<select value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose a later saved checklist</option>{workspace.instances.filter(instance => instance.ledger_id === view.instance.ledger_id && workspace.periods.some(p => p.id === instance.period_id && p.startsOn > view.scope.endsOn)).map(instance => <option key={instance.id} value={instance.id}>{workspace.periods.find(p => p.id === instance.period_id)?.label}</option>)}</select></label><button type="button" disabled={disabled || !target || dirty} onClick={() => void command("carry", { fromInstanceId: view.instance.id, taskKey: task.key, expectedVersion: task.version, toInstanceId: target, dueOn: input.dueOn, reason })}>Carry forward with original due date</button></div>}
 <details><summary>Current source snapshot and retained review</summary><p>Task v{task.version} · Source fingerprint {task.sourceHash}</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({ source: task.source.evidence, review: task.review }, null, 2)}</pre></details></details>;
}
function NoticeSettings({ notices, instanceId, workspace, command, busy }: {
    notices: Notices;
    instanceId: string;
    workspace: Workspace;
    command: Command;
    busy: boolean;
}) { const [enabled, setEnabled] = useState(notices.preference?.enabled ?? false), [days, setDays] = useState(notices.preference?.due_within_days ?? 3), [events, setEvents] = useState(notices.preference?.events ?? ["DUE", "OVERDUE", "BLOCKER"]), [reason, setReason] = useState(""); return <details><summary>My in-app close notices ({notices.pending.length})</summary><p>Opt in to notices here. No email, chat or external destination is enabled.</p><label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>Enable my in-app notices</label><label>Days before due date<input type="number" min={0} max={30} value={days} onChange={e => setDays(Number(e.target.value))}/></label>{["DUE", "OVERDUE", "BLOCKER"].map(event => <label key={event}><input type="checkbox" checked={events.includes(event)} onChange={e => setEvents(e.target.checked ? [...events, event] : events.filter(v => v !== event))}/>{label(event)}</label>)}<label>Notice preference reason<input value={reason} onChange={e => setReason(e.target.value)}/></label><button type="button" disabled={busy || !workspace.canManage || reason.trim().length < 8} onClick={() => void command("notifications", { instanceId, recipientId: workspace.actorId, expectedVersion: notices.preference?.version ?? 0, enabled, dueWithinDays: days, events, reason })}>Save my notice preferences</button><ul>{notices.pending.map(notice => <li key={notice.noticeKey}>{notice.label} · {label(notice.event)} · {notice.dueOn}<button type="button" disabled={busy || !workspace.canManage} onClick={() => void command("acknowledge", { instanceId, noticeKey: notice.noticeKey, reason: "Acknowledged this close notice" })}>Acknowledge</button></li>)}</ul></details>; }
