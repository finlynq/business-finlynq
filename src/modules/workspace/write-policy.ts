import "server-only";

import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import {
  transactionAuthMethod,
  type SessionPrincipal,
} from "@/modules/identity/session";
import { isDemoTransactionAuthMethod } from "@/modules/identity/auth-provenance";

export function demoWritesEnabled(): boolean {
  return process.env.DEMO_WRITES_ENABLED === "true";
}

export function realBusinessWritesEnabled(): boolean {
  return process.env.BUSINESS_WRITES_ENABLED === "true";
}

export function principalCanWrite(principal: SessionPrincipal): boolean {
  if (principal.sessionMode === "demo") {
    return demoWritesEnabled();
  }
  return realBusinessWritesEnabled();
}

export function mutationContext(
  principal: SessionPrincipal,
  requestId: string,
  options: Readonly<{ reason?: string; sourceSurface?: "UI" | "API" | "IMPORT" | "WORKER" | "MCP" }> = {},
): TenantTransactionContext {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: options.sourceSurface ?? "UI",
    reason: options.reason,
    ...(principal.sessionMode === "demo" ? { demoWriteAuthorized: true } : {}),
  };
}

export function isAuthorizedDemoWriteContext(context: TenantTransactionContext): boolean {
  const sessionMode = context.sessionMode ??
    (isDemoTransactionAuthMethod(context.authMethod) ? "demo" : "real");
  return sessionMode === "demo" && context.demoWriteAuthorized === true &&
    Boolean(context.sessionId) &&
    isDemoTransactionAuthMethod(context.authMethod) &&
    demoWritesEnabled();
}

export function assertTenantWritesEnabled(context: TenantTransactionContext): void {
  const sessionMode = context.sessionMode ??
    (isDemoTransactionAuthMethod(context.authMethod) ? "demo" : "real");
  if (sessionMode === "demo") {
    if (!isAuthorizedDemoWriteContext(context)) {
      throw new Error("Demo writes require a live isolated demo-link session");
    }
    return;
  }
  if (context.demoWriteAuthorized) {
    throw new Error("Demo-write authorization cannot be used by a real session");
  }
  if (!realBusinessWritesEnabled()) throw new Error("Business writes are disabled");
}

export async function assertWritableOrganization(
  client: PoolClient,
  context: TenantTransactionContext,
): Promise<Readonly<{ isDemo: boolean }>> {
  const result = await client.query<{ active: boolean; is_demo: boolean; organization_mode: string }>(
    "SELECT active, is_demo, organization_mode FROM organizations WHERE id = $1",
    [context.organizationId],
  );
  const organization = result.rows[0];
  if (!organization?.active) throw new Error("Accounting writes require an active organization");
  const authorizedDemo = isAuthorizedDemoWriteContext(context);
  if (organization.is_demo !== authorizedDemo ||
      (authorizedDemo && organization.organization_mode !== "SANDBOX") ||
      (!authorizedDemo && organization.organization_mode !== "REAL")) {
    throw new Error("The write context does not match the organization mode");
  }
  return { isDemo: organization.is_demo };
}
