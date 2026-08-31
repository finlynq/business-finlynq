import type { PoolClient } from "pg";
import { z } from "zod";

const organizationIdSchema = z.uuid().transform((value) => value.toLowerCase());
const requestIdSchema = z.uuid();
const operatorIdSchema = z.string().trim().min(3).max(100)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/i);
const reasonSchema = z.string().trim().min(10).max(500)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Reason must be a single line")
  .refine(
    (value) => !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value),
    "Reason must not contain an email address",
  );

const mutationSchema = z.object({
  organizationId: organizationIdSchema,
  enabled: z.boolean(),
  operatorId: operatorIdSchema,
  reason: reasonSchema,
  requestId: requestIdSchema,
});

type OrganizationWriteRow = Readonly<{
  organization_id: string;
  active: boolean;
  organization_mode: string;
  writes_enabled_at: Date | string | null;
}>;

type OrganizationWriteMutationRow = OrganizationWriteRow & Readonly<{
  changed: boolean;
}>;

export type OrganizationWriteStatus = Readonly<{
  organizationId: string;
  active: boolean;
  organizationMode: string;
  writesEnabledAt: Date | null;
}>;

export type OrganizationWriteMutationResult = OrganizationWriteStatus & Readonly<{
  enabled: boolean;
  changed: boolean;
}>;

function timestamp(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Organization write state returned an invalid timestamp");
  return parsed;
}

function statusFromRow(row: OrganizationWriteRow, expectedOrganizationId: string): OrganizationWriteStatus {
  if (row.organization_id !== expectedOrganizationId) {
    throw new Error("Organization write state returned an invalid organization binding");
  }
  return {
    organizationId: row.organization_id,
    active: row.active,
    organizationMode: row.organization_mode,
    writesEnabledAt: timestamp(row.writes_enabled_at),
  };
}

/**
 * Read activation metadata through an owner connection. The application role
 * must never receive permission to call this operator boundary directly.
 */
export async function inspectOrganizationWriteStatus(
  client: PoolClient,
  untrustedOrganizationId: string,
): Promise<OrganizationWriteStatus> {
  const organizationId = organizationIdSchema.parse(untrustedOrganizationId);
  const result = await client.query<OrganizationWriteRow>(
    `SELECT id AS organization_id,active,organization_mode,writes_enabled_at
     FROM organizations
     WHERE id=$1`,
    [organizationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Organization write state is unavailable");
  return statusFromRow(row, organizationId);
}

/**
 * Change one real organization's write state through the audited owner-only
 * database function. The function owns authorization, locking, and audit
 * insertion; this adapter validates its binding and fail-closed result.
 */
export async function setOrganizationWrites(
  client: PoolClient,
  untrustedInput: z.input<typeof mutationSchema>,
): Promise<OrganizationWriteMutationResult> {
  const input = mutationSchema.parse(untrustedInput);
  const result = await client.query<OrganizationWriteMutationRow>(
    `SELECT organization_id,active,organization_mode,writes_enabled_at,changed
     FROM app.operator_set_organization_writes($1,$2,$3,$4,$5)`,
    [input.organizationId, input.enabled, input.operatorId, input.reason, input.requestId],
  );
  const row = result.rows[0];
  if (!row || typeof row.changed !== "boolean") {
    throw new Error("Organization write mutation returned an invalid result");
  }
  const status = statusFromRow(row, input.organizationId);
  const enabled = status.writesEnabledAt !== null;
  if (enabled !== input.enabled || (enabled && (!status.active || status.organizationMode !== "REAL"))) {
    throw new Error("Organization write mutation did not reach the requested fail-closed state");
  }
  return { ...status, enabled, changed: row.changed };
}

export function organizationWritesAreEffective(
  status: OrganizationWriteStatus,
  globalGateEnabled: boolean,
): boolean {
  return globalGateEnabled && status.active && status.organizationMode === "REAL" && status.writesEnabledAt !== null;
}
