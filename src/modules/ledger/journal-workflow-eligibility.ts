import "server-only";

import type { PoolClient } from "pg";
import type { SessionPrincipal } from "@/modules/identity/session";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { principalCanWrite } from "@/modules/workspace/write-policy";

export type JournalWorkflowAction = "submit" | "approve" | "post" | "reject" | "withdraw";
export type JournalWorkflowReasonCode = "MISSING_PERMISSION" | "WRITES_DISABLED" | "INVALID_STATE" |
  "CREATOR_CANNOT_APPROVE" | "CREATOR_REQUIRED" | "PERIOD_CLOSED" | "STALE_VERSION" |
  "POLICY_RESTRICTION" | "HAS_DEPENDENCIES" | "INVALID_CONTENT" | "APPROVAL_REQUIRED";
export type JournalActionEligibility = Readonly<{
  allowed: boolean;
  reasonCode: JournalWorkflowReasonCode | null;
  reason: string | null;
}>;
export type JournalWorkflowEligibility = Readonly<{
  status: string;
  contentHash: string | null;
  approvalVersion: number | null;
  manualPostingMode: "REVIEW_REQUIRED" | "AUTO_POST";
  actorIsCreator: boolean;
  independentApprovalRequired: boolean;
  actions: Readonly<Record<JournalWorkflowAction, JournalActionEligibility>>;
}>;

const reasons: Record<JournalWorkflowReasonCode, string> = {
  MISSING_PERMISSION: "Your active organization role does not permit this action.",
  WRITES_DISABLED: "Accounting writes are disabled for this organization or session.",
  INVALID_STATE: "This action is unavailable in the journal's current state.",
  CREATOR_CANNOT_APPROVE: "The creator cannot approve or reject this journal. Ask a different authorized approver to review it, or withdraw your submission.",
  CREATOR_REQUIRED: "Only the journal creator can withdraw this submission. An independent approver can reject it for correction.",
  PERIOD_CLOSED: "The accounting period is closed or does not permit this journal's purpose.",
  STALE_VERSION: "The frozen journal content or approval version changed. Refresh and review the current version.",
  POLICY_RESTRICTION: "This journal must be managed through its owning module, or its ledger is inactive.",
  HAS_DEPENDENCIES: "This journal has a source, reversal, reconciliation, subledger, party, or tax dependency and cannot be returned to draft here.",
  INVALID_CONTENT: "The journal needs valid balanced lines and active accounts before it can progress.",
  APPROVAL_REQUIRED: "An authorized approver must approve the submitted version before posting. AUTO_POST does not bypass an existing submission.",
};
export class JournalWorkflowError extends Error {
  constructor(public readonly code: JournalWorkflowReasonCode, message = reasons[code]) {
    super(message);
    this.name = "JournalWorkflowError";
  }
}
const denied = (code: JournalWorkflowReasonCode): JournalActionEligibility => ({ allowed: false, reasonCode: code, reason: reasons[code] });
const allowed: JournalActionEligibility = { allowed: true, reasonCode: null, reason: null };

export type JournalWorkflowFacts = Readonly<{
  id: string; status: string; content_hash: string | null; canonical_hash: string | null;
  approval_version: number | null; created_by: string | null; owner_module: string;
  journal_type_key: string; manual_mode: "REVIEW_REQUIRED" | "AUTO_POST";
  period_state: string; purpose: string; ledger_active: boolean; has_dependencies: boolean;
  valid_lines: boolean; has_approval: boolean; deleted: boolean;
}>;

