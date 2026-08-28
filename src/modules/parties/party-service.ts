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
import {
  assertTenantWritesEnabled,
  assertWritableOrganization,
} from "@/modules/workspace/write-policy";

const partyNumberSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/);
const displayNameSchema = z.string().trim().min(1).max(200);
const idempotencyKeySchema = z.string().trim().min(1).max(180);
const partyAccountSchema = z.object({
  legalEntityId: z.uuid(),
  ledgerId: z.uuid(),
  role: z.enum(["CUSTOMER", "SUPPLIER"]),
  accountNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
  controlAccountId: z.uuid(),
  transactionCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable().optional(),
});
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
  account?: z.input<typeof partyAccountSchema>;
  address?: z.input<typeof addressSchema>;
}>;

export type AddPartyAccountCommand = Readonly<{
  context: TenantTransactionContext;
  partyId: string;
  idempotencyKey: string;
  account: z.input<typeof partyAccountSchema>;
}>;

export type PartyAccountDto = Readonly<{
  id: string;
  legalEntityId: string;
  ledgerId: string;
  role: "CUSTOMER" | "SUPPLIER";
  accountNumber: string;
  controlAccountId: string;
  transactionCurrency: string | null;
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

type StoredPartyAccount = Readonly<{
  id: string;
  legal_entity_id: string;
  ledger_id: string;
  role: "CUSTOMER" | "SUPPLIER";
  account_number: string;
  control_account_id: string;
  transaction_currency: string | null;
}>;

type StoredAttachedPartyAccount = StoredPartyAccount & Readonly<{
  party_id: string;
}>;

function deterministicCommandUuid(
  organizationId: string,
  scope: string,
  idempotencyKey: string,
): string {
  const bytes = createHash("sha256")
    .update(`business-finlynq|${organizationId}|${scope}|${idempotencyKey}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

function accountToDto(row: StoredPartyAccount): PartyAccountDto {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    ledgerId: row.ledger_id,
    role: row.role,
    accountNumber: row.account_number,
    controlAccountId: row.control_account_id,
    transactionCurrency: row.transaction_currency,
  };
}

export async function createParty(
  command: CreatePartyCommand,
): Promise<Readonly<{ party: PartyDto; partyAccount: PartyAccountDto | null; idempotentReplay: boolean }>> {
  assertTenantWritesEnabled(command.context);
  const partyNumber = partyNumberSchema.parse(command.partyNumber);
  const displayName = displayNameSchema.parse(command.displayName);
  const idempotencyKey = idempotencyKeySchema.parse(command.idempotencyKey);
  const account = command.account ? partyAccountSchema.parse(command.account) : undefined;
  const transactionCurrency = account?.transactionCurrency ?? null;
  const address = command.address ? addressSchema.parse(command.address) : undefined;
  const commandHash = createHash("sha256").update(JSON.stringify({
    partyNumber,
    displayName,
    idempotencyKey,
    internalLegalEntityId: command.internalLegalEntityId ?? null,
    account: account ? { ...account, transactionCurrency } : null,
    address: address ?? null,
  }), "utf8").digest("hex");

  return withTenantTransaction(command.context, async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: command.context.organizationId,
      actorId: command.context.actorId,
      permission: PERMISSIONS.manageParties,
    });
    await assertWritableOrganization(client, command.context);
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
      let storedAccount: StoredPartyAccount | undefined;
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
        if (account) {
          const replayAccount = await client.query<StoredPartyAccount>(
            `SELECT id, legal_entity_id, ledger_id, role, account_number,
               control_account_id, transaction_currency
             FROM party_accounts
             WHERE organization_id = $1
               AND party_id = $2
               AND legal_entity_id = $3
               AND ledger_id = $4
               AND role = $5
               AND account_number = $6
               AND control_account_id = $7
               AND transaction_currency IS NOT DISTINCT FROM $8::text
             FOR SHARE`,
            [
              command.context.organizationId,
              stored.id,
              account.legalEntityId,
              account.ledgerId,
              account.role,
              account.accountNumber,
              account.controlAccountId,
              transactionCurrency,
            ],
          );
          storedAccount = replayAccount.rows[0];
          if (!storedAccount) {
            throw new Error("Party replay is missing its bound customer or supplier account");
          }
        }
      } else if (account) {
        const accountingSetup = await client.query(
          `SELECT 1
           FROM legal_entities entity
           JOIN ledgers ledger
             ON ledger.organization_id = entity.organization_id
            AND ledger.legal_entity_id = entity.id
            AND ledger.id = $3
            AND ledger.kind = 'PRIMARY'
            AND ledger.active
           JOIN gl_accounts control_account
             ON control_account.organization_id = ledger.organization_id
            AND control_account.ledger_id = ledger.id
            AND control_account.id = $5
            AND control_account.active
            AND control_account.postable
            AND control_account.valid_from <= current_date
            AND (control_account.valid_to IS NULL OR control_account.valid_to >= current_date)
           WHERE entity.organization_id = $1
             AND entity.id = $2
             AND entity.active
             AND control_account.control_kind = CASE $4::text
               WHEN 'CUSTOMER' THEN 'AR'::control_account_kind
               WHEN 'SUPPLIER' THEN 'AP'::control_account_kind
             END
             AND EXISTS (
               SELECT 1
               FROM account_combinations combination
               WHERE combination.organization_id = entity.organization_id
                 AND combination.ledger_id = ledger.id
                 AND combination.entity_id = entity.id
                 AND combination.account_id = control_account.id
                 AND combination.active
             )
             AND ($6::text IS NULL OR EXISTS (
               SELECT 1 FROM currency_definitions currency
               WHERE currency.code = $6 AND currency.active
             ))`,
          [
            command.context.organizationId,
            account.legalEntityId,
            account.ledgerId,
            account.role,
            account.controlAccountId,
            transactionCurrency,
          ],
        );
        if (!accountingSetup.rows[0]) {
          throw new Error("The selected entity, primary ledger, role, control account, or currency is not an active AR/AP configuration");
        }
        const partyAccountId = randomUUID();
        const insertedAccount = await client.query<StoredPartyAccount>(
          `INSERT INTO party_accounts (
             id, organization_id, legal_entity_id, ledger_id, party_id,
             role, account_number, control_account_id, transaction_currency
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, legal_entity_id, ledger_id, role, account_number,
             control_account_id, transaction_currency`,
          [
            partyAccountId,
            command.context.organizationId,
            account.legalEntityId,
            account.ledgerId,
            stored.id,
            account.role,
            account.accountNumber,
            account.controlAccountId,
            transactionCurrency,
          ],
        );
        storedAccount = insertedAccount.rows[0];
        if (!storedAccount) throw new Error("Customer or supplier account was not persisted");
      }

      if (!idempotentReplay && address) {
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
        partyAccount: storedAccount ? accountToDto(storedAccount) : null,
        idempotentReplay,
      };
    } finally {
      activeKey.dek.fill(0);
    }
  });
}

export async function addPartyAccount(
  command: AddPartyAccountCommand,
): Promise<Readonly<{ partyAccount: PartyAccountDto; idempotentReplay: boolean }>> {
  assertTenantWritesEnabled(command.context);
  const partyId = z.uuid().parse(command.partyId);
  const idempotencyKey = idempotencyKeySchema.parse(command.idempotencyKey);
  const account = partyAccountSchema.parse(command.account);
  const transactionCurrency = account.transactionCurrency ?? null;
  const partyAccountId = deterministicCommandUuid(
    command.context.organizationId,
    `party:${partyId}:account`,
    idempotencyKey,
  );

  return withTenantTransaction(command.context, async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: command.context.organizationId,
      actorId: command.context.actorId,
      permission: PERMISSIONS.manageParties,
    });
    await assertWritableOrganization(client, command.context);

    const party = await client.query(
      `SELECT 1
       FROM parties
       WHERE organization_id = $1 AND id = $2 AND active
       FOR SHARE`,
      [command.context.organizationId, partyId],
    );
    if (!party.rows[0]) {
      throw new Error("The active organization party was not found");
    }

    const accountingSetup = await client.query(
      `SELECT 1
       FROM legal_entities entity
       JOIN ledgers ledger
         ON ledger.organization_id = entity.organization_id
        AND ledger.legal_entity_id = entity.id
        AND ledger.id = $3
        AND ledger.kind = 'PRIMARY'
        AND ledger.active
       JOIN gl_accounts control_account
         ON control_account.organization_id = ledger.organization_id
        AND control_account.ledger_id = ledger.id
        AND control_account.id = $5
        AND control_account.active
        AND control_account.postable
        AND control_account.valid_from <= current_date
        AND (control_account.valid_to IS NULL OR control_account.valid_to >= current_date)
       WHERE entity.organization_id = $1
         AND entity.id = $2
         AND entity.active
         AND control_account.control_kind = CASE $4::text
           WHEN 'CUSTOMER' THEN 'AR'::control_account_kind
           WHEN 'SUPPLIER' THEN 'AP'::control_account_kind
         END
         AND EXISTS (
           SELECT 1
           FROM account_combinations combination
           WHERE combination.organization_id = entity.organization_id
             AND combination.ledger_id = ledger.id
             AND combination.entity_id = entity.id
             AND combination.account_id = control_account.id
             AND combination.active
         )
         AND ($6::text IS NULL OR EXISTS (
           SELECT 1 FROM currency_definitions currency
           WHERE currency.code = $6 AND currency.active
         ))`,
      [
        command.context.organizationId,
        account.legalEntityId,
        account.ledgerId,
        account.role,
        account.controlAccountId,
        transactionCurrency,
      ],
    );
    if (!accountingSetup.rows[0]) {
      throw new Error("The selected entity, primary ledger, role, control account, or currency is not an active AR/AP configuration");
    }

    const inserted = await client.query<StoredAttachedPartyAccount>(
      `INSERT INTO party_accounts (
         id, organization_id, legal_entity_id, ledger_id, party_id,
         role, account_number, control_account_id, transaction_currency
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING
       RETURNING id, party_id, legal_entity_id, ledger_id, role, account_number,
         control_account_id, transaction_currency`,
      [
        partyAccountId,
        command.context.organizationId,
        account.legalEntityId,
        account.ledgerId,
        partyId,
        account.role,
        account.accountNumber,
        account.controlAccountId,
        transactionCurrency,
      ],
    );
    let stored = inserted.rows[0];
    const idempotentReplay = !stored;
    if (!stored) {
      const existing = await client.query<StoredAttachedPartyAccount>(
        `SELECT id, party_id, legal_entity_id, ledger_id, role, account_number,
           control_account_id, transaction_currency
         FROM party_accounts
         WHERE organization_id = $1
           AND (
             id = $2 OR
             (legal_entity_id = $3 AND role = $4 AND account_number = $5)
           )
         ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END
         LIMIT 1
         FOR SHARE`,
        [
          command.context.organizationId,
          partyAccountId,
          account.legalEntityId,
          account.role,
          account.accountNumber,
        ],
      );
      stored = existing.rows[0];
      if (!stored || stored.party_id !== partyId ||
          stored.legal_entity_id !== account.legalEntityId ||
          stored.ledger_id !== account.ledgerId ||
          stored.role !== account.role ||
          stored.account_number !== account.accountNumber ||
          stored.control_account_id !== account.controlAccountId ||
          stored.transaction_currency !== transactionCurrency) {
        throw new Error("The entity role or idempotency key is already bound to different party account data");
      }
    }

    return { partyAccount: accountToDto(stored), idempotentReplay };
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
