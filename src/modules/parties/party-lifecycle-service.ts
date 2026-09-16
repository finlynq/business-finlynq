import "server-only";

import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import {
  assertActorHasActiveOrganizationRole,
  assertActorHasActivePermission,
} from "@/modules/identity/authorization";
import { AuthorizationDeniedError } from "@/modules/identity/authorization-error";
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
  const { context, ...unparsedCommand } = input;
  void context;
  const command = updatePartySchema.parse(unparsedCommand);
  if (input.context.reason !== command.reason) throw new Error("Party-change reason must be bound to the transaction audit context");
  if (input.context.sessionMode !== "real" ||
      !new Set(["password+mfa", "oidc+mfa"]).has(input.context.authMethod)) {
    throw new AuthorizationDeniedError(
      "Party corrections require a real organization session with current MFA assurance",
    );
  }
  return withTenantTransaction(input.context, async (client) => {
    await assertWritableOrganization(client, input.context);
    await assertActorHasActivePermission(client, {
      organizationId: input.context.organizationId,
      actorId: input.context.actorId,
      permission: PERMISSIONS.manageParties,
    });
    await assertActorHasActiveOrganizationRole(client, {
      organizationId: input.context.organizationId,
      actorId: input.context.actorId,
      roleKeys: ["OWNER"],
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
        if (currentName === command.displayName && party.active === command.active) {
          return {
            partyId: party.id,
            displayName: command.displayName,
            active: command.active,
            idempotentReplay: true,
            warnings: [],
          };
        }
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
      const duplicate = await client.query<{ duplicate_count: number }>(
        `SELECT count(*)::integer AS duplicate_count
         FROM parties
         WHERE organization_id = $1 AND id <> $2
           AND search_token = $3 AND active`,
        [input.context.organizationId, party.id, searchToken],
      );
      const duplicateNameWarning = Number(duplicate.rows[0]?.duplicate_count ?? 0) > 0;
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
      await client.query(
        `SELECT app.append_tenant_business_audit(
           $1::uuid, 'party.updated', 'party', $2,
           jsonb_build_object(
             'displayNameFrom', $3::text, 'displayNameTo', $4::text,
             'activeFrom', $5::boolean, 'activeTo', $6::boolean,
             'duplicateNameWarning', $7::boolean
           ),
           'parties.party-updated'
         )`,
        [
          input.context.organizationId,
          party.id,
          currentName,
          command.displayName,
          party.active,
          command.active,
          duplicateNameWarning,
        ],
      );
      return {
        partyId: party.id,
        displayName: command.displayName,
        active: command.active,
        idempotentReplay: false,
        warnings: duplicateNameWarning
          ? ["Another active party has the same normalized display name."]
          : [],
      };
    } finally {
      key.dek.fill(0);
    }
  });
}
