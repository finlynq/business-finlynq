import { z } from "zod";
export const closeSourceSchema = z.enum(["BANK", "RECEIVABLES", "PAYABLES", "UNPOSTED", "MAPPINGS", "ACCRUALS", "PREPAIDS", "DEPRECIATION", "ASSET_RECONCILIATION", "TAX_PROVISION", "STATEMENTS", "SIGNOFF", "MANUAL"]);
export type CloseSource = z.infer<typeof closeSourceSchema>;
export const closeStatusSchema = z.enum(["NOT_STARTED", "READY", "IN_PROGRESS", "BLOCKED", "REVIEWED", "COMPLETE", "NOT_APPLICABLE"]);
export const closeTaskDefinitionSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), label: z.string().trim().min(1).max(160), source: closeSourceSchema, prerequisites: z.array(z.string().min(1).max(80)).max(40), ownerId: z.uuid().nullable(), reviewerId: z.uuid().nullable(), dueOffsetDays: z.number().int().min(-90).max(365) }).strict();
export const closeTemplateSchema = z.object({ name: z.string().trim().min(1).max(120), tasks: z.array(closeTaskDefinitionSchema).min(12).max(40) }).strict().superRefine((value, context) => {
    const keys = new Set(value.tasks.map(task => task.key));
    if (keys.size !== value.tasks.length)
        context.addIssue({ code: "custom", message: "Task keys must be unique" });
    for (const source of closeSourceSchema.options.filter(s => s !== "MANUAL"))
        if (value.tasks.filter(task => task.source === source).length !== 1)
            context.addIssue({ code: "custom", message: `Include exactly one ${source} task so required close checks remain visible` });
    const signoff = value.tasks.find(task => task.source === "SIGNOFF");
    for (const task of value.tasks)
        if (signoff && task.source !== "SIGNOFF" && task.prerequisites.includes(signoff.key))
            context.addIssue({ code: "custom", message: "Final sign-off cannot be a prerequisite of another task" });
    const byKey = new Map(value.tasks.map(task => [task.key, task]));
    function visit(key: string, path: Set<string>): boolean {
        if (path.has(key))
            return false;
        const task = byKey.get(key);
        if (!task)
            return false;
        const next = new Set(path).add(key);
        return task.prerequisites.every(dep => visit(dep, next));
    }
    for (const task of value.tasks)
        if (!visit(task.key, new Set()))
            context.addIssue({ code: "custom", message: `Task ${task.key} has missing or cyclic prerequisites` });
});
export type CloseTaskDefinition = z.infer<typeof closeTaskDefinitionSchema>;
export const closeTaskInputSchema = z.object({ ownerId: z.uuid().nullable(), reviewerId: z.uuid().nullable(), dueOn: z.iso.date(), status: closeStatusSchema, blockingReason: z.string().trim().max(1000).nullable(), evidence: z.array(z.string().trim().min(8).max(1000)).max(20) }).strict();
export type CloseTaskInput = z.infer<typeof closeTaskInputSchema>;
export const closeReason = z.string().trim().min(8).max(500), closeKey = z.string().trim().min(1).max(180);
export const defaultCloseTemplate: z.infer<typeof closeTemplateSchema> = { name: "Monthly financial close", tasks: [
        { key: "bank", label: "Bank/card reconciliation and statement coverage", source: "BANK", prerequisites: [] },
        { key: "receivables", label: "Receivables completeness and cut-off", source: "RECEIVABLES", prerequisites: [] },
        { key: "payables", label: "Payables completeness and cut-off", source: "PAYABLES", prerequisites: [] },
        { key: "unposted", label: "Resolve unposted documents and journals", source: "UNPOSTED", prerequisites: ["receivables", "payables"] },
        { key: "mappings", label: "Account and register mapping review", source: "MAPPINGS", prerequisites: [] },
        { key: "accruals", label: "Accrual and cut-off review", source: "ACCRUALS", prerequisites: ["receivables", "payables"] },
        { key: "prepaids", label: "Post due prepaid releases", source: "PREPAIDS", prerequisites: ["mappings"] },
        { key: "depreciation", label: "Post due depreciation and amortization", source: "DEPRECIATION", prerequisites: ["mappings"] },
        { key: "asset-reconciliation", label: "Reconcile asset register to the GL", source: "ASSET_RECONCILIATION", prerequisites: ["prepaids", "depreciation"] },
        { key: "tax-provision", label: "Current-tax provision calculation, review and posting", source: "TAX_PROVISION", prerequisites: ["accruals", "prepaids", "depreciation", "unposted"] },
        { key: "statements", label: "Review financial statements", source: "STATEMENTS", prerequisites: ["bank", "asset-reconciliation", "tax-provision"] },
        { key: "signoff", label: "Final close sign-off", source: "SIGNOFF", prerequisites: ["statements"] },
    ].map(task => ({ ...task, source: task.source as CloseSource, ownerId: null, reviewerId: null, dueOffsetDays: 5 })) };
export function closeDueDate(periodEnd: string, offset: number) { return new Date(Date.parse(`${periodEnd}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10); }
export function completedCloseStatus(status: z.infer<typeof closeStatusSchema>) { return status === "COMPLETE" || status === "NOT_APPLICABLE"; }
