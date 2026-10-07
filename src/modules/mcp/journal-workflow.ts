import "server-only";

import { PERMISSIONS } from "@/modules/identity/permissions";
import type { JournalWorkflowAction, JournalWorkflowEligibility } from "@/modules/ledger/journal-workflow-eligibility";
import { loadTenantJournalDetail } from "@/modules/ledger/tenant-workspace";
import { effectiveToolMode, isMcpToolVisible, mcpToolAuthorizationMetadata, type McpAuthorizationSnapshot, type McpToolPolicy } from "./connection-policy";
import type { McpToolRuntime } from "./tool-types";

export const JOURNAL_WORKFLOW_TOOL_POLICIES: Readonly<Record<JournalWorkflowAction, McpToolPolicy>> = {
  submit: { name: "finlynq_daily_submit_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.submitJournal },
  approve: { name: "finlynq_daily_approve_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.approveJournal },
  post: { name: "finlynq_daily_post_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.postJournal },
  reject: { name: "finlynq_daily_reject_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.approveJournal },
  withdraw: { name: "finlynq_daily_withdraw_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.submitJournal },
};

/** Connection grants can narrow domain eligibility, never widen it. */
export function mcpJournalWorkflow(workflow: JournalWorkflowEligibility | null, snapshot: McpAuthorizationSnapshot) {
  if (!workflow) return null;
  const actions = Object.fromEntries((Object.keys(JOURNAL_WORKFLOW_TOOL_POLICIES) as JournalWorkflowAction[]).map((action) => {
    const policy = JOURNAL_WORKFLOW_TOOL_POLICIES[action];
    const domain = workflow.actions[action];
    const connectionAllows = isMcpToolVisible(snapshot, policy);
    return [action, {
      ...domain,
      ...(!connectionAllows && domain.allowed ? {
        allowed: false,
        reasonCode: "CONNECTION_RESTRICTED",
        reason: "This connection does not allow this action. Review its Daily write permissions and tool overrides in MCP settings.",
      } : {}),
      toolName: policy.name,
      confirmationRequired: connectionAllows && effectiveToolMode(snapshot, policy) === "CONFIRM_WRITES",
      authorization: mcpToolAuthorizationMetadata(snapshot, policy),
    }];
  })) as Record<JournalWorkflowAction, {
    allowed: boolean; reasonCode: string | null; reason: string | null;
    toolName: string; confirmationRequired: boolean; authorization: Readonly<Record<string, string | boolean>>;
  }>;
  return { ...workflow, actions };
}

export async function readMcpJournal(runtime: McpToolRuntime, journalId: string) {
  const journal = await loadTenantJournalDetail(runtime.sessionPrincipal, journalId);
  return journal ? { ...journal, workflow: mcpJournalWorkflow(journal.workflow, runtime.snapshot) } : null;
}

export async function refreshedJournalTransition<T extends { journalId: string }>(runtime: McpToolRuntime, result: T) {
  // A read outage after the transaction commits must not turn a successful
  // accounting write into a reported failure and encourage a blind retry.
  try {
    const journal = await readMcpJournal(runtime, result.journalId);
    return { ...result, journal, workflow: journal?.workflow ?? null, workflowRefreshRequired: journal === null };
  } catch {
    return {
      ...result,
      journal: null,
      workflow: null,
      workflowRefreshRequired: true,
      nextStep: "The transition succeeded. Call finlynq_daily_get_journal to refresh the current state and available actions.",
    };
  }
}
