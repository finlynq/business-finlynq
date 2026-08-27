import "server-only";

import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
} from "@/modules/workspace/write-policy";

const commandSchema = z.object({
  ledgerId: z.uuid(),
  manualMode: z.enum(["REVIEW_REQUIRED", "AUTO_POST"]),
  expectedVersion: z.number().int().min(0),
});

export type SetLedgerPostingPolicyCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof commandSchema>;

export type LedgerPostingPolicyResult = Readonly<{
  ledgerId: string;
  manualMode: "REVIEW_REQUIRED" | "AUTO_POST";
  version: number;
}>;

export async function setLedgerPostingPolicy(
  unparsedCommand: SetLedgerPostingPolicyCommand,
): Promise<LedgerPostingPolicyResult> {
  assertTenantWritesEnabled(unparsedCommand.context);
  const command = commandSchema.parse(unparsedCommand);

  return withTenantTransaction(unparsedCommand.context, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    await assertActorHasActivePermission(client, {
      organizationId: unparsedCommand.context.organizationId,
      actorId: unparsedCommand.context.actorId,
      permission: PERMISSIONS.managePostingPolicy,
    });
    const ledger = await client.query(
      `SELECT 1
       FROM ledgers ledger
       JOIN organizations organization ON organization.id = ledger.organization_id
       WHERE ledger.organization_id = $1 AND ledger.id = $2
         AND ledger.active AND organization.active`,
      [unparsedCommand.context.organizationId, command.ledgerId],
    );
    if (!ledger.rows[0]) throw new Error("An active tenant ledger is required");

    const existing = await client.query<{
      manual_mode: "REVIEW_REQUIRED" | "AUTO_POST";
      version: number;
    }>(
      `SELECT manual_mode, version
       FROM ledger_posting_policies
       WHERE organization_id = $1 AND ledger_id = $2
       FOR UPDATE`,
      [unparsedCommand.context.organizationId, command.ledgerId],
    );
    if (!existing.rows[0]) {
      if (command.expectedVersion !== 0) {
        throw new Error("Posting policy was not yet created; refresh before retrying");
      }
      const inserted = await client.query<{
        manual_mode: "REVIEW_REQUIRED" | "AUTO_POST";
        version: number;
      }>(
        `INSERT INTO ledger_posting_policies (
           organization_id, ledger_id, manual_mode, version, updated_by
         ) VALUES ($1, $2, $3, 1, $4)
         RETURNING manual_mode, version`,
        [
          unparsedCommand.context.organizationId,
          command.ledgerId,
          command.manualMode,
          unparsedCommand.context.actorId,
        ],
      );
      const policy = inserted.rows[0];
      if (!policy) throw new Error("Posting policy was not created");
      return { ledgerId: command.ledgerId, manualMode: policy.manual_mode, version: policy.version };
    }

    if (existing.rows[0].version !== command.expectedVersion) {
      throw new Error("Posting policy changed after it was loaded; refresh before retrying");
    }
    const updated = await client.query<{
      manual_mode: "REVIEW_REQUIRED" | "AUTO_POST";
      version: number;
    }>(
      `UPDATE ledger_posting_policies
       SET manual_mode = $1, version = version + 1, updated_by = $2
       WHERE organization_id = $3 AND ledger_id = $4 AND version = $5
       RETURNING manual_mode, version`,
      [
        command.manualMode,
        unparsedCommand.context.actorId,
        unparsedCommand.context.organizationId,
        command.ledgerId,
        command.expectedVersion,
      ],
    );
    const policy = updated.rows[0];
    if (!policy) throw new Error("Concurrent posting-policy update detected");
    return { ledgerId: command.ledgerId, manualMode: policy.manual_mode, version: policy.version };
  });
}
