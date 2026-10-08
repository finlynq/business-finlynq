import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/modules/identity/permissions";
import type { JournalWorkflowEligibility } from "@/modules/ledger/journal-workflow-eligibility";
import type { McpToolRuntime } from "@/modules/mcp/tool-types";
import { mcpSessionPrincipal } from "@/modules/mcp/oauth-store";
import { MCP_OAUTH_SCOPES } from "@/modules/mcp/protocol";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(), workspace: vi.fn(), submit: vi.fn(), approve: vi.fn(), post: vi.fn(), withdraw: vi.fn(), reject: vi.fn(),
}));
vi.mock("@/modules/ledger/tenant-workspace", async (original) => ({
  ...await original<typeof import("@/modules/ledger/tenant-workspace")>(),
  loadTenantJournalDetail: mocks.detail,
  loadTenantJournalWorkspace: mocks.workspace,
}));
vi.mock("@/modules/ledger/journal-workflow-service", async (original) => ({
  ...await original<typeof import("@/modules/ledger/journal-workflow-service")>(),
  submitJournalForApproval: mocks.submit, approveSubmittedJournal: mocks.approve,
  withdrawSubmittedJournal: mocks.withdraw, rejectSubmittedJournal: mocks.reject,
}));
vi.mock("@/modules/ledger/posting-service", async (original) => ({
  ...await original<typeof import("@/modules/ledger/posting-service")>(), postJournal: mocks.post,
}));

import { DAILY_MCP_TOOLS } from "@/modules/mcp/daily-tools";
import { mcpJournalWorkflow } from "@/modules/mcp/journal-workflow";

const id = "20000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
const allowed = { allowed: true, reasonCode: null, reason: null } as const;
const workflow: JournalWorkflowEligibility = {
  status: "SUBMITTED", contentHash: hash, approvalVersion: 3,
  manualPostingMode: "AUTO_POST", actorIsCreator: false, independentApprovalRequired: true,
  actions: {
    submit: { allowed: false, reasonCode: "INVALID_STATE", reason: "Already submitted." },
    approve: allowed, post: { allowed: false, reasonCode: "APPROVAL_REQUIRED", reason: "Ask an independent approver." },
    withdraw: { allowed: false, reasonCode: "CREATOR_REQUIRED", reason: "Only the creator can withdraw." }, reject: allowed,
  },
};
function runtime(): McpToolRuntime {
  const principal: McpToolRuntime["principal"] = {
    connectionId: id, userId: id, organizationId: id, membershipId: id,
    organizationName: "Synthetic test", roleLabel: "Accountant", clientId: "test", clientName: "Test",
    scopes: Object.values(MCP_OAUTH_SCOPES), resource: "https://business.finlynq.test/mcp",
    dailyMode: "ALLOW_WRITES", setupMode: "OFF", toolOverrides: {},
    tokenExpiresAt: new Date("2099-01-01"), organizationWritesEnabled: true,
  };
  return {
    requestId: "mcp-journal-test", principal,
    sessionPrincipal: mcpSessionPrincipal(principal),
    snapshot: {
      principal,
      permissions: new Set(Object.values(PERMISSIONS)), dailyMode: "ALLOW_WRITES", setupMode: "OFF",
      toolOverrides: {}, directWriteSessionId: null, directWriteStepUpExpiresAt: null, connectionVersion: 1,
    },
  };
}
function tool(action: string) {
  const definition = DAILY_MCP_TOOLS.find((entry) => entry.policy.name === `finlynq_daily_${action}_journal`);
  if (!definition) throw new Error(`Missing ${action} journal tool`);
  return definition;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.detail.mockResolvedValue({ id, status: "SUBMITTED", expectedContentHash: hash, expectedApprovalVersion: 3, workflow });
});

