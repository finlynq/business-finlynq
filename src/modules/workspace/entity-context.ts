import "server-only";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import { demoAccountingDate } from "@/modules/demo/accounting-clock";
import {
  transactionAuthMethod,
  type SessionPrincipal,
} from "@/modules/identity/session";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";

export type WorkspaceEntityOption = Readonly<{
  id: string;
  code: string;
  displayName: string;
  functionalCurrency: string;
  periodLabel: string | null;
  periodState: string | null;
}>;

/**
 * A request-scoped display preference. It is deliberately not an authorization
 * or accounting scope: every loader and mutation must continue to validate its
 * own entity identifiers against the authenticated organization.
 */
export type WorkspaceEntityContext = Readonly<{
  options: readonly WorkspaceEntityOption[];
  selectedEntity: WorkspaceEntityOption | null;
}>;

function readContext(principal: SessionPrincipal): TenantTransactionContext {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `entity-context:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI",
  };
}

async function assertActiveMembership(
  client: PoolClient,
  principal: SessionPrincipal,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
       FROM organization_memberships membership
       JOIN organizations organization
         ON organization.id = membership.organization_id
        AND organization.active
      WHERE membership.organization_id = $1
        AND membership.id = $2
        AND membership.user_id = $3
        AND membership.active`,
    [principal.organizationId, principal.membershipId, principal.userId],
  );
  if (!result.rows[0]) {
    throw new Error("The session no longer has an active organization membership");
  }
}

export async function loadWorkspaceEntityOptions(
  principal: SessionPrincipal,
): Promise<readonly WorkspaceEntityOption[]> {
  return withWorkspaceTenantRead(readContext(principal), "/app", async (client) => {
    await assertActiveMembership(client, principal);
    const asOfDate = principal.sessionMode === "demo"
      ? demoAccountingDate()
      : new Date().toISOString().slice(0, 10);
    const result = await client.query<{
      id: string;
      code: string;
      display_name: string;
      functional_currency: string;
      period_label: string | null;
      period_state: string | null;
    }>(
      `SELECT entity.id, entity.code, entity.display_name,
          ledger.functional_currency,
          current_period.label AS period_label,
          current_period.state::text AS period_state
         FROM legal_entities entity
         JOIN organizations organization
           ON organization.id = entity.organization_id
          AND organization.active
         JOIN ledgers ledger
           ON ledger.organization_id = entity.organization_id
          AND ledger.legal_entity_id = entity.id
          AND ledger.kind = 'PRIMARY'
          AND ledger.active
         LEFT JOIN LATERAL (
           SELECT period.label, period.state
             FROM fiscal_periods period
            WHERE period.organization_id = entity.organization_id
              AND period.ledger_id = ledger.id
            ORDER BY ($2::date BETWEEN period.starts_on AND period.ends_on) DESC,
              period.starts_on DESC
            LIMIT 1
         ) current_period ON true
        WHERE entity.organization_id = $1
          AND entity.active
        ORDER BY entity.code`,
      [principal.organizationId, asOfDate],
    );
    return result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      displayName: row.display_name,
      functionalCurrency: row.functional_currency,
      periodLabel: row.period_label,
      periodState: row.period_state,
    }));
  });
}

export function selectWorkspaceEntity(
  options: readonly WorkspaceEntityOption[],
  preferredEntityId: string | null | undefined,
): WorkspaceEntityOption | null {
  return options.find((entity) => entity.id === preferredEntityId) ?? options[0] ?? null;
}

export async function loadWorkspaceEntityContext(
  principal: SessionPrincipal,
  preferredEntityId: string | null | undefined,
): Promise<WorkspaceEntityContext> {
  const options = await loadWorkspaceEntityOptions(principal);
  return {
    options,
    selectedEntity: selectWorkspaceEntity(options, preferredEntityId),
  };
}

export async function currentWorkspaceEntityContext(
  principal: SessionPrincipal,
): Promise<WorkspaceEntityContext> {
  const cookieStore = await cookies();
  return loadWorkspaceEntityContext(
    principal,
    cookieStore.get(workspaceEntityContextCookieName())?.value,
  );
}

export async function validateWorkspaceEntitySelection(
  principal: SessionPrincipal,
  entityId: string,
): Promise<WorkspaceEntityOption | null> {
  const options = await loadWorkspaceEntityOptions(principal);
  return options.find((entity) => entity.id === entityId) ?? null;
}

export function workspaceEntityContextCookieName(): string {
  return process.env.WORKSPACE_ENTITY_COOKIE_NAME?.trim() ||
    (process.env.NODE_ENV === "production"
      ? "__Host-business_finlynq_entity"
      : "business_finlynq_entity");
}

export function setWorkspaceEntityContextCookie(
  response: NextResponse,
  entityId: string,
): void {
  response.cookies.set(workspaceEntityContextCookieName(), entityId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 31_536_000,
    priority: "medium",
  });
}
