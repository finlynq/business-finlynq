export const MCP_SCOPES = {
  ledgerRead: "ledger:read",
  openItemsRead: "open-items:read",
  journalDraftCreate: "journal-draft:create",
} as const;

export type McpScope = (typeof MCP_SCOPES)[keyof typeof MCP_SCOPES];

export const MCP_TOOLS = {
  ledgerRead: { name: "ledger.read", requiredScope: MCP_SCOPES.ledgerRead },
  openItemsRead: { name: "open-items.read", requiredScope: MCP_SCOPES.openItemsRead },
  journalDraftCreate: {
    name: "journal-draft.create",
    requiredScope: MCP_SCOPES.journalDraftCreate,
  },
} as const;

export type McpToolName = (typeof MCP_TOOLS)[keyof typeof MCP_TOOLS]["name"];

export type McpPrincipal = Readonly<{
  principalId: string;
  organizationId: string;
  scopes: readonly string[];
}>;

export function authorizeMcpTool(input: Readonly<{
  principal: McpPrincipal;
  requestOrganizationId: string;
  toolName: string;
}>): Readonly<{ allowed: boolean; reason: string }> {
  if (input.principal.organizationId !== input.requestOrganizationId) {
    return { allowed: false, reason: "Service principal is bound to another organization" };
  }

  const tool = Object.values(MCP_TOOLS).find((candidate) => candidate.name === input.toolName);
  if (!tool) {
    return { allowed: false, reason: "Unknown tools grant no capability" };
  }

  if (!input.principal.scopes.includes(tool.requiredScope)) {
    return { allowed: false, reason: `Required scope is missing: ${tool.requiredScope}` };
  }

  return { allowed: true, reason: "Organization and scope match" };
}
