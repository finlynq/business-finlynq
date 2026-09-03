import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";

export const createGlAccountSchema = z.object({
  ledgerId: z.uuid(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
  displayName: z.string().trim().min(1).max(200),
  accountClass: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
  controlKind: z.enum(["NONE", "AR", "AP"]).default("NONE"),
  postable: z.boolean().default(true),
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(180),
}).strict();

export const updateGlAccountSchema = z.object({
  accountId: z.uuid(),
  displayName: z.string().trim().min(1).max(200),
  postable: z.boolean(),
  active: z.boolean(),
  validTo: z.iso.date().nullable(),
  expected: z.object({
    displayName: z.string().trim().min(1).max(200),
    postable: z.boolean(),
    active: z.boolean(),
    validTo: z.iso.date().nullable(),
  }).strict(),
  reason: z.string().trim().min(5).max(500),
}).strict();

async function assertAccountPermission(context: TenantTransactionContext, client: Parameters<Parameters<typeof withTenantTransaction>[1]>[0]) {
  await assertActorHasActivePermission(client, {
    organizationId: context.organizationId,
    actorId: context.actorId,
    permission: PERMISSIONS.manageSegments,
  });
}

export async function createGlAccount(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof createGlAccountSchema>) {
  assertTenantWritesEnabled(input.context);
  const { context, ...unparsedCommand } = input;
  void context;
  const command = createGlAccountSchema.parse(unparsedCommand);
  return withTenantTransaction(input.context, async (client) => {
    await assertWritableOrganization(client, input.context);
    await assertAccountPermission(input.context, client);
    const ledger = await client.query(
      `SELECT 1 FROM ledgers
       WHERE organization_id = $1 AND id = $2 AND active`,
      [input.context.organizationId, command.ledgerId],
    );
    if (!ledger.rows[0]) throw new Error("An active tenant ledger is required");
    if (command.validTo && command.validTo < command.validFrom) throw new Error("Account valid-to date cannot precede valid-from date");
    const existing = await client.query<{
      id: string;
      display_name: string;
      class: string;
      control_kind: string;
      postable: boolean;
      valid_from: string;
      valid_to: string | null;
    }>(
      `SELECT id, display_name, class::text, control_kind::text, postable,
         valid_from::text, valid_to::text
       FROM gl_accounts
       WHERE organization_id = $1 AND ledger_id = $2 AND code = $3
       FOR SHARE`,
      [input.context.organizationId, command.ledgerId, command.code],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.display_name !== command.displayName || row.class !== command.accountClass ||
          row.control_kind !== command.controlKind || row.postable !== command.postable ||
          row.valid_from !== command.validFrom || row.valid_to !== (command.validTo ?? null)) {
        throw new Error("Account code is already bound to different chart-of-accounts data");
      }
      return { accountId: row.id, code: command.code, idempotentReplay: true };
    }
    const accountId = randomUUID();
    const result = await client.query<{ id: string; code: string }>(
      `INSERT INTO gl_accounts (
         id, organization_id, ledger_id, code, display_name, class,
         control_kind, postable, active, valid_from, valid_to
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)
       RETURNING id, code`,
      [
        accountId,
        input.context.organizationId,
        command.ledgerId,
        command.code,
        command.displayName,
        command.accountClass,
        command.controlKind,
        command.postable,
        command.validFrom,
        command.validTo ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error("General-ledger account was not created");
    return { accountId, code: command.code, idempotentReplay: false };
  });
}

export async function updateGlAccount(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof updateGlAccountSchema>) {
  assertTenantWritesEnabled(input.context);
  const { context, ...unparsedCommand } = input;
  void context;
  const command = updateGlAccountSchema.parse(unparsedCommand);
  if (input.context.reason !== command.reason) throw new Error("Account-change reason must be bound to the transaction audit context");
  return withTenantTransaction(input.context, async (client) => {
    await assertWritableOrganization(client, input.context);
    await assertAccountPermission(input.context, client);
    const result = await client.query<{
      id: string;
      display_name: string;
      postable: boolean;
      active: boolean;
      valid_to: string | null;
    }>(
      `UPDATE gl_accounts
       SET display_name = $1, postable = $2, active = $3, valid_to = $4::date
       WHERE organization_id = $5 AND id = $6
         AND display_name = $7 AND postable = $8 AND active = $9
         AND valid_to IS NOT DISTINCT FROM $10::date
       RETURNING id, display_name, postable, active, valid_to::text`,
      [
        command.displayName,
        command.postable,
        command.active,
        command.validTo,
        input.context.organizationId,
        command.accountId,
        command.expected.displayName,
        command.expected.postable,
        command.expected.active,
        command.expected.validTo,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Account changed after it was loaded, is outside this organization, or violates a protected mapping");
    return { accountId: row.id, displayName: row.display_name, postable: row.postable, active: row.active, validTo: row.valid_to };
  });
}