export function evaluateJournalWorkflow(
  journal: JournalWorkflowFacts,
  actor: Readonly<{ actorId: string; canWrite: boolean; permissions: ReadonlySet<string>; selfApprovalAllowed?: boolean }>,
): JournalWorkflowEligibility {
  const frozen = journal.status === "SUBMITTED" || journal.status === "APPROVED";
  const actorIsCreator = journal.created_by === actor.actorId;
  const permission: Record<JournalWorkflowAction, string> = {
    submit: PERMISSIONS.submitJournal, approve: PERMISSIONS.approveJournal,
    post: PERMISSIONS.postJournal, reject: PERMISSIONS.approveJournal, withdraw: PERMISSIONS.submitJournal,
  };
  const eligibility = (action: JournalWorkflowAction): JournalActionEligibility => {
    if (!actor.canWrite) return denied("WRITES_DISABLED");
    if (!actor.permissions.has(permission[action])) return denied("MISSING_PERMISSION");
    if (journal.owner_module !== "ledger" || journal.journal_type_key !== "ledger.manual" || !journal.ledger_active) return denied("POLICY_RESTRICTION");
    if (journal.deleted || !(action === "submit" ? journal.status === "DRAFT" : action === "post" ? ["DRAFT", "SUBMITTED", "APPROVED"].includes(journal.status) : journal.status === "SUBMITTED")) return denied("INVALID_STATE");
    if (!new Set(["OPEN", "ADJUSTMENT_ONLY"]).has(journal.period_state) ||
        (journal.period_state === "ADJUSTMENT_ONLY" && !new Set(["ADJUSTING", "REVERSAL", "CLOSING", "REVALUATION", "TAX_ADJUSTMENT"]).has(journal.purpose))) return denied("PERIOD_CLOSED");
    if (action === "post" && journal.period_state === "ADJUSTMENT_ONLY" && !actor.permissions.has(PERMISSIONS.postAdjustment)) return denied("MISSING_PERMISSION");
    if (!journal.canonical_hash || (frozen && (!journal.approval_version || journal.content_hash !== journal.canonical_hash))) return denied("STALE_VERSION");
    if ((action === "reject" || (action === "approve" && !actor.selfApprovalAllowed)) && actorIsCreator) return denied("CREATOR_CANNOT_APPROVE");
    if (action === "withdraw" && !actorIsCreator) return denied("CREATOR_REQUIRED");
    if (action === "withdraw" || action === "reject") return journal.has_dependencies ? denied("HAS_DEPENDENCIES") : allowed;
    if (!journal.valid_lines) return denied("INVALID_CONTENT");
    if (action === "post" && (journal.status === "SUBMITTED" ||
      (journal.status === "APPROVED" && !journal.has_approval))) return denied("APPROVAL_REQUIRED");
    return allowed;
  };
  return {
    status: journal.status,
    contentHash: frozen ? journal.content_hash : journal.canonical_hash,
    approvalVersion: journal.approval_version,
    manualPostingMode: journal.manual_mode,
    actorIsCreator,
    independentApprovalRequired: journal.status === "SUBMITTED" && !(actorIsCreator && actor.selfApprovalAllowed),
    actions: { submit: eligibility("submit"), approve: eligibility("approve"), post: eligibility("post"), reject: eligibility("reject"), withdraw: eligibility("withdraw") },
  };
}

