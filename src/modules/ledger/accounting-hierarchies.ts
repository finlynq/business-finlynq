import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import {
  actorHasActivePermission,
  assertActorHasActivePermission,
} from "@/modules/identity/authorization";
import { OrganizationAdministrationError } from "@/modules/identity/organization-administration";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { hasRecentStepUp, transactionAuthMethod, type SessionPrincipal } from "@/modules/identity/session";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
  mutationContext,
} from "@/modules/workspace/write-policy";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import {
  accountingHierarchyDimensionKeys,
  financialStatementClasses,
  type AccountingHierarchyDto,
  type AccountingHierarchyNodeDto,
} from "./accounting-hierarchy-contract";

const dimensionKeySchema = z.enum(accountingHierarchyDimensionKeys);
const statementClassSchema = z.enum(financialStatementClasses);
const hierarchyCodeSchema = z.string().trim().toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/);

export const accountingHierarchyNodeInputSchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  code: hierarchyCodeSchema,
  displayName: z.string().trim().min(2).max(160),
  sortOrder: z.number().int().min(0).max(1_000_000),
  statementClass: statementClassSchema.nullable(),
  memberType: z.enum(["ACCOUNT", "SEGMENT_VALUE", "ENTITY"]).nullable(),
  memberId: z.uuid().nullable(),
}).strict().superRefine((node, context) => {
  if ((node.memberType === null) !== (node.memberId === null)) {
    context.addIssue({
      code: "custom",
      message: "A hierarchy member type and member ID must be supplied together",
      path: ["memberId"],
    });
  }
  if (node.memberType !== null && node.statementClass !== null) {
    context.addIssue({
      code: "custom",
      message: "Only hierarchy groups can define a financial statement class",
      path: ["statementClass"],
    });
  }
});

const hierarchyNodesSchema = z.array(accountingHierarchyNodeInputSchema).max(5_000);
const reasonSchema = z.string().trim().min(8).max(500);

export const createAccountingHierarchySchema = z.object({
  dimensionKey: dimensionKeySchema,
  ledgerId: z.uuid().nullable().optional().transform((value) => value ?? null),
  code: hierarchyCodeSchema,
  displayName: z.string().trim().min(2).max(160),
  basedOnHierarchyId: z.uuid().nullable().optional().transform((value) => value ?? null),
  nodes: hierarchyNodesSchema,
  reason: reasonSchema,
}).strict().superRefine((value, context) => {
  if ((value.dimensionKey === "account") !== (value.ledgerId !== null)) {
    context.addIssue({
      code: "custom",
      message: value.dimensionKey === "account"
        ? "A natural-account hierarchy requires a ledger"
        : "Only natural-account hierarchies can be ledger-specific",
      path: ["ledgerId"],
    });
  }
});

export const saveAccountingHierarchySchema = z.object({
  expectedRevision: z.number().int().positive(),
  nodes: hierarchyNodesSchema,
  reason: reasonSchema,
}).strict();

export const publishAccountingHierarchySchema = z.object({
  expectedRevision: z.number().int().positive(),
  effectiveFrom: z.iso.date(),
  reason: reasonSchema,
}).strict();

