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
  periodId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  toState: z.enum(["OPEN", "ADJUSTMENT_ONLY", "HARD_CLOSED", "SEALED"]),
  idempotencyKey: z.string().trim().min(1).max(180),
});

export type TransitionFiscalPeriodCommand = Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof commandSchema>;

export async function transitionFiscalPeriod(
  unparsedCommand: TransitionFiscalPeriodCommand,
): Promise<Readonly<{
  periodId: string;
    state: "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED";
  version: number;
  idempotentReplay: boolean;
}>> {
  assertTenantWritesEnabled(unparsedCommand.context);
  if (!unparsedCommand.context.reason) throw new Error("Period transitions require an audit reason");
  const command = commandSchema.parse(unparsedCommand);
  const transactionContext = {
    ...unparsedCommand.context,
    requestId: `period:${command.idempotencyKey}`,
  };
  return withTenantTransaction(transactionContext, async (client) => {
    await assertWritableOrganization(client, unparsedCommand.context);
    const current = await client.query<{
      state: "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED";
      version: number;
      is_demo: boolean;
    }>(
      `SELECT period.state, period.version, organization.is_demo
       FROM fiscal_periods period
       JOIN organizations organization ON organization.id = period.organization_id
       WHERE period.organization_id = $1 AND period.id = $2
         AND organization.active
       FOR UPDATE OF period`,
      [unparsedCommand.context.organizationId, command.periodId],
    );
    const period = current.rows[0];
    if (!period) throw new Error("Period was not found in the active organization");

    const isReopen = command.toState === "OPEN" ||
      (period.state === "HARD_CLOSED" && command.toState === "ADJUSTMENT_ONLY");
    const isSeal = command.toState === "SEALED";
    await assertActorHasActivePermission(client, {
      organizationId: unparsedCommand.context.organizationId,
      actorId: unparsedCommand.context.actorId,
      permission: isSeal
        ? PERMISSIONS.sealPeriod
        : isReopen
          ? PERMISSIONS.reopenPeriod
          : PERMISSIONS.closePeriod,
    });
    if (period.state === command.toState) {
      const event = await client.query<{ reason: string }>(
        `SELECT reason FROM period_events
         WHERE organization_id = $1 AND period_id = $2
           AND request_id = $3 AND to_state = $4`,
        [
          unparsedCommand.context.organizationId,
          command.periodId,
          transactionContext.requestId,
          command.toState,
        ],
      );
      if (!event.rows[0] || event.rows[0].reason !== transactionContext.reason ||
          period.version !== command.expectedVersion + 1) {
        throw new Error("Period is already in the requested state under another command");
      }
      return { periodId: command.periodId, state: command.toState, version: period.version, idempotentReplay: true };
    }
    if (period.version !== command.expectedVersion) {
      throw new Error("Fiscal period changed after it was loaded; refresh before retrying");
    }
    if (command.toState === "HARD_CLOSED" || command.toState === "SEALED") {
      const pending = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM journal_entries
         WHERE organization_id = $1 AND period_id = $2
           AND status IN ('DRAFT', 'SUBMITTED', 'APPROVED')`,
        [unparsedCommand.context.organizationId, command.periodId],
      );
      if ((pending.rows[0]?.count ?? 0) > 0) {
        throw new Error("Fiscal period has unposted journals that must be resolved before hard close or seal");
      }
    }

    const updated = await client.query<{ state: "OPEN" | "ADJUSTMENT_ONLY" | "HARD_CLOSED" | "SEALED"; version: number }>(
      `UPDATE fiscal_periods
       SET state = $1
       WHERE organization_id = $2 AND id = $3 AND version = $4
       RETURNING state, version`,
      [command.toState, unparsedCommand.context.organizationId, command.periodId, command.expectedVersion],
    );
    if (!updated.rows[0]) throw new Error("Concurrent fiscal-period update detected");
    return {
      periodId: command.periodId,
      state: updated.rows[0].state,
      version: updated.rows[0].version,
      idempotentReplay: false,
    };
  });
}
