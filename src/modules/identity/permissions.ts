export const PERMISSIONS = {
  draftJournal: "ledger.journal.draft",
  submitJournal: "ledger.journal.submit",
  approveJournal: "ledger.journal.approve",
  postJournal: "ledger.journal.post",
  postAdjustment: "ledger.journal.post_adjustment",
  reverseJournal: "ledger.journal.reverse",
  managePostingPolicy: "ledger.posting_policy.manage",
  manageSegments: "ledger.segments.manage",
  closePeriod: "ledger.period.close",
  reopenPeriod: "ledger.period.reopen",
  sealPeriod: "ledger.period.seal",
  manageRoles: "organization.roles.manage",
  readMcpLedger: "mcp.ledger.read",
  createMcpDraft: "mcp.journal-draft.create",
  manageRecovery: "organization.recovery.manage",
  readParties: "parties.read",
  manageParties: "parties.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLE_TEMPLATES: Readonly<Record<string, readonly Permission[]>> = {
  OWNER: Object.values(PERMISSIONS),
  ACCOUNTANT_APPROVER: [
    PERMISSIONS.draftJournal,
    PERMISSIONS.submitJournal,
    PERMISSIONS.approveJournal,
    PERMISSIONS.postJournal,
    PERMISSIONS.postAdjustment,
    PERMISSIONS.reverseJournal,
    PERMISSIONS.managePostingPolicy,
    PERMISSIONS.closePeriod,
    PERMISSIONS.reopenPeriod,
    PERMISSIONS.readParties,
    PERMISSIONS.manageParties,
  ],
  BOOKKEEPER_MAKER: [
    PERMISSIONS.draftJournal,
    PERMISSIONS.submitJournal,
    PERMISSIONS.readParties,
    PERMISSIONS.manageParties,
  ],
  VIEWER_AUDITOR: [PERMISSIONS.readParties],
  INTEGRATION_MCP: [PERMISSIONS.readMcpLedger, PERMISSIONS.createMcpDraft],
};

export function permissionsForRoles(roleKeys: readonly string[]): Set<Permission> {
  return new Set(
    roleKeys.flatMap((roleKey) => [...(ROLE_TEMPLATES[roleKey] ?? [])]),
  );
}
