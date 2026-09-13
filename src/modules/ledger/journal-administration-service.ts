import "server-only";

import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import {
  assertActorHasActiveOrganizationRole,
  assertActorHasActivePermission,
} from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
} from "@/modules/workspace/write-policy";

const commandSchema = z.object({
  journalId: z.uuid(),
  reason: z.string().trim().min(10).max(500),
  idempotencyKey: z.uuid(),
}).strict();

type AdministrativeAction = "UNPOST" | "DELETE";

export type JournalAdministrativeResult = Readonly<{
  journalId: string;
  status: "DRAFT" | "DELETED";
  journalNumber: number | null;
  idempotentReplay: boolean;
}>;

type ControlRow = Readonly<{
  journal_id: string;
  result_status: "DRAFT" | "DELETED";
  journal_number: number | null;
  idempotent_replay: boolean;
}>;

async function controlJournal(
  action: AdministrativeAction,
  unparsed: Readonly<{
    context: TenantTransactionContext;
    journalId: string;
    reason: string;
    idempotencyKey: string;
  }>,
): Promise<JournalAdministrativeResult> {
  assertTenantWritesEnabled(unparsed.context);
  const command = commandSchema.parse({
    journalId: unparsed.journalId,
    reason: unparsed.reason,
    idempotencyKey: unparsed.idempotencyKey,
  });
  if (unparsed.context.sessionMode !== "real" ||
      !new Set(["password+mfa", "oidc+mfa"]).has(unparsed.context.authMethod)) {
    throw new Error("Journal administration requires a real session with current MFA assurance");
  }
  if (unparsed.context.reason !== command.reason) {
    throw new Error("Journal administration reason must be bound to the transaction audit context");
  }

  return withTenantTransaction(unparsed.context, async (client) => {
    await assertWritableOrganization(client, unparsed.context);
    await assertActorHasActivePermission(client, {
      organizationId: unparsed.context.organizationId,
      actorId: unparsed.context.actorId,
      permission: PERMISSIONS.administerJournal,
    });
    await assertActorHasActiveOrganizationRole(client, {
      organizationId: unparsed.context.organizationId,
      actorId: unparsed.context.actorId,
      roleKeys: ["OWNER", "ORGANIZATION_ADMIN"],
    });
    const result = await client.query<ControlRow>(
      "SELECT * FROM app.admin_control_journal_transaction($1,$2,$3,$4)",
      [action, command.journalId, command.reason, command.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row || row.journal_id !== command.journalId ||
        !new Set(["DRAFT", "DELETED"]).has(row.result_status)) {
      throw new Error("Journal administration did not return an authorized result");
    }
    return {
      journalId: row.journal_id,
      status: row.result_status,
      journalNumber: row.journal_number === null ? null : Number(row.journal_number),
      idempotentReplay: row.idempotent_replay,
    };
  });
}

export function unpostJournal(input: Parameters<typeof controlJournal>[1]) {
  return controlJournal("UNPOST", input);
}

export function deleteJournal(input: Parameters<typeof controlJournal>[1]) {
  return controlJournal("DELETE", input);
}
