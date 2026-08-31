import { parseArgs } from "node:util";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  inspectOrganizationWriteStatus,
  organizationWritesAreEffective,
  setOrganizationWrites,
  type OrganizationWriteStatus,
} from "../src/modules/operations/organization-write-activation";

const organizationIdSchema = z.uuid().transform((value) => value.toLowerCase());
const operatorIdSchema = z.string().trim().min(3).max(100)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/i);
const reasonSchema = z.string().trim().min(10).max(500)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
  .refine((value) => !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value));

export const ORGANIZATION_WRITE_FAILURE_MESSAGE =
  "Organization write command failed; database details were redacted";

class OrganizationWriteCommandFailure extends Error {
  readonly requestId?: string;

  constructor(requestId?: string) {
    super(ORGANIZATION_WRITE_FAILURE_MESSAGE);
    this.name = "OrganizationWriteCommandFailure";
    this.requestId = requestId;
  }
}

export function formatOrganizationWriteFailure(error: unknown): string {
  const requestId = error instanceof OrganizationWriteCommandFailure ? error.requestId : undefined;
  return requestId
    ? `${ORGANIZATION_WRITE_FAILURE_MESSAGE}; requestId=${requestId}`
    : ORGANIZATION_WRITE_FAILURE_MESSAGE;
}

export type OrganizationWriteCommand =
  | Readonly<{ action: "status"; organizationId: string }>
  | Readonly<{
      action: "enable" | "disable";
      organizationId: string;
      operatorId: string;
      reason: string;
    }>;

export type OrganizationWriteCommandOutput = Readonly<{
  action: OrganizationWriteCommand["action"];
  outcome: "enabled" | "already_enabled" | "disabled" | "already_disabled" | "status";
  organizationId: string;
  active: boolean;
  organizationMode: string;
  writesEnabledAt: string | null;
  organizationWritesEnabled: boolean;
  globalGateEnabled: boolean;
  effectiveWritesEnabled: boolean;
  requestId?: string;
}>;

function validOrThrow<T>(result: z.ZodSafeParseResult<T>, label: string): T {
  if (!result.success) throw new Error(`${label} is invalid`);
  return result.data;
}

export function parseOrganizationWriteCommand(args: readonly string[]): OrganizationWriteCommand {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      organization: { type: "string" },
      "operator-id": { type: "string" },
      reason: { type: "string" },
    },
  });
  if (positionals.length !== 1 || !["enable", "disable", "status"].includes(positionals[0]!)) {
    throw new Error("Exactly one action is required");
  }
  const action = positionals[0] as OrganizationWriteCommand["action"];
  const organizationId = validOrThrow(organizationIdSchema.safeParse(values.organization), "Organization UUID");
  if (action === "status") {
    if (values["operator-id"] !== undefined || values.reason !== undefined) {
      throw new Error("Status does not accept mutation metadata");
    }
    return { action, organizationId };
  }
  const operatorId = validOrThrow(operatorIdSchema.safeParse(values["operator-id"]), "Operator ID");
  const reason = validOrThrow(reasonSchema.safeParse(values.reason), "Reason");
  return { action, organizationId, operatorId, reason };
}

export function parseGlobalBusinessWriteGate(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error("BUSINESS_WRITES_ENABLED must be exactly true or false");
}

function outputFromStatus(
  command: OrganizationWriteCommand,
  status: OrganizationWriteStatus,
  globalGateEnabled: boolean,
  changed?: boolean,
  requestId?: string,
): OrganizationWriteCommandOutput {
  const organizationWritesEnabled = status.writesEnabledAt !== null;
  let outcome: OrganizationWriteCommandOutput["outcome"] = "status";
  if (command.action === "enable") outcome = changed ? "enabled" : "already_enabled";
  if (command.action === "disable") outcome = changed ? "disabled" : "already_disabled";
  return {
    action: command.action,
    outcome,
    organizationId: status.organizationId,
    active: status.active,
    organizationMode: status.organizationMode,
    writesEnabledAt: status.writesEnabledAt?.toISOString() ?? null,
    organizationWritesEnabled,
    globalGateEnabled,
    effectiveWritesEnabled: organizationWritesAreEffective(status, globalGateEnabled),
    ...(requestId && changed ? { requestId } : {}),
  };
}

/** Execute one command inside the bounded owner transaction used by the CLI. */
export async function executeOrganizationWriteCommand(
  client: PoolClient,
  command: OrganizationWriteCommand,
  options: Readonly<{ globalGateEnabled: boolean; requestId?: string }>,
): Promise<OrganizationWriteCommandOutput> {
  let began = false;
  let auditRequestId: string | undefined;
  try {
    // READ COMMITTED takes a fresh statement snapshot after the database
    // function acquires the exclusive activation fence. SERIALIZABLE would
    // retain the pre-wait snapshot and could miss an audit event committed by
    // the in-flight writer that the fence was waiting to drain.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    began = true;
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    if (command.action === "status") {
      const status = await inspectOrganizationWriteStatus(client, command.organizationId);
      await client.query("COMMIT");
      return outputFromStatus(command, status, options.globalGateEnabled);
    }
    const requestId = validOrThrow(z.uuid().safeParse(options.requestId), "Request ID");
    const result = await setOrganizationWrites(client, {
      organizationId: command.organizationId,
      enabled: command.action === "enable",
      operatorId: command.operatorId,
      reason: command.reason,
      requestId,
    });
    if (result.changed) auditRequestId = requestId;
    await client.query("COMMIT");
    return outputFromStatus(command, result, options.globalGateEnabled, result.changed, requestId);
  } catch {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the redacted primary failure; rollback failure is not safe CLI output.
      }
    }
    throw new OrganizationWriteCommandFailure(auditRequestId);
  }
}

type OrganizationWriteOperatorPool = Readonly<{
  connect: () => Promise<PoolClient>;
  end: () => Promise<void>;
}>;

/**
 * Run against a one-shot owner pool. Cleanup is intentionally best-effort:
 * after COMMIT it must not replace a valid JSON result, and after a command
 * failure it must not discard the redacted error or its audit request UUID.
 */
export async function executeOrganizationWriteOperatorPool(
  pool: OrganizationWriteOperatorPool,
  command: OrganizationWriteCommand,
  options: Readonly<{ globalGateEnabled: boolean; requestId?: string }>,
): Promise<OrganizationWriteCommandOutput> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    return await executeOrganizationWriteCommand(client, command, options);
  } finally {
    if (client) {
      try {
        client.release();
      } catch {
        // The transaction result is authoritative; do not emit a second result.
      }
    }
    try {
      await pool.end();
    } catch {
      // Preserve the primary command result/failure and audit correlation UUID.
    }
  }
}
