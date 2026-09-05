import "server-only";

import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { OrganizationAdministrationError } from "@/modules/identity/organization-administration";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { hasRecentStepUp, type SessionPrincipal } from "@/modules/identity/session";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
  demoWritesEnabled,
  mutationContext,
} from "@/modules/workspace/write-policy";

export const fxProviderModes = [
  "STORED_ONLY",
  "YAHOO_FINANCE_EXPERIMENTAL",
] as const;

export type FxProviderMode = (typeof fxProviderModes)[number];

export const organizationFxProviderPolicyConfigurationSchema = z.object({
  expectedVersion: z.number().int().min(0),
  providerMode: z.enum(fxProviderModes),
  maxLookbackDays: z.number().int().min(1).max(7),
  licensedAndAuthorizedUseAcknowledged: z.boolean(),
  reason: z.string().trim().min(8).max(500),
}).strict().superRefine((value, context) => {
  const acknowledgementRequired = value.providerMode === "YAHOO_FINANCE_EXPERIMENTAL";
  if (value.licensedAndAuthorizedUseAcknowledged !== acknowledgementRequired) {
    context.addIssue({
      code: "custom",
      path: ["licensedAndAuthorizedUseAcknowledged"],
      message: acknowledgementRequired
        ? "Confirm that the organization is licensed and authorized to use Yahoo Finance data"
        : "Stored-only policy must not carry a Yahoo Finance authorization acknowledgement",
    });
  }
});

export type OrganizationFxProviderPolicy = Readonly<{
  id: string | null;
  version: number;
  providerMode: FxProviderMode;
  maxLookbackDays: number;
  licensedAndAuthorizedUseAcknowledged: boolean;
  configuredAt: string | null;
}>;

export const DEFAULT_ORGANIZATION_FX_PROVIDER_POLICY: OrganizationFxProviderPolicy = Object.freeze({
  id: null,
  version: 0,
  providerMode: "STORED_ONLY",
  maxLookbackDays: 7,
  licensedAndAuthorizedUseAcknowledged: false,
  configuredAt: null,
});

type PolicyRow = Readonly<{
  id: string;
  version: number;
  provider_mode: FxProviderMode;
  max_lookback_days: number;
  licensed_and_authorized_use_acknowledged: boolean;
  configured_at: string;
}>;

function mapPolicyRow(row: PolicyRow): OrganizationFxProviderPolicy {
  return {
    id: row.id,
    version: row.version,
    providerMode: row.provider_mode,
    maxLookbackDays: row.max_lookback_days,
    licensedAndAuthorizedUseAcknowledged: row.licensed_and_authorized_use_acknowledged,
    configuredAt: row.configured_at,
  };
}

export async function readOrganizationFxProviderPolicy(
  client: PoolClient,
  organizationId: string,
): Promise<OrganizationFxProviderPolicy> {
  const result = await client.query<PolicyRow>(
    `SELECT id, version, provider_mode, max_lookback_days,
       licensed_and_authorized_use_acknowledged, created_at::text AS configured_at
     FROM organization_fx_provider_policy_versions
     WHERE organization_id = $1
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    [organizationId],
  );
  return result.rows[0] ? mapPolicyRow(result.rows[0]) : DEFAULT_ORGANIZATION_FX_PROVIDER_POLICY;
}

function assertPolicyMutationSession(principal: SessionPrincipal): void {
  if (principal.sessionMode === "demo") {
    if (!demoWritesEnabled()) {
      throw new OrganizationAdministrationError(
        "Demo changes are not available on this deployment.",
        403,
        "DEMO_WRITES_DISABLED",
      );
    }
    return;
  }
  if (!hasRecentStepUp(principal)) {
    throw new OrganizationAdministrationError(
      "Verify your authenticator code before changing the FX provider policy.",
      428,
      "MFA_STEP_UP_REQUIRED",
    );
  }
}

export async function configureOrganizationFxProviderPolicy(input: Readonly<{
  principal: SessionPrincipal;
  requestId: string;
  sourceSurface?: "API" | "MCP";
}> & z.output<typeof organizationFxProviderPolicyConfigurationSchema>): Promise<OrganizationFxProviderPolicy> {
  assertPolicyMutationSession(input.principal);
  const context = mutationContext(input.principal, input.requestId, {
    reason: input.reason,
    sourceSurface: input.sourceSurface ?? "API",
  });
  assertTenantWritesEnabled(context);

  return withTenantTransaction(context, async (client) => {
    await assertWritableOrganization(client, context);
    await assertActorHasActivePermission(client, {
      organizationId: input.principal.organizationId,
      actorId: input.principal.userId,
      permission: PERMISSIONS.manageOrganizationSettings,
    });
    const result = await client.query<PolicyRow>(
      `SELECT policy_id AS id, policy_version AS version,
         selected_provider_mode AS provider_mode,
         selected_max_lookback_days AS max_lookback_days,
         selected_licensed_acknowledgement AS licensed_and_authorized_use_acknowledged,
         selected_configured_at::text AS configured_at
       FROM app.accounting_set_fx_provider_policy($1,$2,$3,$4)`,
      [
        input.expectedVersion,
        input.providerMode,
        input.maxLookbackDays,
        input.licensedAndAuthorizedUseAcknowledged,
      ],
    );
    const policy = result.rows[0];
    if (!policy) throw new Error("FX provider policy was not configured");
    return mapPolicyRow(policy);
  });
}
