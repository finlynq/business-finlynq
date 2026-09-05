import "server-only";

import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  createBlindIndex,
  decryptField,
  encryptField,
  parseEncryptedField,
  serializeEncryptedField,
} from "@/security/organization-encryption";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";

export const updatePartySchema = z.object({
  partyId: z.uuid(),
  displayName: z.string().trim().min(1).max(200),
  active: z.boolean(),
  expectedDisplayName: z.string().trim().min(1).max(200),
  expectedActive: z.boolean(),
  reason: z.string().trim().min(5).max(500),
}).strict();

export async function updateParty(input: Readonly<{
  context: TenantTransactionContext;
}> & z.input<typeof updatePartySchema>) {
  assertTenantWritesEnabled(input.context);
  const command = updatePartySchema.parse(input);
  if (input.context.reason !== command.reason) throw new Error("Party-change reason must be bound to the transaction audit context");
  return withTenantTransaction(input.context, async (client) => {
    await assertWritableOrganization(client, input.context);
    await assertActorHasActivePermission(client, {
      organizationId: input.context.organizationId,
      actorId: input.context.actorId,
      permission: PERMISSIONS.manageParties,
    });
    const current = await client.query<{
      id: string;
      display_name_ciphertext: string;
      display_name_key_version: number;
      active: boolean;
    }>(
      `SELECT id, display_name_ciphertext, display_name_key_version, active
       FROM parties
       WHERE organization_id = $1 AND id = $2
       FOR UPDATE`,
      [input.context.organizationId, command.partyId],
    );
    const party = current.rows[0];
    if (!party) throw new Error("Party was not found in the authorized organization");
    const key = await loadActiveOrganizationKey(client, input.context.organizationId);
    try {
      const currentName = decryptField(parseEncryptedField(party.display_name_ciphertext), key.dek, {
        organizationId: input.context.organizationId,
        table: "parties",
        column: "display_name_ciphertext",
        recordId: party.id,
        keyVersion: party.display_name_key_version,
      });
      if (currentName !== command.expectedDisplayName || party.active !== command.expectedActive) {
        throw new Error("Party changed after it was loaded; refresh before retrying");
      }
      const encrypted = encryptField(command.displayName, key.dek, {
        organizationId: input.context.organizationId,
        table: "parties",
        column: "display_name_ciphertext",
        recordId: party.id,
        keyVersion: key.keyVersion,
      });
      const searchToken = createBlindIndex(
        command.displayName,
        key.dek,
        input.context.organizationId,
        "parties.display-name",
      );
      const updated = await client.query<{ id: string; active: boolean }>(
        `UPDATE parties
         SET display_name_ciphertext = $1, display_name_key_version = $2,
           search_token = $3, active = $4
         WHERE organization_id = $5 AND id = $6 AND active = $7
         RETURNING id, active`,
        [
          serializeEncryptedField(encrypted),
          key.keyVersion,
          searchToken,
          command.active,
          input.context.organizationId,
          party.id,
          command.expectedActive,
        ],
      );
      if (!updated.rows[0]) throw new Error("Concurrent party update detected");
      if (!command.active) {
        await client.query(
          `UPDATE party_accounts SET active = false
           WHERE organization_id = $1 AND party_id = $2 AND active`,
          [input.context.organizationId, party.id],
        );
      }
      return { partyId: party.id, displayName: command.displayName, active: command.active };
    } finally {
      key.dek.fill(0);
    }
  });
}
