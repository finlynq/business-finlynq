import { describe, expect, it } from "vitest";
import { evaluateJournalWorkflow, type JournalWorkflowFacts } from "@/modules/ledger/journal-workflow-eligibility";
import { PERMISSIONS } from "@/modules/identity/permissions";

const facts: JournalWorkflowFacts = {
  id: "journal", status: "SUBMITTED", content_hash: "a".repeat(64), canonical_hash: "a".repeat(64),
  approval_version: 3, created_by: "maker", owner_module: "ledger", journal_type_key: "ledger.manual",
  manual_mode: "REVIEW_REQUIRED", period_state: "OPEN", purpose: "ROUTINE", ledger_active: true,
  has_dependencies: false, valid_lines: true, has_approval: false, deleted: false,
};
const actor = { actorId: "checker", canWrite: true, permissions: new Set<string>(Object.values(PERMISSIONS)) };

describe("authoritative journal workflow decisions", () => {
  it.each(["REVIEW_REQUIRED", "AUTO_POST"] as const)("requires independent approval for existing submissions under %s", (manual_mode) => {
    const workflow = evaluateJournalWorkflow({ ...facts, manual_mode }, actor);
    expect(workflow).toMatchObject({ contentHash: facts.content_hash, approvalVersion: 3, independentApprovalRequired: true });
    expect(workflow.actions.approve.allowed).toBe(true);
    expect(workflow.actions.reject.allowed).toBe(true);
    expect(workflow.actions.post.reasonCode).toBe("APPROVAL_REQUIRED");
    expect(evaluateJournalWorkflow({ ...facts, manual_mode, status: "APPROVED", has_approval: true }, actor).actions.post.allowed).toBe(true);
  });
  it.each(["REVIEW_REQUIRED", "AUTO_POST"] as const)("preserves the existing authorized manual draft posting path under %s", (manual_mode) => {
    const workflow = evaluateJournalWorkflow({ ...facts, manual_mode, status: "DRAFT", content_hash: null, approval_version: null }, actor);
    expect(workflow.actions.submit.allowed).toBe(true);
    expect(workflow.actions.post.allowed).toBe(true);
  });
  it("lets creators withdraw their submission while denying self approval and rejection", () => {
    const result = evaluateJournalWorkflow(facts, { ...actor, actorId: "maker" });
    expect(result.actions.approve.reasonCode).toBe("CREATOR_CANNOT_APPROVE");
    expect(result.actions.reject.reasonCode).toBe("CREATOR_CANNOT_APPROVE");
    expect(result.actions.withdraw.allowed).toBe(true);
    expect(evaluateJournalWorkflow(facts, actor).actions.withdraw.reasonCode).toBe("CREATOR_REQUIRED");
  });
  it("permits an authorized MCP creator to approve an existing submission without waiving other checks", () => {
    const creator = { ...actor, actorId: "maker", selfApprovalAllowed: true };
    const result = evaluateJournalWorkflow(facts, creator);
    expect(result.actions.approve.allowed).toBe(true);
    expect(result.actions.reject.reasonCode).toBe("CREATOR_CANNOT_APPROVE");
    expect(result.actions.post.reasonCode).toBe("APPROVAL_REQUIRED");
    expect(result.independentApprovalRequired).toBe(false);
    expect(evaluateJournalWorkflow({ ...facts, canonical_hash: "b".repeat(64) }, creator).actions.approve.reasonCode).toBe("STALE_VERSION");
    expect(evaluateJournalWorkflow(facts, { ...creator, permissions: new Set() }).actions.approve.reasonCode).toBe("MISSING_PERMISSION");
  });
  it.each(["HARD_CLOSED", "SEALED"])("disables every submitted action in %s periods", (period_state) => {
    const result = evaluateJournalWorkflow({ ...facts, period_state }, actor);
    for (const action of ["approve", "post", "reject", "withdraw"] as const) expect(result.actions[action].reasonCode).toBe("PERIOD_CLOSED");
  });
  it("preserves dependency restrictions and current frozen version checks", () => {
    expect(evaluateJournalWorkflow({ ...facts, has_dependencies: true }, actor).actions.reject.reasonCode).toBe("HAS_DEPENDENCIES");
    expect(evaluateJournalWorkflow({ ...facts, canonical_hash: "b".repeat(64) }, actor).actions.approve.reasonCode).toBe("STALE_VERSION");
    expect(evaluateJournalWorkflow({ ...facts, approval_version: null }, actor).actions.approve.reasonCode).toBe("STALE_VERSION");
  });
  it("fails closed for missing permissions, disabled writes, deleted journals and invalid lines", () => {
    expect(evaluateJournalWorkflow(facts, { ...actor, permissions: new Set() }).actions.approve.reasonCode).toBe("MISSING_PERMISSION");
    expect(evaluateJournalWorkflow(facts, { ...actor, canWrite: false }).actions.approve.reasonCode).toBe("WRITES_DISABLED");
    expect(evaluateJournalWorkflow({ ...facts, deleted: true }, actor).actions.approve.reasonCode).toBe("INVALID_STATE");
    expect(evaluateJournalWorkflow({ ...facts, valid_lines: false }, actor).actions.approve.reasonCode).toBe("INVALID_CONTENT");
  });
});
