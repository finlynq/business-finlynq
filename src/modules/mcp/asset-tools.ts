import "server-only";

import { z } from "zod";
import {
  assetAdjustmentSchema,
  createAssetCategorySchema,
  createAssetRecordSchema,
} from "@/modules/assets/model";
import {
  createAssetCategory,
  createAssetRecord,
  generateAssetScheduleJournal,
  loadAssetWorkspace,
  recordAssetAdjustment,
} from "@/modules/assets/service";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { mcpMutationContext } from "./oauth-store";
import { defineMcpTool, type McpToolDefinition } from "./tool-types";

export const ASSET_MCP_TOOLS: readonly McpToolDefinition[] = [
  defineMcpTool({
    policy: { name: "finlynq_daily_asset_register", group: "DAILY", access: "READ", permission: PERMISSIONS.readMcpLedger },
    title: "Read asset and prepaid registers",
    description: "Return tangible assets, intangible assets, prepaids, deterministic schedules, due/posted state, category mappings, and register-to-GL roll-forward balances for the connected organization.",
    inputSchema: z.object({}).strict(),
    invoke: (_args, runtime) => loadAssetWorkspace(runtime.sessionPrincipal),
  }),
  defineMcpTool({
    policy: { name: "finlynq_setup_create_asset_category", group: "SETUP", access: "WRITE", permission: PERMISSIONS.manageOrganizationSettings },
    title: "Create an asset or prepaid category",
    description: "Create an organization-scoped tangible, intangible, or prepaid category with validated cost, contra, expense, impairment, and disposal account mappings. This changes configuration and never posts a journal.",
    inputSchema: createAssetCategorySchema,
    idempotent: true,
    invoke: (args, runtime) => createAssetCategory({
      context: mcpMutationContext(runtime.principal, runtime.requestId, `Create asset category ${args.code}`),
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
