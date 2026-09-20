import "server-only";

import { z } from "zod";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { mutationContext } from "@/modules/workspace/write-policy";
import {
  accountCombinationConfigurationSchema,
  addSegmentValue,
  configureOrganizationCurrency,
  configureSegment,
  configureTaxRegistration,
  createAccountCombination,
  createFiscalPeriods,
  createLegalEntity,
  currencyRateConfigurationSchema,
  fiscalPeriodCreationSchema,
  legalEntityConfigurationSchema,
  loadAccountingConfiguration,
  organizationCurrencyConfigurationSchema,
  recordCurrencyRate,
  segmentConfigurationSchema,
  segmentValueConfigurationSchema,
  taxRegistrationConfigurationSchema,
} from "@/modules/ledger/accounting-configuration";
import {
  createAccountingHierarchy,
  createAccountingHierarchySchema,
  loadAccountingHierarchies,
  publishAccountingHierarchy,
  publishAccountingHierarchySchema,
  saveAccountingHierarchy,
  saveAccountingHierarchySchema,
} from "@/modules/ledger/accounting-hierarchies";
import { createGlAccount, createGlAccountSchema, updateGlAccount, updateGlAccountSchema } from "@/modules/ledger/chart-of-accounts-service";
import { transitionFiscalPeriod } from "@/modules/ledger/period-service";
import { changeLedgerPostingPolicy, postingPolicyChangeSchema } from "@/modules/ledger/posting-policy-service";
import { loadPeriodControlWorkspace, loadTenantPartyDirectory } from "@/modules/ledger/tenant-workspace";
import { addPartyAccount, createParty } from "@/modules/parties/party-service";
import { updateParty, updatePartySchema } from "@/modules/parties/party-lifecycle-service";
import {
  bankRuleActionSchema,
  bankRuleConditionSchema,
  createBankRule,
  mapBankExternalAccount,
  versionBankRuleState,
} from "@/modules/banking/banking-service";
import { oauthPublicOrigin } from "./protocol";
import { mcpMutationContext } from "./oauth-store";
import { defineMcpTool, type McpToolDefinition } from "./tool-types";
import {
  configureOrganizationFxProviderPolicy,
  organizationFxProviderPolicyConfigurationSchema,
} from "@/modules/fx/provider-policy";
import {
  deactivateTaxAccountMappings,
  deactivateTaxAccountMappingsSchema,
  saveTaxAccountMappings,
  saveTaxAccountMappingsSchema,
} from "@/modules/tax/filing-service";
import { loadTaxAccountMappingHistory, loadTaxFilingWorkspace, previewTaxAccountMappings } from "@/modules/tax/filing-workspace";

const emptySchema = z.object({}).strict();
const accountingConfigurationContextSchema = z.object({
  accountingDate: z.iso.date().optional(),
}).strict();
const partyAccountSchema = z.object({
  legalEntityId: z.uuid(),
  ledgerId: z.uuid(),
  role: z.enum(["CUSTOMER", "SUPPLIER"]),
  accountNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
  controlAccountId: z.uuid(),
  transactionCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable().optional(),
}).strict();
const partyAddressSchema = z.object({
  kind: z.enum(["BILLING", "SHIPPING", "REMIT_TO", "REGISTERED"]),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(30),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  validFrom: z.iso.date(),
}).strict();
const createPartySchema = z.object({
  partyNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
  displayName: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(180),
  internalLegalEntityId: z.uuid().optional(),
  account: partyAccountSchema.optional(),
  address: partyAddressSchema.optional(),
}).strict();

