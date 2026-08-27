import "server-only";

import { createHash, randomUUID } from "node:crypto";
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

const partyNumberSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/);
const displayNameSchema = z.string().trim().min(1).max(200);
const idempotencyKeySchema = z.string().trim().min(1).max(180);
const addressSchema = z.object({
  kind: z.enum(["BILLING", "SHIPPING", "REMIT_TO", "REGISTERED"]),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(30),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  validFrom: z.iso.date(),
});

export type CreatePartyCommand = Readonly<{
  context: TenantTransactionContext;
  partyNumber: string;
  displayName: string;
  idempotencyKey: string;
  internalLegalEntityId?: string;
  address?: z.input<typeof addressSchema>;
}>;

export type PartyDto = Readonly<{
  id: string;
  partyNumber: string;
  displayName: string;
  active: boolean;
  internalLegalEntityId: string | null;
}>;

type StoredParty = Readonly<{
  id: string;
  party_number: string;
  display_name_ciphertext: string;
  display_name_key_version: number;
  active: boolean;
  internal_legal_entity_id: string | null;
  command_hash: string;
}>;

function assertBusinessWritesEnabled(): void {
  if (process.env.BUSINESS_WRITES_ENABLED !== "true") throw new Error("Business writes are disabled");
}

function decryptPartyName(
  row: StoredParty,
  organizationId: string,
  dek: Buffer,
): string {
  return decryptField(parseEncryptedField(row.display_name_ciphertext), dek, {
    organizationId,
    table: "parties",
    column: "display_name_ciphertext",
    recordId: row.id,
    keyVersion: row.display_name_key_version,
  });
}

function toDto(row: StoredParty, displayName: string): PartyDto {
  return {
    id: row.id,
    partyNumber: row.party_number,
    displayName,
    active: row.active,
    internalLegalEntityId: row.internal_legal_entity_id,
  };
}

export async function createParty(
  command: CreatePartyCommand,
): Promise<Readonly<{ party: PartyDto; idempotentReplay: boolean }>> {
  assertBusinessWritesEnabled();
  const partyNumber = partyNumberSchema.parse(command.partyNumber);
  const displayName = displayNameSchema.parse(command.displayName);
  const idempotencyKey = idempotencyKeySchema.parse(command.idempotencyKey);
  const address = command.address ? addressSchema.parse(command.address) : undefined;
  const commandHash = createHash("sha256").update(JSON.stringify({
    partyNumber,
    displayName,
    idempotencyKey,
    internalLegalEntityId: command.internalLegalEntityId ?? null,
    address: address ?? null,
  }), "utf8").digest("hex");

  return withTenantTransaction(command.context, async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: command.context.organizationId,
      actorId: command.context.actorId,
      permission: PERMISSIONS.manageParties,
    });
    const organization = await client.query<{ active: boolean; is_demo: boolean }>(
      "SELECT active, is_demo FROM organizations WHERE id = $1",
      [command.context.organizationId],
    );
    if (!organization.rows[0]?.active || organization.rows[0].is_demo) {
      throw new Error("Party persistence requires an active non-demo organization");
    }
    if (command.internalLegalEntityId) {
      const entity = await client.query(
        `SELECT 1 FROM legal_entities
         WHERE organization_id = $1 AND id = $2 AND active`,
        [command.context.organizationId, command.internalLegalEntityId],
      );
      if (!entity.rows[0]) throw new Error("Internal legal entity was not found in the organization");
    }

    const activeKey = await loadActiveOrganizationKey(client, command.context.organizationId);
    try {
      const partyId = randomUUID();
      const searchToken = createBlindIndex(
        displayName,
        activeKey.dek,
        command.context.organizationId,
        "parties.display-name",
      );
      const encryptedName = encryptField(displayName, activeKey.dek, {
        organizationId: command.context.organizationId,
        table: "parties",
        column: "display_name_ciphertext",
        recordId: partyId,
        keyVersion: activeKey.keyVersion,
      });
      const inserted = await client.query<StoredParty>(
        `INSERT INTO parties (
           id, organization_id, party_number, display_name_ciphertext,
           display_name_key_version, search_token, command_hash, internal_legal_entity_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id, party_number) DO NOTHING
         RETURNING id, party_number, display_name_ciphertext, display_name_key_version,
           active, internal_legal_entity_id, command_hash`,
        [
          partyId,
          command.context.organizationId,
          partyNumber,
          serializeEncryptedField(encryptedName),
          activeKey.keyVersion,
          searchToken,
          commandHash,
          command.internalLegalEntityId ?? null,
        ],
      );

      let stored = inserted.rows[0];
      const idempotentReplay = !stored;
      if (!stored) {
        const existing = await client.query<StoredParty>(
          `SELECT id, party_number, display_name_ciphertext, display_name_key_version,
             active, internal_legal_entity_id, command_hash
           FROM parties
           WHERE organization_id = $1 AND party_number = $2
           FOR SHARE`,
          [command.context.organizationId, partyNumber],
        );
        stored = existing.rows[0];
        if (!stored || stored.command_hash !== commandHash) {
          throw new Error("Party number is already bound to different master data");
        }
      } else if (address) {
        const addressId = randomUUID();
        const encryptedAddress = encryptField(JSON.stringify(address), activeKey.dek, {
          organizationId: command.context.organizationId,
          table: "party_addresses",
          column: "ciphertext",
          recordId: addressId,
          keyVersion: activeKey.keyVersion,
        });
        await client.query(
          `INSERT INTO party_addresses (
             id, organization_id, party_id, kind, ciphertext, key_version, valid_from
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            addressId,
            command.context.organizationId,
            stored.id,
            address.kind,
            serializeEncryptedField(encryptedAddress),
            String(activeKey.keyVersion),
            address.validFrom,
          ],
        );
      }

      return {
        party: toDto(stored, decryptPartyName(stored, command.context.organizationId, activeKey.dek)),
        idempotentReplay,
      };
    } finally {
      activeKey.dek.fill(0);
    }
  });
}

export async function searchPartiesByExactName(
  context: TenantTransactionContext,
  displayName: string,
): Promise<readonly PartyDto[]> {
  const normalizedName = displayNameSchema.parse(displayName);
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: PERMISSIONS.readParties,
    });
    const activeKey = await loadActiveOrganizationKey(client, context.organizationId);
    try {
      const token = createBlindIndex(
        normalizedName,
        activeKey.dek,
        context.organizationId,
        "parties.display-name",
      );
      const result = await client.query<StoredParty>(
        `SELECT id, party_number, display_name_ciphertext, display_name_key_version,
           active, internal_legal_entity_id
         FROM parties
         WHERE organization_id = $1 AND search_token = $2
         ORDER BY party_number
         LIMIT 50`,
        [context.organizationId, token],
      );
      return result.rows.map((row) =>
        toDto(row, decryptPartyName(row, context.organizationId, activeKey.dek)),
      );
    } finally {
      activeKey.dek.fill(0);
    }
  });
}
