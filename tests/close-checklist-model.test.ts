import { describe, it, expect } from "vitest";
import { closeTemplateSchema, defaultCloseTemplate, closeDueDate } from "@/modules/close/checklist-model";
describe("close prerequisite integrity", () => {
    it("keeps every required source check visible", () => { expect(closeTemplateSchema.safeParse(defaultCloseTemplate).success).toBe(true); expect(closeTemplateSchema.safeParse({ ...defaultCloseTemplate, tasks: defaultCloseTemplate.tasks.filter(t => t.key !== "bank") }).success).toBe(false); });
    it("rejects missing dependencies, cycles and the implicit final-signoff cycle", () => {
        for (const prerequisites of [["missing"], ["bank"], ["signoff"]])
            expect(closeTemplateSchema.safeParse({ ...defaultCloseTemplate, tasks: defaultCloseTemplate.tasks.map(t => t.key === "bank" ? { ...t, prerequisites } : t) }).success).toBe(false);
    });
    it("calculates due dates over month and year boundaries", () => { expect(closeDueDate("2025-12-31", 5)).toBe("2026-01-05"); expect(closeDueDate("2024-02-29", -1)).toBe("2024-02-28"); });
});