describe("MCP journal workflow contract", () => {
  it("returns the exact frozen approval inputs and valid next steps from journal reads", async () => {
    const result = await tool("get").invoke({ journalId: id }, runtime());
    expect(result).toMatchObject({ expectedContentHash: hash, expectedApprovalVersion: 3, workflow: {
      manualPostingMode: "AUTO_POST", contentHash: hash, approvalVersion: 3,
      actions: { approve: { allowed: true, toolName: "finlynq_daily_approve_journal" }, post: { allowed: false, reasonCode: "APPROVAL_REQUIRED" } },
    } });
  });

  it("narrows actions for connection restrictions without overriding domain denials", () => {
    const rt = runtime();
    const snapshot = { ...rt.snapshot, dailyMode: "READ_ONLY" as const };
    const limited = mcpJournalWorkflow(workflow, snapshot);
    expect(limited?.actions.approve).toMatchObject({ allowed: false, reasonCode: "CONNECTION_RESTRICTED" });
    expect(limited?.actions.post).toMatchObject({ allowed: false, reasonCode: "APPROVAL_REQUIRED" });
    const confirmation = mcpJournalWorkflow(workflow, { ...rt.snapshot, dailyMode: "CONFIRM_WRITES" });
    expect(confirmation?.actions.approve).toMatchObject({ allowed: true, confirmationRequired: true });
    const override = mcpJournalWorkflow(workflow, { ...rt.snapshot, toolOverrides: { finlynq_daily_approve_journal: "OFF" } });
    expect(override?.actions.approve.allowed).toBe(false);
  });
  it("shows organization-wide self-approval only when owner policy is enabled", () => {
    const creatorWorkflow = { ...workflow, actorIsCreator: true,
      actions: { ...workflow.actions, approve: { allowed: false, reasonCode: "CREATOR_CANNOT_APPROVE" as const, reason: "Independent review required" } } };
    const disabled = mcpJournalWorkflow(creatorWorkflow, runtime().snapshot);
    expect(disabled?.actions.approve.reasonCode).toBe("CREATOR_CANNOT_APPROVE");
    const enabled = mcpJournalWorkflow(creatorWorkflow, { ...runtime().snapshot, agentSelfApprovalEnabled: true });
    expect(enabled).toMatchObject({ agentSelfApprovalEnabled: true, independentApprovalRequired: false,
      actions: { approve: { allowed: true }, post: { allowed: false, reasonCode: "APPROVAL_REQUIRED" } } });
    const restricted = mcpJournalWorkflow(creatorWorkflow, { ...runtime().snapshot,
      agentSelfApprovalEnabled: true, dailyMode: "READ_ONLY" });
    expect(restricted?.actions.approve.reasonCode).toBe("CONNECTION_RESTRICTED");
  });

  it("carries frozen versions through approval, posting, and refreshed action responses", async () => {
    const args = { journalId: id, expectedContentHash: hash, expectedApprovalVersion: 3, reason: "Reviewed synthetic journal" };
    mocks.approve.mockResolvedValue({ journalId: id, status: "APPROVED", approvalVersion: 3, contentHash: hash });
    mocks.detail.mockResolvedValue({ id, status: "APPROVED", number: "Draft", workflow: { ...workflow, status: "APPROVED", actions: { ...workflow.actions, post: allowed } } });
    const approved = await tool("approve").invoke(args, runtime());
    expect(mocks.approve).toHaveBeenCalledWith(expect.objectContaining(args));
    expect(approved).toMatchObject({ status: "APPROVED", journal: { status: "APPROVED" }, workflow: { actions: { post: { allowed: true } } }, workflowRefreshRequired: false });
    mocks.post.mockResolvedValue({ journalId: id, status: "POSTED", journalNumber: 42, idempotentReplay: false });
    mocks.detail.mockResolvedValue({ id, status: "POSTED", number: "42", workflow: { ...workflow, status: "POSTED" } });
    expect(await tool("post").invoke(args, runtime())).toMatchObject({ status: "POSTED", journalNumber: 42, journal: { number: "42", status: "POSTED" } });
    expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ journalId: id, expectedContentHash: hash, expectedApprovalVersion: 3 }));
  });

  it.each(["withdraw", "reject"] as const)("binds %s to frozen version, original id, reason, and idempotency key", async (action) => {
    const args = { journalId: id, expectedContentHash: hash, expectedApprovalVersion: 3, reason: "Return for correction", idempotencyKey: "20000000-0000-4000-8000-000000000002" };
    mocks[action].mockResolvedValue({ journalId: id, status: "DRAFT", idempotentReplay: false });
    mocks.detail.mockResolvedValue({ id, status: "DRAFT", workflow: { ...workflow, status: "DRAFT" } });
    const result = await tool(action).invoke(args, runtime());
    expect(mocks[action]).toHaveBeenCalledWith(expect.objectContaining({ ...args, context: expect.objectContaining({ reason: args.reason, sourceSurface: "MCP", authMethod: "oauth2.1+pkce" }) }));
    expect(result).toMatchObject({ journalId: id, status: "DRAFT", journal: { id, status: "DRAFT" }, workflowRefreshRequired: false });
    expect(tool(action).inputSchema.safeParse({ ...args, expectedApprovalVersion: undefined }).success).toBe(false);
    expect(tool(action).idempotent).toBe(true);
  });

  it("reports a committed mutation as successful when the follow-up read fails", async () => {
    mocks.submit.mockResolvedValue({ journalId: id, status: "SUBMITTED", contentHash: hash, approvalVersion: 3 });
    mocks.detail.mockRejectedValue(new Error("Temporary read outage"));
    expect(await tool("submit").invoke({ journalId: id, expectedContentHash: hash }, runtime())).toMatchObject({
      journalId: id, status: "SUBMITTED", workflowRefreshRequired: true, workflow: null,
    });
  });

  it("applies structured filters to the journal read and respects connection posting limits", async () => {
    mocks.workspace.mockResolvedValue({ journals: [{ id, canPost: true, workflow: { ...workflow, status: "DRAFT", actions: { ...workflow.actions, post: allowed } } }] });
    const list = DAILY_MCP_TOOLS.find((entry) => entry.policy.name === "finlynq_daily_list_journals")!;
    const rt = runtime();
    const filters = { dateFrom: "2025-01-01", dateTo: "2025-01-31", status: ["SUBMITTED"] };
    const result = await list.invoke({ filters }, { ...rt, snapshot: { ...rt.snapshot, dailyMode: "READ_ONLY" } });
    expect(mocks.workspace).toHaveBeenCalledWith(rt.sessionPrincipal, "", null, 1, filters);
    expect(result).toMatchObject({ journals: [{ canPost: false, workflow: { actions: { post: { reasonCode: "CONNECTION_RESTRICTED" } } } }] });
  });
});
