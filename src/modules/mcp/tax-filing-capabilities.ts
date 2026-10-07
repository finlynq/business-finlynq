import "server-only";
import { TAX_FILING_ACTIONS, type TaxFilingAction, type TaxFilingCapabilities } from "@/modules/tax/filing-capabilities";
import type { TaxFilingWorkspaceDto } from "@/modules/tax/filing-workspace";
import { effectiveToolMode, isMcpToolVisible } from "./connection-policy";
import { MCP_OAUTH_SCOPES } from "./protocol";
import type { McpToolRuntime } from "./tool-types";

export function mcpTaxFilingWorkspace(workspace: TaxFilingWorkspaceDto, runtime: Pick<McpToolRuntime, "snapshot" | "deployedToolNames">) {
  const capabilities = Object.fromEntries(Object.entries(TAX_FILING_ACTIONS).map(([key, action]) => {
    const domain = workspace.capabilities![key as TaxFilingAction];
    const policy = { name: action.toolName, group: action.group, permission: action.permission, access: "WRITE" as const };
    const requiredScope = action.group === "SETUP" ? MCP_OAUTH_SCOPES.setupWrite : MCP_OAUTH_SCOPES.dailyWrite;
    const supported = !runtime.deployedToolNames || runtime.deployedToolNames.includes(action.toolName);
    const mode = effectiveToolMode(runtime.snapshot, policy);
    const missingPermission = !runtime.snapshot.permissions.has(action.permission);
    const missingScope = !runtime.snapshot.principal.scopes.includes(requiredScope);
    const restriction = !supported ? {
      reasonCode: "UNSUPPORTED_DEPLOYED_CAPABILITY", reason: "This server catalog does not contain the tool. Ask the service administrator to deploy the tax filing configuration release, then reconnect to refresh the catalog.", remediationUrl: "/app/settings/mcp",
    } : missingPermission ? {
      reasonCode: "PERMISSION_REQUIRED", reason: `Ask an organization owner or role administrator to review access to ${action.permission} in Organization settings → Members & fixed roles. Reconnecting alone cannot add a membership permission.`, remediationUrl: "/app/settings",
    } : missingScope ? {
      reasonCode: "OAUTH_SCOPE_REQUIRED", reason: `Reconnect with ${requiredScope} consent in MCP settings. Membership permission is present, but this connection lacks the OAuth scope.`, remediationUrl: "/app/settings/mcp",
    } : !isMcpToolVisible(runtime.snapshot, policy) ? {
      reasonCode: "CONNECTION_MODE_RESTRICTED", reason: `Enable ${action.group === "SETUP" ? "Setup" : "Daily"} writes or review this tool's override in MCP settings.`, remediationUrl: "/app/settings/mcp",
    } : null;
    return [key, {
      ...domain, supported, requiredScope,
      allowed: domain.allowed && !restriction,
      ...(restriction ?? {}),
      confirmationRequired: !restriction && domain.allowed && mode === "CONFIRM_WRITES",
    }];
  })) as TaxFilingCapabilities;
  return { ...workspace, capabilityVersion: 1, capabilities,
    canManageMappings: capabilities.manageMappings.allowed,
    canPrepareFilings: capabilities.prepareFilings.allowed,
    canManageConfigurations: capabilities.manageConfigurations.allowed,
    canManageCanonical: capabilities.manageCanonical.allowed,
    canManageLifecycle: capabilities.manageLifecycle.allowed,
  };
}
