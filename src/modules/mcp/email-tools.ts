import "server-only";
import { z } from "zod";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  createEmailAlias,
  getCustomerDeliveryPreference,
  getEmailDeliverySettings,
  listEmailAliases,
  listEmailBookingRules,
  listPaymentProfiles,
  retirePaymentProfile,
  rotateEmailAlias,
  saveCustomerDeliveryPreference,
  saveEmailDeliverySettings,
  savePaymentProfile,
  updateEmailAlias,
  upsertEmailBookingRule,
} from "@/modules/email/configuration";
import {
  clearEmailQuarantine,
  loadEmailOperations,
  retryEmailOperation,
  runEmailRetention,
} from "@/modules/email/operations";
import { processEmailPayable } from "@/modules/email/payables";
import {
  generateInvoicePdf,
  listInvoiceDeliveries,
  listInvoicePdfArtifacts,
  previewInvoiceDelivery,
  sendInvoice,
} from "@/modules/email/outbound";
import {
  clearEmailQuarantineSchema,
  createEmailAliasSchema,
  customerDeliveryPreferenceSchema,
  emailDeliverySettingsSchema,
  generateInvoicePdfSchema,
  processEmailPayableSchema,
  retirePaymentProfileSchema,
  retryEmailOperationSchema,
  rotateEmailAliasSchema,
  savePaymentProfileSchema,
  sendInvoiceSchema,
  updateEmailAliasSchema,
  upsertEmailBookingRuleSchema,
} from "@/modules/email/model";
import { mcpMutationContext } from "./oauth-store";
import { defineMcpTool, type McpToolDefinition, type McpToolRuntime } from "./tool-types";

function context(runtime: McpToolRuntime, reason: string) {
  return mcpMutationContext(runtime.principal, runtime.requestId, reason);
}

