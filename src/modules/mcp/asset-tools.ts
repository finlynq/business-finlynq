import "server-only";

import { z } from "zod";
import {
  assetAdjustmentSchema,
  createAssetCategorySchema,
  createAssetRecordSchema,
  deactivateAssetCategorySchema,
  reviseAssetCategorySchema,
} from "@/modules/assets/model";
import {
  createAssetCategory,
  createAssetRecord,
  deactivateAssetCategory,
  generateAssetScheduleJournal,
  listAssetCategoryVersions,
  loadAssetWorkspace,
  previewAssetCategory,
  recordAssetAdjustment,
  reviseAssetCategory,
} from "@/modules/assets/service";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  attachAssetTaxAdjustment,
  attachAssetTaxAdjustmentSchema,
  createAssetTaxSchedule,
  createAssetTaxScheduleSchema,
  loadAssetTaxWorkspace,
  previewAssetTaxSchedule,
  proposeAssetTaxClassification,
  proposeAssetTaxClassificationSchema,
  saveAssetTaxClassification,
  saveAssetTaxClassificationSchema,
} from "@/modules/assets/tax-depreciation-service";
import { mcpMutationContext } from "./oauth-store";
import { defineMcpTool, type McpToolDefinition } from "./tool-types";

export const ASSET_MCP_TOOLS: readonly McpToolDefinition[] = [
  defineMcpTool({
    policy: { name: "finlynq_daily_asset_tax_workspace", group: "DAILY", access: "READ", permission: PERMISSIONS.readTax },
    title: "Read asset tax classifications and CCA schedules",
    description: "List assets needing tax classification, reviewed immutable classifications, effective-dated Canadian CCA rules, tax schedules, book-to-tax adjustments, and filing links. Book schedules remain separate.",
    inputSchema: z.object({}).strict(),
    invoke: (_args, runtime) => loadAssetTaxWorkspace(mcpMutationContext(runtime.principal, runtime.requestId, "Read asset tax workspace")),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_propose_asset_tax_classification", group: "DAILY", access: "READ", permission: PERMISSIONS.readTax },
    title: "Propose a reviewed CCA class candidate",
    description: "Return effective-dated rule candidates from explicit property facts, source citations, authority status, and review-required confidence. Merchant text and book useful life are never used as tax classification.",
    inputSchema: proposeAssetTaxClassificationSchema,
    invoke: (args, runtime) => proposeAssetTaxClassification({ context: mcpMutationContext(runtime.principal, runtime.requestId, "Propose asset tax classification"), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_save_asset_tax_classification", group: "DAILY", access: "WRITE", permission: PERMISSIONS.manageTaxMappings },
    title: "Save reviewed asset tax classification",
    description: "Append an authorized effective-dated CCA classification version with exact capital cost, business use, assistance, rule version, citation, and permanent reason. Book depreciation is unchanged.",
    inputSchema: saveAssetTaxClassificationSchema,
    idempotent: true,
    invoke: (args, runtime) => saveAssetTaxClassification({ context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_preview_asset_tax_schedule", group: "DAILY", access: "READ", permission: PERMISSIONS.readTax },
    title: "Preview Canadian CCA schedule",
    description: "Calculate maximum and optional claimed CCA, UCC continuity, first-year adjustment, recapture, and terminal loss without writing.",
    inputSchema: createAssetTaxScheduleSchema,
    invoke: (args, runtime) => previewAssetTaxSchedule({ context: mcpMutationContext(runtime.principal, runtime.requestId, "Preview CCA schedule"), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_create_asset_tax_schedule", group: "DAILY", access: "WRITE", permission: PERMISSIONS.manageTaxMappings },
    title: "Create or recalculate Canadian CCA schedule",
    description: "Append an idempotent immutable CCA schedule version under an enacted reviewed classification. A reduced claim never changes the independently calculated maximum.",
    inputSchema: createAssetTaxScheduleSchema,
    idempotent: true,
    invoke: (args, runtime) => createAssetTaxSchedule({ context: mcpMutationContext(runtime.principal, runtime.requestId, "Create CCA schedule"), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_attach_asset_tax_adjustment", group: "DAILY", access: "WRITE", permission: PERMISSIONS.prepareTaxFilings },
    title: "Attach reviewed book-to-tax asset adjustment",
    description: "Attach an immutable reviewed CCA/book-depreciation difference to an exact PREPARED or HISTORICAL_IMPORT workpaper. This never submits a return or initiates payment.",
    inputSchema: attachAssetTaxAdjustmentSchema,
    idempotent: true,
    invoke: (args, runtime) => attachAssetTaxAdjustment({ context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason), ...args }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_asset_register", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Read asset and prepaid registers",
    description: "Return tangible assets, intangible assets, prepaids, deterministic schedules, due/posted state, category mappings, and register-to-GL roll-forward balances for the connected organization.",
    inputSchema: z.object({}).strict(),
    invoke: (_args, runtime) => loadAssetWorkspace(runtime.sessionPrincipal),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_list_asset_category_versions", group: "SETUP", access: "READ", permission: PERMISSIONS.manageOrganizationSettings },
    title: "List asset category version history",
    description: "Return current and historical immutable category versions by stable category key, ledger, or code, including effective dates, account mappings, dependency counts, and change reasons. No configuration is changed.",
    inputSchema: z.object({
      categoryKey: z.uuid().optional(),
      ledgerId: z.uuid().optional(),
      code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/).optional(),
    }).strict(),
    invoke: (args, runtime) => listAssetCategoryVersions(runtime.sessionPrincipal, args),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_preview_asset_category", group: "SETUP", access: "READ", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Preview asset category configuration",
    description: "Validate exact tenant-owned ledger/account mappings and show any current category version without writing configuration.",
    inputSchema: createAssetCategorySchema,
    invoke: (args, runtime) => previewAssetCategory({
      context: mcpMutationContext(runtime.principal, runtime.requestId, `Preview asset category ${args.code}`),
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_create_asset_category", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Create an asset or prepaid category",
    description: "Create an idempotent organization-scoped category with validated mappings, an effective date, and permanent reason. An identical existing code is returned; different semantics require an immutable revision. This never posts a journal.",
    inputSchema: createAssetCategorySchema,
    idempotent: true,
    invoke: (args, runtime) => createAssetCategory({
      context: mcpMutationContext(runtime.principal, runtime.requestId, `Create asset category ${args.code}`),
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_revise_asset_category", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Revise an asset category",
    description: "Append an immutable active category version using the exact current version, including controlled reactivation of an inactive lineage. Existing assets retain their captured category version and posted history.",
    inputSchema: reviseAssetCategorySchema,
    idempotent: true,
    invoke: (args, runtime) => reviseAssetCategory({
      context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason),
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_deactivate_asset_category", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Deactivate an asset category prospectively",
    description: "Append an inactive category version after reporting dependent asset and schedule counts. New assets are blocked while existing schedules and journals remain intact.",
    inputSchema: deactivateAssetCategorySchema,
    destructive: true,
    idempotent: true,
    invoke: (args, runtime) => deactivateAssetCategory({
      context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason),
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_create_asset_record", group: "DAILY", access: "WRITE", permission: PERMISSIONS.draftJournal },
    title: "Create an asset or prepaid register record",
    description: "Create an idempotent tangible asset, finite/indefinite-life intangible, or prepaid record and its deterministic monthly schedule. Prepaids use daily partial-period allocation; every finite schedule puts rounding into the final period. No journal is posted.",
    inputSchema: createAssetRecordSchema,
    idempotent: true,
    invoke: (args, runtime) => createAssetRecord({
      context: mcpMutationContext(runtime.principal, runtime.requestId, `Create asset ${args.assetNumber}`),
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_generate_asset_schedule_journal", group: "DAILY", access: "WRITE", permission: PERMISSIONS.draftJournal },
    title: "Generate an asset schedule journal draft",
    description: "Generate one balanced, idempotent depreciation, amortization, or prepaid-recognition journal draft for an eligible schedule entry in an open period. It remains subject to normal review and posting controls.",
    inputSchema: z.object({ scheduleEntryId: z.uuid(), idempotencyKey: z.string().trim().min(1).max(180) }).strict(),
    idempotent: true,
    invoke: (args, runtime) => generateAssetScheduleJournal({
      context: mcpMutationContext(runtime.principal, runtime.requestId, "Generate asset schedule journal"),
      ...args,
    }),
  }),
  defineMcpTool({
    policy: { name: "finlynq_daily_record_asset_lifecycle", group: "DAILY", access: "WRITE", permission: PERMISSIONS.draftJournal },
    title: "Record an asset lifecycle event",
    description: "Append an immutable impairment, transfer, disposal, retirement, termination, adjustment, or reversal event. Terminal events preserve prior schedules and mark unprocessed periods skipped; posted history is never edited.",
    inputSchema: assetAdjustmentSchema,
    idempotent: true,
    invoke: (args, runtime) => recordAssetAdjustment({
      context: mcpMutationContext(runtime.principal, runtime.requestId, args.reason),
      ...args,
    }),
  }),
];