/** Reads all workflow facts in one tenant-scoped batch; no session role labels are trusted. */
export async function readJournalWorkflowFacts(client: PoolClient, organizationId: string, journalIds: readonly string[]) {
  if (!journalIds.length) return [];
  const result = await client.query<JournalWorkflowFacts>(
    `SELECT entry.id, entry.status, entry.content_hash, entry.approval_version, entry.created_by,
       type.owner_module, entry.journal_type_key, coalesce(policy.manual_mode, 'REVIEW_REQUIRED') AS manual_mode,
       period.state AS period_state, entry.purpose, ledger.active AS ledger_active,
       app.compute_journal_content_hash(entry.id)::text AS canonical_hash,
       EXISTS (SELECT 1 FROM journal_transaction_controls control WHERE control.organization_id = entry.organization_id
         AND control.journal_entry_id = entry.id AND control.outcome = 'DELETED') AS deleted,
       (entry.source_document_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM journal_entry_relations relation WHERE relation.organization_id = entry.organization_id
           AND (relation.from_journal_id = entry.id OR relation.to_journal_id = entry.id)
       ) OR EXISTS (
         SELECT 1 FROM journal_lines line WHERE line.organization_id = entry.organization_id AND line.journal_entry_id = entry.id
           AND (line.party_account_id IS NOT NULL OR line.subledger_event_id IS NOT NULL OR line.tax_snapshot_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM bank_match_allocations allocation WHERE allocation.organization_id = line.organization_id AND allocation.journal_line_id = line.id))
       )) AS has_dependencies,
       (SELECT count(*) >= 2 AND coalesce(sum(line.debit_functional),0) > 0
          AND sum(line.debit_functional) = sum(line.credit_functional)
          AND bool_and(combination.active AND account.active AND account.postable
            AND combination.entity_id = entry.legal_entity_id
            AND account.valid_from <= entry.accounting_date
            AND (account.valid_to IS NULL OR account.valid_to >= entry.accounting_date))
        FROM journal_lines line
        JOIN account_combinations combination ON combination.organization_id = line.organization_id AND combination.id = line.account_combination_id
        JOIN gl_accounts account ON account.organization_id = combination.organization_id AND account.id = combination.account_id
        WHERE line.organization_id = entry.organization_id AND line.journal_entry_id = entry.id) AS valid_lines,
       EXISTS (SELECT 1 FROM journal_approvals approval WHERE approval.organization_id = entry.organization_id
         AND approval.journal_entry_id = entry.id AND approval.journal_version = entry.approval_version
         AND approval.content_hash = entry.content_hash AND approval.decision = 'APPROVED'
         AND (approval.actor_id IS DISTINCT FROM entry.created_by
           OR approval.mcp_self_approval_connection_id IS NOT NULL)) AS has_approval
     FROM journal_entries entry
     JOIN journal_type_definitions type ON type.id = entry.journal_type_definition_id AND type.key = entry.journal_type_key AND type.version = entry.journal_type_version
     JOIN ledgers ledger ON ledger.organization_id = entry.organization_id AND ledger.id = entry.ledger_id
     LEFT JOIN ledger_posting_policies policy ON policy.organization_id = entry.organization_id AND policy.ledger_id = entry.ledger_id
     JOIN fiscal_periods period ON period.organization_id = entry.organization_id AND period.ledger_id = entry.ledger_id AND period.id = entry.period_id
     WHERE entry.organization_id = $1 AND entry.id = ANY($2::uuid[])`,
    [organizationId, journalIds],
  );
  return result.rows;
}

export async function getJournalWorkflowEligibility(
  client: PoolClient, principal: SessionPrincipal, journalIds: readonly string[],
): Promise<Map<string, JournalWorkflowEligibility>> {
  if (!journalIds.length) return new Map();
  const rows = await readJournalWorkflowFacts(client, principal.organizationId, journalIds);
  const permissions = await client.query<{ permission_key: string }>(
    `SELECT DISTINCT permission.permission_key FROM organization_memberships membership
     JOIN organizations organization ON organization.id = membership.organization_id AND organization.active
     JOIN membership_roles membership_role ON membership_role.organization_id = membership.organization_id AND membership_role.membership_id = membership.id
     JOIN roles role ON role.organization_id = membership.organization_id AND role.id = membership_role.role_id AND role.active
     JOIN role_permissions permission ON permission.organization_id = role.organization_id AND permission.role_id = role.id
     WHERE membership.organization_id = $1 AND membership.user_id = $2 AND membership.active`,
    [principal.organizationId, principal.userId],
  );
  const actor = { actorId: principal.userId, canWrite: principalCanWrite(principal), permissions: new Set(permissions.rows.map((row) => row.permission_key)) };
  return new Map(rows.map((row) => [row.id, evaluateJournalWorkflow(row, actor)]));
}
