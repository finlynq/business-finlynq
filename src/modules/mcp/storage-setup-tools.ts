import "server-only";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { prepareStorageSetup, getStorageSetup } from "@/modules/document-storage/setup";
import { prepareStorageSetupSchema, storageSetupStatusSchema } from "@/modules/document-storage/model";
import { mcpMutationContext } from "./oauth-store";
import { defineMcpTool } from "./tool-types";

export const STORAGE_SETUP_MCP_TOOLS = [
  defineMcpTool({
    policy: { name: "finlynq_setup_prepare_document_storage", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Prepare company document storage",
    description: "Prepare an idempotent OneDrive connection for an exact company and payables or receivables module. Requires organization settings and selected-module management permissions. Optionally reuse your own active same-company OneDrive app-folder grant by connectionId. Returns a stable status handle, exact provider/sharing scope and secure browser handoff. It never activates sharing: the requesting user must approve that scope in their signed-in browser. New Inbox/Archive folders stay within Files.ReadWrite.AppFolder; renewed OAuth is requested only if needed. Never provide credentials or fabricate user consent. Poll get_document_storage_setup after the user completes the handoff, then use its connectionId and module to continue the daily upload/claim/read/complete workflow.",
    inputSchema: prepareStorageSetupSchema, idempotent: true,
    invoke: (args, runtime) => prepareStorageSetup(mcpMutationContext(runtime.principal, runtime.requestId, "Prepare document storage sharing request"), args),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_get_document_storage_setup", group: "SETUP", access: "READ", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Get document storage setup status",
    description: "Read your company/module storage setup handle. Returns USER_APPROVAL_REQUIRED, CONNECTION_REQUIRED or READY, access summary and Inbox/Archive URLs when ready. Rechecks company and module access. No provider credentials or browser authorization codes are returned. A failed or expired OAuth handoff is recoverable at the same signed-in handoff URL.",
    inputSchema: storageSetupStatusSchema,
    invoke: (args, runtime) => getStorageSetup(mcpMutationContext(runtime.principal, runtime.requestId, "Read document storage setup status"), args.connectionId),
  }),
];