function readContext(principal: SessionPrincipal): TenantTransactionContext {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    requestId: `accounting-hierarchy-read:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI",
    sessionMode: principal.sessionMode,
  };
}

export async function loadAccountingHierarchies(
  principal: SessionPrincipal,
): Promise<readonly AccountingHierarchyDto[]> {
  return withWorkspaceTenantRead(readContext(principal), "/app/settings/accounting", async (client) => {
    const canReadHierarchyMetadata = (await Promise.all([
      PERMISSIONS.readMcpLedger,
      PERMISSIONS.readOrganizationSettings,
      PERMISSIONS.manageOrganizationSettings,
      PERMISSIONS.manageSegments,
    ].map((permission) => actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission,
    })))).some(Boolean);
    if (!canReadHierarchyMetadata) {
      throw new Error("Accounting hierarchy metadata permission is required");
    }
    const [hierarchyResult, nodeResult] = await Promise.all([
      client.query<{
        id: string;
        dimension_key: AccountingHierarchyDto["dimensionKey"];
        ledger_id: string | null;
        code: string;
        display_name: string;
        version: number;
        revision: number;
        status: AccountingHierarchyDto["status"];
        based_on_hierarchy_id: string | null;
        effective_from: string | null;
        created_at: string;
        published_at: string | null;
      }>(
        `SELECT hierarchy.id, hierarchy.dimension_key, hierarchy.ledger_id,
           hierarchy.code, hierarchy.display_name, hierarchy.version,
           hierarchy.revision, hierarchy.status, hierarchy.based_on_hierarchy_id,
           hierarchy.effective_from::text, hierarchy.created_at::text,
           hierarchy.published_at::text
         FROM accounting_hierarchies hierarchy
         WHERE hierarchy.organization_id = $1
         ORDER BY hierarchy.dimension_key, hierarchy.code,
           hierarchy.version DESC, hierarchy.id`,
        [principal.organizationId],
      ),
      client.query<{
        id: string;
        hierarchy_id: string;
        parent_id: string | null;
        code: string;
        display_name: string;
        sort_order: number;
        statement_class: AccountingHierarchyNodeDto["statementClass"];
        member_type: AccountingHierarchyNodeDto["memberType"];
        member_id: string | null;
      }>(
        `SELECT node.id, node.hierarchy_id, node.parent_id, node.code,
           node.display_name, node.sort_order, node.statement_class,
           node.member_type,
           coalesce(node.gl_account_id, node.segment_value_id, node.legal_entity_id) AS member_id
         FROM accounting_hierarchy_nodes node
         WHERE node.organization_id = $1
         ORDER BY node.hierarchy_id, node.sort_order, node.code, node.id`,
        [principal.organizationId],
      ),
    ]);
    return hierarchyResult.rows.map((hierarchy) => ({
      id: hierarchy.id,
      dimensionKey: hierarchy.dimension_key,
      ledgerId: hierarchy.ledger_id,
      code: hierarchy.code,
      displayName: hierarchy.display_name,
      version: hierarchy.version,
      revision: hierarchy.revision,
      status: hierarchy.status,
      basedOnHierarchyId: hierarchy.based_on_hierarchy_id,
      effectiveFrom: hierarchy.effective_from,
      createdAt: hierarchy.created_at,
      publishedAt: hierarchy.published_at,
      nodes: nodeResult.rows
        .filter((node) => node.hierarchy_id === hierarchy.id)
        .map((node) => ({
          id: node.id,
          parentId: node.parent_id,
          code: node.code,
          displayName: node.display_name,
          sortOrder: node.sort_order,
          statementClass: node.statement_class,
          memberType: node.member_type,
          memberId: node.member_id,
        })),
    }));
  });
}

function hierarchyNodesJson(nodes: readonly z.output<typeof accountingHierarchyNodeInputSchema>[]) {
  return nodes.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    code: node.code,
    displayName: node.displayName,
    sortOrder: node.sortOrder,
    statementClass: node.statementClass,
    memberType: node.memberType,
    glAccountId: node.memberType === "ACCOUNT" ? node.memberId : null,
    segmentValueId: node.memberType === "SEGMENT_VALUE" ? node.memberId : null,
    legalEntityId: node.memberType === "ENTITY" ? node.memberId : null,
  }));
}

async function hierarchyMutation<T>(
  principal: SessionPrincipal,
  requestId: string,
  reason: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const context = mutationContext(principal, requestId, { reason, sourceSurface: "API" });
  assertTenantWritesEnabled(context);
  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    await assertActorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.manageSegments,
    });
    return work(client);
  });
}

export async function createAccountingHierarchy(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
}> & z.output<typeof createAccountingHierarchySchema>) {
  return hierarchyMutation(input.principal, input.requestId, input.reason, async (client) => {
    const created = await client.query<{ id: string; version: number; revision: number }>(
      `SELECT * FROM app.accounting_create_hierarchy_draft($1,$2,$3,$4,$5)`,
      [
        input.dimensionKey,
        input.ledgerId,
        input.code,
        input.displayName,
        input.basedOnHierarchyId,
      ],
    );
    const hierarchy = created.rows[0];
    if (!hierarchy) throw new Error("Hierarchy draft was not created");
    if (input.nodes.length > 0) {
      const saved = await client.query<{ revision: number }>(
        `SELECT app.accounting_replace_hierarchy_draft($1,$2,$3::jsonb) AS revision`,
        [hierarchy.id, hierarchy.revision, JSON.stringify(hierarchyNodesJson(input.nodes))],
      );
      hierarchy.revision = saved.rows[0]?.revision ?? hierarchy.revision;
    }
    return hierarchy;
  });
}

export async function saveAccountingHierarchy(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  hierarchyId: string;
}> & z.output<typeof saveAccountingHierarchySchema>) {
  return hierarchyMutation(input.principal, input.requestId, input.reason, async (client) => {
    const result = await client.query<{ revision: number }>(
      `SELECT app.accounting_replace_hierarchy_draft($1,$2,$3::jsonb) AS revision`,
      [input.hierarchyId, input.expectedRevision, JSON.stringify(hierarchyNodesJson(input.nodes))],
    );
    return { revision: result.rows[0]?.revision ?? input.expectedRevision };
  });
}

export async function publishAccountingHierarchy(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  hierarchyId: string;
}> & z.output<typeof publishAccountingHierarchySchema>) {
  if (input.principal.sessionMode === "real" && !hasRecentStepUp(input.principal)) {
    throw new OrganizationAdministrationError(
      "Verify your authenticator code before publishing an accounting hierarchy.",
      428,
      "MFA_STEP_UP_REQUIRED",
    );
  }
  return hierarchyMutation(input.principal, input.requestId, input.reason, async (client) => {
    const result = await client.query<{ version: number; effective_from: string }>(
      `SELECT * FROM app.accounting_publish_hierarchy($1,$2,$3)`,
      [input.hierarchyId, input.expectedRevision, input.effectiveFrom],
    );
    const published = result.rows[0];
    if (!published) throw new Error("Hierarchy was not published");
    return { version: published.version, effectiveFrom: published.effective_from };
  });
}
