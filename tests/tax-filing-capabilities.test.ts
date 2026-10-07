import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLE_TEMPLATES } from "@/modules/identity/permissions";
import { taxFilingCapabilities, TAX_FILING_ACTIONS } from "@/modules/tax/filing-capabilities";
import { taxFilingSnapshot } from "@/modules/tax/filing-snapshot";
import type { TaxFilingWorkspaceDto } from "@/modules/tax/filing-workspace";
import { mcpTaxFilingWorkspace } from "@/modules/mcp/tax-filing-capabilities";
import { DAILY_MCP_TOOLS } from "@/modules/mcp/daily-tools";
import { SETUP_MCP_TOOLS } from "@/modules/mcp/setup-tools";
import { isMcpToolVisible, type McpAuthorizationSnapshot } from "@/modules/mcp/connection-policy";
import { MCP_OAUTH_SCOPES } from "@/modules/mcp/protocol";

const grants = { manageMappings: true, prepareFilings: true, manageConfigurations: true, manageCanonical: true, manageLifecycle: true };
const workspace: TaxFilingWorkspaceDto = {
  templates: [], ledgers: [], accounts: [], mappings: [], mappingVersions: [], filings: [],
  canManageMappings: true, canPrepareFilings: true, canManageConfigurations: true, canManageCanonical: true,
  capabilities: taxFilingCapabilities(true, grants),
};
const id = "10000000-0000-4000-8000-000000000001";
const snapshot: McpAuthorizationSnapshot = {
  principal: { connectionId: id, userId: id, organizationId: id, membershipId: id,
    organizationName: "Synthetic test", roleLabel: "Owner", clientId: "test", clientName: "Test",
    scopes: Object.values(MCP_OAUTH_SCOPES), resource: "https://business.finlynq.test/mcp",
    dailyMode: "CONFIRM_WRITES", setupMode: "CONFIRM_WRITES", toolOverrides: {}, tokenExpiresAt: new Date("2099-01-01"), organizationWritesEnabled: true },
  permissions: new Set(Object.values(PERMISSIONS)), dailyMode: "CONFIRM_WRITES", setupMode: "CONFIRM_WRITES", toolOverrides: {},
  directWriteSessionId: null, directWriteStepUpExpiresAt: null, connectionVersion: 1,
};
const deployedToolNames = [...DAILY_MCP_TOOLS, ...SETUP_MCP_TOOLS].map((tool) => tool.policy.name);

describe("tax configuration authorization diagnostics", () => {
  it("distinguishes deployed support, membership grants, OAuth consent and per-tool restrictions", () => {
    const action = TAX_FILING_ACTIONS.manageConfigurations;
    const definition = DAILY_MCP_TOOLS.find((tool) => tool.policy.name === action.toolName)!;
    const authorized = mcpTaxFilingWorkspace(workspace, { snapshot, deployedToolNames });
    expect(authorized.capabilities.manageConfigurations).toMatchObject({ allowed: true, supported: true, confirmationRequired: true });
    expect(isMcpToolVisible(snapshot, definition.policy)).toBe(true);
    const noPermission = { ...snapshot, permissions: new Set([PERMISSIONS.readTax, PERMISSIONS.manageTaxMappings, PERMISSIONS.prepareTaxFilings]) };
    const result = mcpTaxFilingWorkspace(workspace, { snapshot: noPermission, deployedToolNames });
    expect(result.capabilities.manageConfigurations).toMatchObject({ allowed: false, reasonCode: "PERMISSION_REQUIRED", requiredPermission: "tax.filing.configuration.manage", remediationUrl: "/app/settings" });
    expect(result.canManageCanonical).toBe(false);
    expect(result.canManageMappings).toBe(true);
    expect(result.canPrepareFilings).toBe(true);
    expect(isMcpToolVisible(noPermission, definition.policy)).toBe(false);
    const readOnly = { ...snapshot, principal: { ...snapshot.principal, scopes: [MCP_OAUTH_SCOPES.dailyRead] } };
    expect(mcpTaxFilingWorkspace(workspace, { snapshot: readOnly, deployedToolNames }).capabilities.manageConfigurations.reasonCode).toBe("OAUTH_SCOPE_REQUIRED");
    expect(mcpTaxFilingWorkspace(workspace, { snapshot: { ...snapshot, toolOverrides: { [action.toolName]: "OFF" } }, deployedToolNames }).capabilities.manageConfigurations.reasonCode).toBe("CONNECTION_MODE_RESTRICTED");
    expect(mcpTaxFilingWorkspace(workspace, { snapshot, deployedToolNames: deployedToolNames.filter((name) => name !== action.toolName) }).capabilities.manageConfigurations).toMatchObject({ supported: false, allowed: false, reasonCode: "UNSUPPORTED_DEPLOYED_CAPABILITY" });
  });

  it("keeps configuration, canonical and lifecycle permissions independent and never widens domain access", () => {
    const configureOnly = { ...snapshot, permissions: new Set([PERMISSIONS.manageTaxFilingConfiguration]) };
    const result = mcpTaxFilingWorkspace(workspace, { snapshot: configureOnly, deployedToolNames });
    expect(result.canManageConfigurations).toBe(true);
    expect(result.canManageCanonical).toBe(false);
    expect(result.canManageLifecycle).toBe(false);
    expect(mcpTaxFilingWorkspace({ ...workspace, capabilities: taxFilingCapabilities(false, grants) }, { snapshot, deployedToolNames }).canManageConfigurations).toBe(false);
    expect(ROLE_TEMPLATES.OWNER).toContain(PERMISSIONS.manageTaxFilingConfiguration);
    expect(ROLE_TEMPLATES.BOOKKEEPER_MAKER).not.toContain(PERMISSIONS.manageTaxFilingConfiguration);
    expect(ROLE_TEMPLATES.ACCOUNTANT_APPROVER).not.toContain(PERMISSIONS.manageTaxFilingCanonical);
  });
});

describe("immutable refresh inputs", () => {
  it("preserves omitted values separately from explicit zero and manual precision", () => {
    const restored = taxFilingSnapshot({ manualValues: { adjustment: "0", deduction: "1.2500" }, mappingVersion: 2 }, { line_300: "0" }, {}, []);
    expect(restored.manualValues).toEqual({ adjustment: "0", deduction: "1.2500" });
    expect(restored.reportedValues).toEqual({ line_300: "0" });
    expect(restored.manualInputsNeedReview).toBe(false);
  });
  it("recovers nonreconciling legacy manual amounts without mislabelling mapped or default-zero values", () => {
    const fields = ["adjustment", "deduction", "mapped"].map((key) => ({ key, kind: "MANUAL" }));
    const restored = taxFilingSnapshot({ definition: { fields } }, {}, { adjustment: "0.00", deduction: "3.25", mapped: "90.00" }, ["mapped"]);
    expect(restored.manualValues).toEqual({ deduction: "3.25" });
    expect(restored.manualInputsNeedReview).toBe(true);
  });
});
