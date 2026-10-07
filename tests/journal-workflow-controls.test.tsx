import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { JournalWorkflowAction, JournalWorkflowEligibility } from "@/modules/ledger/journal-workflow-eligibility";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { JournalWorkflowControls } from "@/app/_components/journal-workflow-controls.client";

const allActions: JournalWorkflowAction[] = ["submit", "approve", "post", "withdraw", "reject"];
function workflow(status: string, allowed: JournalWorkflowAction[], creator = false): JournalWorkflowEligibility {
  return {
    status, contentHash: "a".repeat(64), approvalVersion: status === "DRAFT" ? null : 3,
    actorIsCreator: creator, independentApprovalRequired: true, manualPostingMode: "REVIEW_REQUIRED",
    actions: Object.fromEntries(allActions.map((action) => [action, allowed.includes(action)
      ? { allowed: true, reasonCode: null, reason: null }
      : { allowed: false, reasonCode: "APPROVAL_REQUIRED", reason: "A different authorized reviewer must approve the frozen journal." }])) as JournalWorkflowEligibility["actions"],
  };
}
function render(value: JournalWorkflowEligibility | null) {
  return renderToStaticMarkup(<JournalWorkflowControls journalId="30000000-0000-4000-8000-000000000001" journalNumber="Submitted" workflow={value} />);
}

describe("journal workflow controls", () => {
  it("gives a submitted generated journal's creator an audited withdrawal path and an independent approver explanation", () => {
    const markup = render(workflow("SUBMITTED", ["withdraw"], true));
    expect(markup).toContain(">Withdraw submission</summary>");
    expect(markup).toContain("You created this journal. A different user with journal approval permission");
    expect(markup).toContain('data-reason-code="APPROVAL_REQUIRED"');
    expect(markup).not.toContain(">Approve journal</summary>");
    expect(markup).not.toContain(">Post journal</summary>");
    expect(markup).not.toContain("Post draft");
    expect(markup).toContain("Audit reason");
    expect(markup).toContain("I reviewed this journal and confirm this action and its audit reason.");
    expect(markup).toContain("Existing approval evidence stays in the audit trail");
  });

  it("lets an eligible independent reviewer approve or return the same frozen version", () => {
    const markup = render(workflow("SUBMITTED", ["approve", "reject"]));
    expect(markup).toContain(">Approve journal</summary>");
    expect(markup).toContain(">Return for correction</summary>");
    expect(markup).not.toContain(">Withdraw submission</summary>");
    expect(markup).not.toContain(">Post journal</summary>");
    expect(markup).toContain("Posting remains a separate action");
    expect(markup).toContain("requires a new review");
  });

  it("refreshes rendered actions from submission to approval to posting", () => {
    expect(render(workflow("SUBMITTED", ["approve"]))).toContain(">Approve journal</summary>");
    const approved = render(workflow("APPROVED", ["post"]));
    expect(approved).toContain(">Post journal</summary>");
    expect(approved).not.toContain("Approve journal");
    expect(approved).not.toContain("Withdraw submission");
    expect(approved).toContain("permanent journal number");
    expect(render(workflow("POSTED", []))).toBe("");
  });

  it("uses authoritative eligibility for direct draft posting and fails closed without workflow facts", () => {
    const draft = { ...workflow("DRAFT", ["post"]), independentApprovalRequired: false };
    const markup = render(draft);
    expect(markup).toContain(">Post journal</summary>");
    expect(markup).not.toContain(">Submit for approval</summary>");
    const missing = render(null);
    expect(missing).toContain("Journal actions are unavailable");
    expect(missing).toContain("Refresh journal");
    expect(missing).not.toContain("Audit reason");
  });
});