export const SETUP_MCP_TOOLS: readonly McpToolDefinition[] = [
  defineMcpTool({
    policy: { name: "finlynq_setup_get_configuration", group: "SETUP", access: "READ", permission: PERMISSIONS.readOrganizationSettings },
    title: "Get accounting configuration",
    description: "Return organization currencies, FX rates, FX provider policy, legal entities, ledgers, tax registrations, segments, values, chart accounts, account combinations, and posting policies. Supply the intended accounting date to receive each combination's effective dates and validOnAccountingDate result before a write.",
    inputSchema: accountingConfigurationContextSchema,
    invoke: (args, runtime) => loadAccountingConfiguration(
      runtime.sessionPrincipal,
      args.accountingDate,
    ),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_get_tax_filing_configuration", group: "SETUP", access: "READ", permission: PERMISSIONS.readTax },
    title: "Get tax filing configuration",
    description: "Return reviewed shared filing templates, eligible company ledgers and accounts, and the latest client mapping versions. Use these stable IDs before appending a mapping version; filing workpaper history remains on the Daily tool.",
    inputSchema: emptySchema,
    invoke: (_args, runtime) => loadTaxFilingWorkspace(
      runtime.sessionPrincipal,
      { includeFilings: false },
    ),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_list_parties", group: "SETUP", access: "READ", permission: PERMISSIONS.readParties },
    title: "List customers and suppliers",
    description: "Search the encrypted party directory by exact name or party-number prefix. Returns party, address, and customer/supplier account IDs needed by daily documents.",
    inputSchema: z.object({ search: z.string().trim().max(200).default(""), page: z.number().int().min(1).max(10000).default(1) }).strict(),
    invoke: (args, runtime) => loadTenantPartyDirectory(runtime.sessionPrincipal, args.search, args.page),
  }),
  defineMcpTool({
    policy: {
      name: "finlynq_setup_create_party",
      group: "SETUP",
      access: "WRITE",
      permission: PERMISSIONS.manageParties,
      actionClass: "PARTY",
      mfaRequirement: "NOT_REQUIRED",
    },
    title: "Create customer or supplier",
    description: "Create an encrypted, idempotent party and optionally its first customer/supplier account and address. Party numbers and account numbers are organization-scoped business identifiers.",
    inputSchema: createPartySchema,
    invoke: (args, runtime) => createParty({ context: mcpMutationContext(runtime.principal, runtime.requestId, `Create party ${args.partyNumber}`), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_add_party_account", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageParties },
    title: "Add customer or supplier account",
    description: "Attach another entity-specific customer or supplier account to an existing party. Control account and optional transaction currency are validated against the selected ledger.",
    inputSchema: z.object({ partyId: z.uuid(), idempotencyKey: z.string().trim().min(1).max(180), account: partyAccountSchema }).strict(),
    invoke: (args, runtime) => addPartyAccount({ context: mcpMutationContext(runtime.principal, runtime.requestId, "Add party account"), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_update_party", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageParties },
    title: "Owner: correct or deactivate party",
    description: "Owner-only, MFA-backed correction of a party's encrypted display name or active state using exact expected values and a permanent reason. Stable IDs, document links, and history are preserved; duplicate normalized names return a warning.",
    inputSchema: updatePartySchema,
    destructive: true,
    invoke: (args, runtime) => updateParty({
      context: mutationContext(runtime.sessionPrincipal, runtime.requestId, {
        reason: args.reason,
        sourceSurface: "MCP",
      }),
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_create_gl_account", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageSegments },
    title: "Create chart-of-accounts account",
    description: "Create an idempotent natural account in one ledger with class, control kind, posting state, and validity dates. Set createDefaultCombination to create the all-null/default entity combination atomically; a combination failure rolls back the account.",
    inputSchema: createGlAccountSchema,
    idempotent: true,
    invoke: (args, runtime) => createGlAccount({
      context: mutationContext(runtime.sessionPrincipal, runtime.requestId, {
        reason: `Create GL account ${args.code}`,
        sourceSurface: "MCP",
      }),
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_update_gl_account", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageSegments },
    title: "Update or deactivate GL account",
    description: "Update display name, posting state, active state, start date, or end date using exact expected values. Earlier start dates preserve IDs; later dates return structured dependency conflicts when they would invalidate accounting history.",
    inputSchema: updateGlAccountSchema,
    destructive: true,
    invoke: (args, runtime) => updateGlAccount({
      context: mutationContext(runtime.sessionPrincipal, runtime.requestId, {
        reason: args.reason,
        sourceSurface: "MCP",
      }),
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_create_account_combination", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageSegments },
    title: "Create account combination",
    description: "Idempotently create or return a valid entity, natural-account, subaccount, department, intercompany, and custom-dimension combination. Use null for unused optional segments.",
    inputSchema: accountCombinationConfigurationSchema,
    idempotent: true,
    invoke: (args, runtime) => createAccountCombination({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_configure_segment", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageSegments },
    title: "Configure accounting segment",
    description: "Configure, activate, or deactivate an optional accounting dimension with explicit visibility and required-state policy.",
    inputSchema: segmentConfigurationSchema,
    invoke: (args, runtime) => configureSegment({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_add_segment_value", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageSegments },
    title: "Add accounting segment value",
    description: "Add a date-effective value to a configured accounting segment. The reserved null value 0000 cannot be created.",
    inputSchema: segmentValueConfigurationSchema,
    invoke: (args, runtime) => addSegmentValue({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_configure_currency", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Enable or disable organization currency",
    description: "Enable or disable a supported transaction currency for this organization. Existing accounting evidence remains unchanged.",
    inputSchema: organizationCurrencyConfigurationSchema,
    invoke: (args, runtime) => configureOrganizationCurrency({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_record_fx_rate", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Record exchange rate",
    description: "Record a positive date-time-effective organization FX rate with an explicit source. Existing journal FX snapshots are immutable.",
    inputSchema: currencyRateConfigurationSchema,
    invoke: (args, runtime) => recordCurrencyRate({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: {
      name: "finlynq_setup_configure_fx_provider_policy",
      group: "SETUP",
      access: "WRITE",
      permission: PERMISSIONS.manageOrganizationSettings,
      mfaRequirement: "REQUIRED",
    },
    title: "Configure FX provider policy",
    description: "Append a new organization FX provider-policy version. STORED_ONLY preserves database-only resolution. BANK_OF_CANADA and EUROPEAN_CENTRAL_BANK use official reference rates with bounded lookback and auditable inverse or cross calculations. YAHOO_FINANCE_EXPERIMENTAL requires explicit confirmation that the organization is licensed and authorized to use Yahoo Finance data; operator activation is independent. This tool performs no market-data request, and explicit invoice or settlement FX evidence still overrides automatic resolution.",
    inputSchema: organizationFxProviderPolicyConfigurationSchema,
    invoke: (args, runtime) => configureOrganizationFxProviderPolicy({
      principal: runtime.sessionPrincipal,
      requestId: runtime.requestId,
      sourceSurface: "MCP",
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_create_tax_registration", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Create tax registration",
    description: "Create an encrypted date-effective entity tax registration with jurisdiction and evidence. This configures tax determination; it does not file tax returns.",
    inputSchema: taxRegistrationConfigurationSchema,
    invoke: (args, runtime) => configureTaxRegistration({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_list_tax_account_mapping_versions", group: "SETUP", access: "READ", permission: PERMISSIONS.readTax },
    title: "List tax account mapping history",
    description: "Return every immutable mapping version, state, effective dates, predecessor, reason, and exact lines for an optional ledger/template scope.",
    inputSchema: z.object({ ledgerId: z.uuid().optional(), templateId: z.uuid().optional() }).strict(),
    invoke: (args, runtime) => loadTaxAccountMappingHistory(runtime.sessionPrincipal, args),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_preview_tax_account_mappings", group: "SETUP", access: "READ", permission: PERMISSIONS.manageTaxMappings },
    title: "Preview tax account mappings",
    description: "Validate exact reviewed template, mapping version, ledger, fields, and accounts without persistence.",
    inputSchema: saveTaxAccountMappingsSchema,
    invoke: (args, runtime) => previewTaxAccountMappings(runtime.sessionPrincipal, args),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_save_tax_account_mappings", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageTaxMappings },
    title: "Save tax filing account mappings",
    description: "Append an immutable client mapping version from reviewed tax-template fields to active, postable, non-control ledger accounts. Call the tax filing configuration tool first for template, ledger, field, and account IDs.",
    inputSchema: saveTaxAccountMappingsSchema,
    idempotent: true,
    invoke: (args, runtime) => saveTaxAccountMappings({
      principal: runtime.sessionPrincipal,
      requestId: runtime.requestId,
      sourceSurface: "MCP",
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_deactivate_tax_account_mappings", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageTaxMappings },
    title: "Deactivate tax account mappings prospectively",
    description: "Append an inactive version from the exact current mapping and permanent reason. Prior filings keep their captured mapping snapshot.",
    inputSchema: deactivateTaxAccountMappingsSchema,
    destructive: true,
    idempotent: true,
    invoke: (args, runtime) => deactivateTaxAccountMappings({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, sourceSurface: "MCP", ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_create_legal_entity", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Create legal entity and primary ledger",
    description: "Create a legal entity, its primary ledger, fiscal periods, and accounting-profile defaults for a specified fiscal year and functional currency.",
    inputSchema: legalEntityConfigurationSchema,
    invoke: (args, runtime) => createLegalEntity({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_list_hierarchies", group: "SETUP", access: "READ", permission: PERMISSIONS.readOrganizationSettings },
    title: "List accounting hierarchies",
    description: "Return draft and published account, segment, and entity hierarchies with revisions, effective dates, and members.",
    inputSchema: emptySchema,
    invoke: (_args, runtime) => loadAccountingHierarchies(runtime.sessionPrincipal),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_create_hierarchy", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageSegments },
    title: "Create hierarchy draft",
    description: "Create a validated accounting hierarchy draft, optionally copied from a prior hierarchy, with a bounded explicit node tree.",
    inputSchema: createAccountingHierarchySchema,
    invoke: (args, runtime) => createAccountingHierarchy({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_save_hierarchy", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageSegments },
    title: "Save hierarchy draft",
    description: "Replace one hierarchy draft's complete node tree using its exact expected revision. Published versions are not edited.",
    inputSchema: saveAccountingHierarchySchema.extend({ hierarchyId: z.uuid() }),
    invoke: (args, runtime) => saveAccountingHierarchy({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_publish_hierarchy", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageSegments },
    title: "Publish hierarchy",
    description: "Publish the exact current hierarchy revision from an effective date. This changes financial-statement presentation and requires high-assurance user authorization.",
    inputSchema: publishAccountingHierarchySchema.extend({ hierarchyId: z.uuid() }),
    invoke: (args, runtime) => publishAccountingHierarchy({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_change_posting_policy", group: "SETUP", access: "WRITE", permission: PERMISSIONS.managePostingPolicy },
    title: "Change manual posting policy",
    description: "Change a ledger between review-required and auto-post modes using optimistic version control and a permanent reason.",
    inputSchema: postingPolicyChangeSchema,
    invoke: (args, runtime) => changeLedgerPostingPolicy({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_create_fiscal_periods", group: "SETUP", access: "WRITE", permission: PERMISSIONS.createPeriod },
    title: "Create monthly fiscal periods",
    description: "Create the twelve calendar-month fiscal periods for an existing ledger and fiscal year. Exact existing periods are preserved, while overlaps or incompatible definitions reject the atomic batch.",
    inputSchema: fiscalPeriodCreationSchema,
    idempotent: true,
    invoke: (args, runtime) => createFiscalPeriods({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, sourceSurface: "MCP", ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_get_period_controls", group: "SETUP", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Get fiscal period controls",
    description: "Return fiscal periods, current state and version, unposted journal counts, and the connected user's close/reopen/seal capabilities.",
    inputSchema: emptySchema,
    invoke: (_args, runtime) => loadPeriodControlWorkspace(runtime.sessionPrincipal),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_transition_period", group: "SETUP", access: "WRITE", permissionsAny: [PERMISSIONS.closePeriod, PERMISSIONS.reopenPeriod, PERMISSIONS.sealPeriod] },
    title: "Close, reopen, or seal fiscal period",
    description: "Transition a fiscal period with optimistic versioning and a permanent reason. The server selects and rechecks the exact close, reopen, or seal permission for the requested transition.",
    inputSchema: z.object({ periodId: z.uuid(), expectedVersion: z.number().int().positive(), toState: z.enum(["OPEN", "ADJUSTMENT_ONLY", "HARD_CLOSED", "SEALED"]), idempotencyKey: z.string().trim().min(1).max(180), reason: z.string().trim().min(8).max(500) }).strict(),
    destructive: true,
    invoke: (args, runtime) => {
      const possible = [PERMISSIONS.closePeriod, PERMISSIONS.reopenPeriod, PERMISSIONS.sealPeriod];
      if (!possible.some((permission) => runtime.snapshot.permissions.has(permission))) throw new Error("A fiscal-period control permission is required");
      return transitionFiscalPeriod({
        context: mutationContext(runtime.sessionPrincipal, runtime.requestId, { reason: args.reason, sourceSurface: "MCP" }),
        periodId: args.periodId,
        expectedVersion: args.expectedVersion,
        toState: args.toState,
        idempotencyKey: args.idempotencyKey,
      });
    },
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_bank_connection_handoff", group: "SETUP", access: "READ", permission: PERMISSIONS.manageBankConnections },
    title: "Open secure bank connection setup",
    description: "Return the FinLynQ settings URL where the user can enter or replace a one-time banking setup token. Banking credentials are deliberately never accepted by MCP tools.",
    inputSchema: emptySchema,
    invoke: (_args, runtime) => ({
      url: new URL("/app/banking", oauthPublicOrigin(runtime.requestUrl)).href,
      instruction: "Ask the user to open this URL and complete bank authorization directly in FinLynQ.",
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_map_bank_account", group: "SETUP", access: "WRITE", permission: PERMISSIONS.prepareBankReconciliation },
    title: "Map external bank account",
    description: "Map an observed external bank account to one active non-control asset account combination in the selected legal entity and ledger.",
    inputSchema: z.object({ externalAccountId: z.uuid(), legalEntityId: z.uuid(), ledgerId: z.uuid(), cashAccountCombinationId: z.uuid() }).strict(),
    invoke: (args, runtime) => mapBankExternalAccount({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_create_bank_rule", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageBankRules },
    title: "Create bank categorization rule",
    description: "Create an encrypted, idempotent bank rule that can only produce manual-review suggestions; it never posts or silently changes ledger data.",
    inputSchema: z.object({ name: z.string().trim().min(2).max(120), priority: z.number().int().min(0).max(100000), state: z.enum(["DRAFT", "ACTIVE"]), condition: bankRuleConditionSchema, action: bankRuleActionSchema, idempotencyKey: z.string().trim().min(1).max(180) }).strict(),
    invoke: (args, runtime) => createBankRule({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_change_bank_rule_state", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageBankRules },
    title: "Activate or deactivate bank rule",
    description: "Create a new immutable active or inactive version of an existing bank rule using an idempotency key.",
    inputSchema: z.object({ ruleId: z.uuid(), state: z.enum(["ACTIVE", "INACTIVE"]), idempotencyKey: z.string().trim().min(1).max(180) }).strict(),
    destructive: true,
    invoke: (args, runtime) => versionBankRuleState({ principal: runtime.sessionPrincipal, requestId: runtime.requestId, ...args }),
  }),
];