const setupTools: readonly McpToolDefinition[] = [
  defineMcpTool({
    policy: { name: "finlynq_setup_list_email_ingestion_addresses", group: "SETUP", access: "READ", permission: PERMISSIONS.readOrganizationSettings },
    title: "List inbound invoice email addresses",
    description: "List organization-owned opaque inbound aliases, routing, storage, status, rate limits, and versions. Full addresses are returned only inside the authorized tenant connection.",
    inputSchema: z.object({}).strict(),
    invoke: (_args, runtime) => listEmailAliases(context(runtime, "List email ingestion addresses")),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_create_email_ingestion_address", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Create inbound invoice email address",
    description: "Create an idempotent 128-bit opaque organization alias with optional legal-entity, document-purpose, and active OneDrive inbox routing.",
    inputSchema: createEmailAliasSchema,
    idempotent: true,
    invoke: (args, runtime) => createEmailAlias({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_update_email_ingestion_address", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Update inbound invoice email address",
    description: "Update labels, tenant routing, limits, or enabled state using the exact alias version. The opaque address and audit history remain immutable.",
    inputSchema: updateEmailAliasSchema,
    invoke: (args, runtime) => updateEmailAlias({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_rotate_email_ingestion_address", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Rotate inbound invoice email address",
    description: "Retire one exact alias version and create a new idempotent opaque alias with the same tenant routing. Retired aliases never reveal whether they once existed.",
    inputSchema: rotateEmailAliasSchema,
    idempotent: true,
    invoke: (args, runtime) => rotateEmailAlias({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_list_email_booking_rules", group: "SETUP", access: "READ", permission: PERMISSIONS.readOrganizationSettings },
    title: "List email booking rules",
    description: "List versioned REVIEW_ONLY, CREATE_DRAFT, and AUTO_POST rules with explicit conditions and accounting mappings.",
    inputSchema: z.object({}).strict(),
    invoke: (_args, runtime) => listEmailBookingRules(context(runtime, "List email booking rules")),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_upsert_email_booking_rule", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Create or version an email booking rule",
    description: "Append an idempotent booking-rule version. Sender trust alone never authorizes posting; complete extraction and tenant posting policy are also required.",
    inputSchema: upsertEmailBookingRuleSchema,
    idempotent: true,
    invoke: (args, runtime) => upsertEmailBookingRule({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_list_payment_instruction_profiles", group: "SETUP", access: "READ", permission: PERMISSIONS.readOrganizationSettings },
    title: "List masked payment instruction profiles",
    description: "List tenant-owned legal-entity and currency payment-profile versions. Sensitive bank values are always masked in this response.",
    inputSchema: z.object({}).strict(),
    invoke: (_args, runtime) => listPaymentProfiles(context(runtime, "List payment profiles")),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_save_payment_instruction_profile", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings, mfaRequirement: "REQUIRED" },
    title: "Create or version payment instructions",
    description: "Encrypt and append a payment-profile version for one legal entity and currency. Normal reads remain masked and issued PDFs retain their immutable snapshot.",
    inputSchema: savePaymentProfileSchema,
    idempotent: true,
    invoke: (args, runtime) => savePaymentProfile({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_retire_payment_instruction_profile", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings, mfaRequirement: "REQUIRED" },
    title: "Retire payment instructions",
    description: "Retire an exact profile version without deleting history or changing an issued invoice PDF.",
    inputSchema: retirePaymentProfileSchema,
    destructive: true,
    invoke: (args, runtime) => retirePaymentProfile({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_get_customer_delivery_preference", group: "SETUP", access: "READ", permission: PERMISSIONS.readReceivables },
    title: "Get customer invoice delivery preference",
    description: "Return tenant-scoped recipients, template, opt-in state, selected profile, and bounce/complaint suppression for one customer account.",
    inputSchema: z.object({ partyAccountId: z.uuid() }).strict(),
    invoke: (args, runtime) => getCustomerDeliveryPreference(context(runtime, "Read customer delivery preference"), args.partyAccountId),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_update_customer_delivery_preference", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageReceivables },
    title: "Update customer invoice delivery preference",
    description: "Version customer recipients, template, opt-in auto-send, selected payment profile, and authorized suppression re-enable.",
    inputSchema: customerDeliveryPreferenceSchema,
    invoke: (args, runtime) => saveCustomerDeliveryPreference({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_get_invoice_delivery_configuration", group: "SETUP", access: "READ", permission: PERMISSIONS.readOrganizationSettings },
    title: "Get invoice delivery and retention configuration",
    description: "Return organization outbound/auto-send policy and transient, quarantine, and operations retention windows.",
    inputSchema: z.object({}).strict(),
    invoke: (_args, runtime) => getEmailDeliverySettings(context(runtime, "Read invoice delivery configuration")),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_update_invoice_delivery_configuration", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Update invoice delivery and retention configuration",
    description: "Version organization outbound/auto-send policy and bounded transient, quarantine, and operations retention windows.",
    inputSchema: emailDeliverySettingsSchema,
    invoke: (args, runtime) => saveEmailDeliverySettings({ context: context(runtime, args.reason), ...args }),
  }),
];

const dailyTools: readonly McpToolDefinition[] = [
  defineMcpTool({
    policy: { name: "finlynq_daily_process_email_payable", group: "DAILY", access: "WRITE", permission: PERMISSIONS.managePayables },
    title: "Evaluate and process an emailed supplier invoice",
    description: "Apply tenant rules to a claimed EMAIL inbox item. Ambiguity stays in review; an exact trusted match may create a draft or post only when tenant policy also permits it.",
    inputSchema: processEmailPayableSchema,
    idempotent: true,
    invoke: (args, runtime) => processEmailPayable({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_generate_sales_invoice_pdf", group: "DAILY", access: "WRITE", permission: PERMISSIONS.manageReceivables },
    title: "Generate sales invoice PDF",
    description: "Generate or return one deterministic encrypted PDF for the exact sales-invoice version/content hash. Issued output requires a posted invoice; draft output is visibly marked preview.",
    inputSchema: generateInvoicePdfSchema,
    idempotent: true,
    invoke: (args, runtime) => generateInvoicePdf({ context: context(runtime, "Generate deterministic invoice PDF"), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_list_sales_invoice_pdfs", group: "DAILY", access: "READ", permission: PERMISSIONS.readReceivables },
    title: "List sales invoice PDFs",
    description: "List immutable preview and issued PDF artifacts for one tenant-owned sales invoice.",
    inputSchema: z.object({ sourceDocumentId: z.uuid() }).strict(),
    invoke: (args, runtime) => listInvoicePdfArtifacts(context(runtime, "List invoice PDFs"), args.sourceDocumentId),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_preview_invoice_delivery", group: "DAILY", access: "READ", permission: PERMISSIONS.readReceivables },
    title: "Preview customer invoice delivery",
    description: "Return the exact invoice version, configured recipients, suppression and organization policy, and available immutable PDF artifacts without sending.",
    inputSchema: z.object({ sourceDocumentId: z.uuid() }).strict(),
    invoke: (args, runtime) => previewInvoiceDelivery(context(runtime, "Preview invoice delivery"), args.sourceDocumentId),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_send_sales_invoice", group: "DAILY", access: "WRITE", permission: PERMISSIONS.manageReceivables },
    title: "Send or resend sales invoice",
    description: "Send the exact immutable issued PDF to explicit normalized recipients. Identical retries are idempotent; manualResend with a new key creates a new attempt without reissuing accounting.",
    inputSchema: sendInvoiceSchema,
    idempotent: true,
    openWorld: true,
    invoke: (args, runtime) => sendInvoice({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_list_invoice_delivery_attempts", group: "DAILY", access: "READ", permission: PERMISSIONS.readReceivables },
    title: "List invoice delivery attempts",
    description: "List queued, sent, delivered, bounced, complained, and failed attempts without provider secrets or raw signed URLs.",
    inputSchema: z.object({ sourceDocumentId: z.uuid().optional() }).strict(),
    invoke: (args, runtime) => listInvoiceDeliveries(context(runtime, "List invoice delivery attempts"), args.sourceDocumentId),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_get_email_operations", group: "DAILY", access: "READ", permission: PERMISSIONS.readOrganizationSettings },
    title: "Get email operations dashboard",
    description: "Return minimized tenant-scoped queue, quarantine, retry, retention, and delivery metrics plus recent operational status.",
    inputSchema: z.object({}).strict(),
    invoke: (_args, runtime) => loadEmailOperations(context(runtime, "Read email operations")),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_retry_email_operation", group: "DAILY", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Retry failed email operation",
    description: "Retry one bounded inbound-message, attachment, OneDrive, or delivery stage without duplicating downstream artifacts.",
    inputSchema: retryEmailOperationSchema,
    idempotent: true,
    openWorld: true,
    invoke: (args, runtime) => retryEmailOperation({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_clear_email_quarantine", group: "DAILY", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings, mfaRequirement: "REQUIRED" },
    title: "Clear reviewed email quarantine",
    description: "Explicitly clear eligible content after human security review. Unsupported, corrupt, oversize, and encrypted files remain blocked.",
    inputSchema: clearEmailQuarantineSchema,
    destructive: true,
    invoke: (args, runtime) => clearEmailQuarantine({ context: context(runtime, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_run_email_retention", group: "DAILY", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Run email transient-data retention",
    description: "Minimize expired transient envelopes, staged bytes, and operational details while retaining immutable accounting evidence, hashes, lineage, and delivery events.",
    inputSchema: z.object({ reason: z.string().trim().min(5).max(500) }).strict(),
    destructive: true,
    invoke: (args, runtime) => runEmailRetention(context(runtime, args.reason)),
  }),
];

export const EMAIL_MCP_TOOLS: readonly McpToolDefinition[] = [...setupTools, ...dailyTools];
