import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { canonicalHash } from "@/modules/subledger/document-model";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertTenantWritesEnabled, assertWritableOrganization } from "@/modules/workspace/write-policy";
import {
  createEmailAliasSchema,
  configurePersonalEmailAliasSchema,
  customerDeliveryPreferenceSchema,
  emailDeliverySettingsSchema,
  normalizeEmailAddress,
  paymentInstructionDetailsSchema,
  provisionPersonalEmailAliasSchema,
  retirePaymentProfileSchema,
  rotateEmailAliasSchema,
  rotatePersonalEmailAliasSchema,
  savePaymentProfileSchema,
  updateEmailAliasSchema,
  upsertEmailBookingRuleSchema,
} from "./model";
import { activeEmailKeyVersion, decryptEmailValue, encryptEmailValue } from "./crypto";
import { emailSecretReadiness } from "./secrets";
import { inboundEmailRouting } from "./routing";

type ContextCommand = Readonly<{ context: TenantTransactionContext }>;
function withoutContext<T extends ContextCommand>(value: T): Omit<T, "context"> {
  const { context, ...command } = value;
  void context;
  return command;
}

type AliasRow = Readonly<{
  id: string;
  organization_id: string;
  owner_membership_id: string | null;
  legal_entity_id: string | null;
  connection_id: string | null;
  provider: "SELF_SMTP" | "RESEND";
  label: string;
  purpose: "PAYABLES" | "RECEIVABLES" | "GENERAL";
  address_digest: string;
  address_ciphertext: string;
  key_version: number;
  status: "ACTIVE" | "DISABLED" | "RETIRED";
  version: number;
  hourly_limit: number;
  max_payload_bytes: number;
  idempotency_key: string;
  command_hash: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  retired_at: Date | null;
}>;

function outboundDomain(): string | null {
  return process.env.BUSINESS_FINLYNQ_OUTBOUND_EMAIL_DOMAIN?.trim().toLocaleLowerCase("en-US") ?? null;
}

function addressDigest(address: string): string {
  return createHash("sha256").update(normalizeEmailAddress(address), "utf8").digest("hex");
}

function newInboundAddress(): string {
  const routing = inboundEmailRouting();
  if (!routing) throw Object.assign(new Error("Inbound email is not configured for this environment"), { code: "EMAIL_NOT_CONFIGURED" });
  return normalizeEmailAddress(`${routing.prefix}${randomBytes(16).toString("hex")}@${routing.domain}`);
}

async function assertEmailAdministrator(client: PoolClient, context: TenantTransactionContext): Promise<void> {
  assertTenantWritesEnabled(context);
  await assertWritableOrganization(client, context);
  await assertActorHasActivePermission(client, {
    organizationId: context.organizationId,
    actorId: context.actorId,
    permission: PERMISSIONS.manageOrganizationSettings,
  });
}

async function assertEntityAndConnection(
  client: PoolClient,
  context: TenantTransactionContext,
  entityId: string | null | undefined,
  connectionId: string | null | undefined,
  purpose: "PAYABLES" | "RECEIVABLES" | "GENERAL",
): Promise<void> {
  if (entityId) {
    const entity = await client.query("SELECT 1 FROM legal_entities WHERE organization_id=$1 AND id=$2 AND active", [context.organizationId, entityId]);
    if (!entity.rows[0]) throw new Error("Email alias legal entity is unavailable");
  }
  if (connectionId) {
    const expectedModule = purpose === "RECEIVABLES" ? "receivables" : "payables";
    const connection = await client.query<{ owner_module: "payables" | "receivables" }>(
      `SELECT owner_module FROM document_storage_connections
       WHERE organization_id=$1 AND id=$2 AND active
         AND ($3='GENERAL' OR owner_module=$4)`,
      [context.organizationId, connectionId, purpose, expectedModule],
    );
    const selected = connection.rows[0];
    if (!selected) throw new Error("Email alias storage connection is unavailable or belongs to another module");
    await assertActorHasActivePermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: selected.owner_module === "receivables"
        ? PERMISSIONS.manageReceivables
        : PERMISSIONS.managePayables,
    });
  }
}

async function aliasDto(client: PoolClient, row: AliasRow) {
  const address = z.string().parse(await decryptEmailValue(client, row, "email_ingestion_aliases", "address_ciphertext", row.address_ciphertext));
  return {
    id: row.id,
    address,
    label: row.label,
    purpose: row.purpose,
    legalEntityId: row.legal_entity_id,
    connectionId: row.connection_id,
    personal: row.owner_membership_id !== null,
    provider: row.provider,
    status: row.status,
    version: row.version,
    hourlyLimit: row.hourly_limit,
    maxPayloadBytes: row.max_payload_bytes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    retiredAt: row.retired_at?.toISOString() ?? null,
  };
}

export async function listEmailAliases(context: TenantTransactionContext) {
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: PERMISSIONS.readOrganizationSettings,
    });
    const rows = await client.query<AliasRow>(
      "SELECT * FROM email_ingestion_aliases WHERE organization_id=$1 AND owner_membership_id IS NULL ORDER BY created_at,id",
      [context.organizationId],
    );
    return Promise.all(rows.rows.map((row) => aliasDto(client, row)));
  });
}

export async function createEmailAlias(unparsed: ContextCommand & z.input<typeof createEmailAliasSchema>) {
  const command = createEmailAliasSchema.parse(withoutContext(unparsed));
  const idempotencyKey = `email-alias:${canonicalHash(command.idempotencyKey)}`;
  const commandHash = canonicalHash({ ...command, idempotencyKey: undefined });
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    await assertEmailAdministrator(client, unparsed.context);
    const replay = (await client.query<AliasRow>(
      "SELECT * FROM email_ingestion_aliases WHERE organization_id=$1 AND idempotency_key=$2 AND owner_membership_id IS NULL",
      [unparsed.context.organizationId, idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error("Email alias idempotency key was already used with different settings");
      return { alias: await aliasDto(client, replay), idempotentReplay: true };
    }
    await assertEntityAndConnection(client, unparsed.context, command.legalEntityId, command.connectionId, command.purpose);
    const id = randomUUID();
    const address = newInboundAddress();
    const scope = { id, organization_id: unparsed.context.organizationId, key_version: await activeEmailKeyVersion(client, unparsed.context.organizationId) };
    const ciphertext = await encryptEmailValue(client, scope, "email_ingestion_aliases", "address_ciphertext", address);
    const inserted = (await client.query<AliasRow>(
      `INSERT INTO email_ingestion_aliases
       (id,organization_id,legal_entity_id,connection_id,provider,label,purpose,address_digest,address_ciphertext,key_version,status,version,hourly_limit,max_payload_bytes,idempotency_key,command_hash,created_by)
       VALUES ($1,$2,$3,$4,'SELF_SMTP',$5,$6,$7,$8,$9,'ACTIVE',1,$10,$11,$12,$13,$14)
       RETURNING *`,
      [id, unparsed.context.organizationId, command.legalEntityId ?? null, command.connectionId ?? null,
        command.label, command.purpose, addressDigest(address), ciphertext, scope.key_version,
        command.hourlyLimit, command.maxPayloadBytes, idempotencyKey, commandHash, unparsed.context.actorId],
    )).rows[0];
    return { alias: await aliasDto(client, inserted), idempotentReplay: false };
  });
}

export async function updateEmailAlias(unparsed: ContextCommand & z.input<typeof updateEmailAliasSchema>) {
  const command = updateEmailAliasSchema.parse(withoutContext(unparsed));
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    await assertEmailAdministrator(client, unparsed.context);
    const current = (await client.query<AliasRow>(
      "SELECT * FROM email_ingestion_aliases WHERE organization_id=$1 AND id=$2 AND owner_membership_id IS NULL FOR UPDATE",
      [unparsed.context.organizationId, command.aliasId],
    )).rows[0];
    if (!current || current.status === "RETIRED") throw new Error("Email alias is unavailable");
    if (current.version !== command.expectedVersion) throw new Error("Email alias version changed; reload before updating it");
    const purpose = command.purpose ?? current.purpose;
    const legalEntityId = command.legalEntityId === undefined ? current.legal_entity_id : command.legalEntityId;
    const connectionId = command.connectionId === undefined ? current.connection_id : command.connectionId;
    await assertEntityAndConnection(client, unparsed.context, legalEntityId, connectionId, purpose);
    const updated = (await client.query<AliasRow>(
      `UPDATE email_ingestion_aliases SET
         label=$3,purpose=$4,legal_entity_id=$5,connection_id=$6,status=$7,hourly_limit=$8,max_payload_bytes=$9,
         version=version+1,updated_at=now()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [unparsed.context.organizationId, current.id, command.label ?? current.label, purpose,
        legalEntityId, connectionId, command.status ?? current.status,
        command.hourlyLimit ?? current.hourly_limit, command.maxPayloadBytes ?? current.max_payload_bytes],
    )).rows[0];
    return { alias: await aliasDto(client, updated), idempotentReplay: false };
  });
}

export async function rotateEmailAlias(unparsed: ContextCommand & z.input<typeof rotateEmailAliasSchema>) {
  const command = rotateEmailAliasSchema.parse(withoutContext(unparsed));
  const key = `email-alias-rotation:${canonicalHash(command.idempotencyKey)}`;
  const commandHash = canonicalHash({ aliasId: command.aliasId, expectedVersion: command.expectedVersion });
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    await assertEmailAdministrator(client, unparsed.context);
    const replay = (await client.query<AliasRow>(
      "SELECT * FROM email_ingestion_aliases WHERE organization_id=$1 AND idempotency_key=$2 AND owner_membership_id IS NULL",
      [unparsed.context.organizationId, key],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error("Alias rotation idempotency key was already used differently");
      return { alias: await aliasDto(client, replay), idempotentReplay: true };
    }
    const current = (await client.query<AliasRow>(
      "SELECT * FROM email_ingestion_aliases WHERE organization_id=$1 AND id=$2 AND owner_membership_id IS NULL FOR UPDATE",
      [unparsed.context.organizationId, command.aliasId],
    )).rows[0];
    if (!current || current.status === "RETIRED" || current.version !== command.expectedVersion) {
      throw new Error("Alias rotation requires the exact active alias version");
    }
    await assertEntityAndConnection(
      client,
      unparsed.context,
      current.legal_entity_id,
      current.connection_id,
      current.purpose,
    );
    await client.query(
      "UPDATE email_ingestion_aliases SET status='RETIRED',version=version+1,retired_at=now(),updated_at=now() WHERE organization_id=$1 AND id=$2",
      [unparsed.context.organizationId, current.id],
    );
    const id = randomUUID();
    const address = newInboundAddress();
    const scope = { id, organization_id: current.organization_id, key_version: await activeEmailKeyVersion(client, current.organization_id) };
    const ciphertext = await encryptEmailValue(client, scope, "email_ingestion_aliases", "address_ciphertext", address);
    const inserted = (await client.query<AliasRow>(
      `INSERT INTO email_ingestion_aliases
       (id,organization_id,legal_entity_id,connection_id,provider,label,purpose,address_digest,address_ciphertext,key_version,status,version,hourly_limit,max_payload_bytes,idempotency_key,command_hash,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',1,$11,$12,$13,$14,$15) RETURNING *`,
      [id, current.organization_id, current.legal_entity_id, current.connection_id, "SELF_SMTP",
        current.label, current.purpose, addressDigest(address), ciphertext, scope.key_version,
        current.hourly_limit, current.max_payload_bytes, key, commandHash, unparsed.context.actorId],
    )).rows[0];
    return { alias: await aliasDto(client, inserted), retiredAliasId: current.id, idempotentReplay: false };
  });
}


async function assertPersonalAliasMembership(
  client: PoolClient,
  membershipId: string,
): Promise<void> {
  const membership = await client.query<{ allowed: boolean }>(
    "SELECT app.lock_active_email_membership($1) AS allowed",
    [membershipId],
  );
  if (!membership.rows[0]?.allowed) throw new Error("Your organization membership is not active");
}

async function activePersonalAlias(
  client: PoolClient,
  organizationId: string,
  membershipId: string,
  lock = false,
): Promise<AliasRow | undefined> {
  return (await client.query<AliasRow>(
    `SELECT * FROM email_ingestion_aliases
     WHERE organization_id=$1 AND owner_membership_id=$2 AND status='ACTIVE'
     ${lock ? "FOR UPDATE" : ""}`,
    [organizationId, membershipId],
  )).rows[0];
}

export async function getPersonalEmailAlias(
  context: TenantTransactionContext,
  membershipId: string,
) {
  const selectedMembershipId = z.uuid().parse(membershipId);
  return withTenantTransaction(context, async (client) => {
    await assertPersonalAliasMembership(client, selectedMembershipId);
    const row = await activePersonalAlias(client, context.organizationId, selectedMembershipId);
    return row ? aliasDto(client, row) : null;
  });
}

export async function provisionPersonalEmailAlias(
  unparsed: ContextCommand & z.input<typeof provisionPersonalEmailAliasSchema>,
) {
  const command = provisionPersonalEmailAliasSchema.parse(withoutContext(unparsed));
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    assertTenantWritesEnabled(unparsed.context);
    await assertWritableOrganization(client, unparsed.context);
    await assertPersonalAliasMembership(client, command.membershipId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `personal-email-alias:${unparsed.context.organizationId}:${command.membershipId}`,
    ]);
    const current = await activePersonalAlias(client, unparsed.context.organizationId, command.membershipId, true);
    if (current) return { alias: await aliasDto(client, current), idempotentReplay: true };

    await assertEntityAndConnection(client, unparsed.context, null, command.connectionId, "GENERAL");
    const id = randomUUID();
    const address = newInboundAddress();
    const scope = {
      id,
      organization_id: unparsed.context.organizationId,
      key_version: await activeEmailKeyVersion(client, unparsed.context.organizationId),
    };
    const ciphertext = await encryptEmailValue(client, scope, "email_ingestion_aliases", "address_ciphertext", address);
    const idempotencyKey = `personal-email-provision:${canonicalHash(`${command.membershipId}:${id}`)}`;
    const commandHash = canonicalHash({ membershipId: command.membershipId, connectionId: command.connectionId ?? null });
    const inserted = (await client.query<AliasRow>(
      `INSERT INTO email_ingestion_aliases
       (id,organization_id,owner_membership_id,connection_id,provider,label,purpose,address_digest,address_ciphertext,key_version,status,version,hourly_limit,max_payload_bytes,idempotency_key,command_hash,created_by)
       VALUES ($1,$2,$3,$4,'SELF_SMTP','Personal document inbox','GENERAL',$5,$6,$7,'ACTIVE',1,25,$8,$9,$10,$11)
       RETURNING *`,
      [id, unparsed.context.organizationId, command.membershipId, command.connectionId ?? null,
        addressDigest(address), ciphertext, scope.key_version, 10 * 1024 * 1024,
        idempotencyKey, commandHash, unparsed.context.actorId],
    )).rows[0];
    return { alias: await aliasDto(client, inserted), idempotentReplay: false };
  });
}

export async function configurePersonalEmailAlias(
  unparsed: ContextCommand & z.input<typeof configurePersonalEmailAliasSchema>,
) {
  const command = configurePersonalEmailAliasSchema.parse(withoutContext(unparsed));
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    assertTenantWritesEnabled(unparsed.context);
    await assertWritableOrganization(client, unparsed.context);
    await assertPersonalAliasMembership(client, command.membershipId);
    const current = await activePersonalAlias(client, unparsed.context.organizationId, command.membershipId, true);
    if (!current || current.id !== command.aliasId || current.version !== command.expectedVersion) {
      throw new Error("Personal email address changed; reload before updating storage");
    }
    await assertEntityAndConnection(client, unparsed.context, null, command.connectionId, "GENERAL");
    const updated = (await client.query<AliasRow>(
      `UPDATE email_ingestion_aliases SET connection_id=$4,version=version+1,updated_at=now()
       WHERE organization_id=$1 AND id=$2 AND owner_membership_id=$3 RETURNING *`,
      [unparsed.context.organizationId, current.id, command.membershipId, command.connectionId],
    )).rows[0];
    return { alias: await aliasDto(client, updated), idempotentReplay: false };
  });
}

export async function rotatePersonalEmailAlias(
  unparsed: ContextCommand & z.input<typeof rotatePersonalEmailAliasSchema>,
) {
  const command = rotatePersonalEmailAliasSchema.parse(withoutContext(unparsed));
  const key = `personal-email-rotation:${canonicalHash(command.idempotencyKey)}`;
  const commandHash = canonicalHash({
    membershipId: command.membershipId,
    aliasId: command.aliasId,
    expectedVersion: command.expectedVersion,
  });
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    assertTenantWritesEnabled(unparsed.context);
    await assertWritableOrganization(client, unparsed.context);
    await assertPersonalAliasMembership(client, command.membershipId);
    const replay = (await client.query<AliasRow>(
      `SELECT * FROM email_ingestion_aliases
       WHERE organization_id=$1 AND owner_membership_id=$2 AND idempotency_key=$3`,
      [unparsed.context.organizationId, command.membershipId, key],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error("Personal address rotation key was already used differently");
      return { alias: await aliasDto(client, replay), idempotentReplay: true };
    }
    const current = await activePersonalAlias(client, unparsed.context.organizationId, command.membershipId, true);
    if (!current || current.id !== command.aliasId || current.version !== command.expectedVersion) {
      throw new Error("Personal address rotation requires the exact active version");
    }
    await assertEntityAndConnection(client, unparsed.context, null, current.connection_id, "GENERAL");
    await client.query(
      `UPDATE email_ingestion_aliases SET status='RETIRED',version=version+1,retired_at=now(),updated_at=now()
       WHERE organization_id=$1 AND id=$2 AND owner_membership_id=$3`,
      [unparsed.context.organizationId, current.id, command.membershipId],
    );
    const id = randomUUID();
    const address = newInboundAddress();
    const scope = {
      id,
      organization_id: current.organization_id,
      key_version: await activeEmailKeyVersion(client, current.organization_id),
    };
    const ciphertext = await encryptEmailValue(client, scope, "email_ingestion_aliases", "address_ciphertext", address);
    const inserted = (await client.query<AliasRow>(
      `INSERT INTO email_ingestion_aliases
       (id,organization_id,owner_membership_id,legal_entity_id,connection_id,provider,label,purpose,address_digest,address_ciphertext,key_version,status,version,hourly_limit,max_payload_bytes,idempotency_key,command_hash,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',1,$12,$13,$14,$15,$16) RETURNING *`,
      [id, current.organization_id, command.membershipId, current.legal_entity_id, current.connection_id,
        "SELF_SMTP", current.label, current.purpose, addressDigest(address), ciphertext, scope.key_version,
        current.hourly_limit, current.max_payload_bytes, key, commandHash, unparsed.context.actorId],
    )).rows[0];
    return { alias: await aliasDto(client, inserted), retiredAliasId: current.id, idempotentReplay: false };
  });
}

type BookingRuleRow = Readonly<{
  id: string; name: string; version: number; priority: number; active: boolean;
  mode: "REVIEW_ONLY" | "CREATE_DRAFT" | "AUTO_POST"; conditions: unknown; action: unknown;
  created_by: string; created_at: Date;
}>;
export async function listEmailBookingRules(context: TenantTransactionContext) {
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, { organizationId: context.organizationId, actorId: context.actorId, permission: PERMISSIONS.readOrganizationSettings });
    return (await client.query<BookingRuleRow>(
      `SELECT id,name,version,priority,active,mode,conditions,action,created_by,created_at
       FROM email_booking_rules WHERE organization_id=$1 ORDER BY priority,name,version DESC`, [context.organizationId],
    )).rows.map((row) => ({ ...row, createdAt: row.created_at.toISOString(), created_at: undefined }));
  });
}

export async function upsertEmailBookingRule(unparsed: ContextCommand & z.input<typeof upsertEmailBookingRuleSchema>) {
  const command = upsertEmailBookingRuleSchema.parse(withoutContext(unparsed));
  const key = `email-booking-rule:${canonicalHash(command.idempotencyKey)}`;
  const hash = canonicalHash(command);
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    await assertEmailAdministrator(client, unparsed.context);
    const replay = (await client.query<BookingRuleRow & { command_hash: string }>(
      "SELECT * FROM email_booking_rules WHERE organization_id=$1 AND idempotency_key=$2",
      [unparsed.context.organizationId, key],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== hash) throw new Error("Booking-rule idempotency key was already used differently");
      return { rule: replay, idempotentReplay: true };
    }
    let version = 1;
    if (command.ruleId) {
      const prior = (await client.query<BookingRuleRow>(
        "SELECT * FROM email_booking_rules WHERE organization_id=$1 AND id=$2 FOR SHARE",
        [unparsed.context.organizationId, command.ruleId],
      )).rows[0];
      if (!prior || command.expectedVersion !== prior.version) throw new Error("Booking rule version changed; reload before updating it");
      if (prior.name !== command.name) throw new Error("A booking-rule version cannot change the rule identity");
      version = prior.version + 1;
    }
    const inserted = (await client.query<BookingRuleRow>(
      `INSERT INTO email_booking_rules
       (organization_id,name,version,priority,active,mode,conditions,action,idempotency_key,command_hash,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [unparsed.context.organizationId, command.name, version, command.priority, command.active,
        command.mode, command.conditions, command.action, key, hash, unparsed.context.actorId],
    )).rows[0];
    return { rule: inserted, idempotentReplay: false };
  });
}

type PaymentProfileRow = Readonly<{
  id: string; organization_id: string; legal_entity_id: string; currency_code: string; name: string;
  version: number; active: boolean; is_default: boolean; details_ciphertext: string;
  masked_summary: Record<string, unknown>; key_version: number; effective_from: string; effective_to: string | null;
  retired_at: Date | null; command_hash: string; created_by: string; created_at: Date;
}>;

function lastFour(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, "");
  return compact.length <= 4 ? "••••" : `••••${compact.slice(-4)}`;
}
export function maskedPaymentDetails(unparsed: unknown): Record<string, unknown> {
  const details = paymentInstructionDetailsSchema.parse(unparsed);
  return {
    beneficiaryName: details.beneficiaryName,
    bankName: details.bankName,
    institutionNumber: lastFour(details.institutionNumber),
    transitNumber: lastFour(details.transitNumber),
    accountNumber: lastFour(details.accountNumber),
    routingNumber: lastFour(details.routingNumber),
    swiftBic: lastFour(details.swiftBic),
    iban: lastFour(details.iban),
    remittanceEmail: details.remittanceEmail,
    acceptedMethods: details.acceptedMethods,
    paymentReferenceWording: details.paymentReferenceWording,
  };
}

function paymentProfileDto(row: PaymentProfileRow) {
  return {
    id: row.id, legalEntityId: row.legal_entity_id, currencyCode: row.currency_code, name: row.name,
    version: row.version, active: row.active, isDefault: row.is_default, details: row.masked_summary,
    effectiveFrom: row.effective_from, effectiveTo: row.effective_to,
    retiredAt: row.retired_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(),
  };
}

export async function listPaymentProfiles(context: TenantTransactionContext) {
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, { organizationId: context.organizationId, actorId: context.actorId, permission: PERMISSIONS.readOrganizationSettings });
    const rows = await client.query<PaymentProfileRow>(
      "SELECT *,effective_from::text,effective_to::text FROM payment_instruction_profiles WHERE organization_id=$1 ORDER BY name,version DESC",
      [context.organizationId],
    );
    return rows.rows.map(paymentProfileDto);
  });
}

export async function savePaymentProfile(unparsed: ContextCommand & z.input<typeof savePaymentProfileSchema>) {
  const command = savePaymentProfileSchema.parse(withoutContext(unparsed));
  const key = `payment-profile:${canonicalHash(command.idempotencyKey)}`;
  const hash = canonicalHash(command);
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    await assertEmailAdministrator(client, unparsed.context);
    const replay = (await client.query<PaymentProfileRow>(
      "SELECT *,effective_from::text,effective_to::text FROM payment_instruction_profiles WHERE organization_id=$1 AND idempotency_key=$2",
      [unparsed.context.organizationId, key],
    )).rows[0];
    if (replay) {
      if (replay.command_hash !== hash) throw new Error("Payment-profile idempotency key was already used differently");
      return { profile: paymentProfileDto(replay), idempotentReplay: true };
    }
    const entity = await client.query("SELECT 1 FROM legal_entities WHERE organization_id=$1 AND id=$2 AND active", [unparsed.context.organizationId, command.legalEntityId]);
    if (!entity.rows[0]) throw new Error("Payment profile legal entity is unavailable");
    let version = 1;
    if (command.profileId) {
      const prior = (await client.query<PaymentProfileRow>(
        "SELECT *,effective_from::text,effective_to::text FROM payment_instruction_profiles WHERE organization_id=$1 AND id=$2 FOR SHARE",
        [unparsed.context.organizationId, command.profileId],
      )).rows[0];
      if (!prior || prior.version !== command.expectedVersion || !prior.active) throw new Error("Payment profile version changed or was retired");
      if (prior.legal_entity_id !== command.legalEntityId
        || prior.currency_code !== command.currencyCode
        || prior.name !== command.name) {
        throw new Error("A payment-profile version cannot change the profile identity");
      }
      version = prior.version + 1;
    }
    if (command.isDefault) {
      await client.query(
        "UPDATE payment_instruction_profiles SET is_default=false WHERE organization_id=$1 AND legal_entity_id=$2 AND currency_code=$3 AND active",
        [unparsed.context.organizationId, command.legalEntityId, command.currencyCode],
      );
    }
    const id = randomUUID();
    const scope = { id, organization_id: unparsed.context.organizationId, key_version: await activeEmailKeyVersion(client, unparsed.context.organizationId) };
    const ciphertext = await encryptEmailValue(client, scope, "payment_instruction_profiles", "details_ciphertext", command.details);
    const inserted = (await client.query<PaymentProfileRow>(
      `INSERT INTO payment_instruction_profiles
       (id,organization_id,legal_entity_id,currency_code,name,version,active,is_default,details_ciphertext,masked_summary,key_version,effective_from,effective_to,idempotency_key,command_hash,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *,effective_from::text,effective_to::text`,
      [id, unparsed.context.organizationId, command.legalEntityId, command.currencyCode, command.name, version,
        command.isDefault, ciphertext, maskedPaymentDetails(command.details), scope.key_version,
        command.effectiveFrom, command.effectiveTo ?? null, key, hash, unparsed.context.actorId],
    )).rows[0];
    return { profile: paymentProfileDto(inserted), idempotentReplay: false };
  });
}

export async function retirePaymentProfile(unparsed: ContextCommand & z.input<typeof retirePaymentProfileSchema>) {
  const command = retirePaymentProfileSchema.parse(withoutContext(unparsed));
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    await assertEmailAdministrator(client, unparsed.context);
    const current = (await client.query<PaymentProfileRow>(
      "SELECT *,effective_from::text,effective_to::text FROM payment_instruction_profiles WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [unparsed.context.organizationId, command.profileId],
    )).rows[0];
    if (!current || current.version !== command.expectedVersion) throw new Error("Payment profile version changed; reload before retiring it");
    if (!current.active) return { profile: paymentProfileDto(current), idempotentReplay: true };
    const updated = (await client.query<PaymentProfileRow>(
      `UPDATE payment_instruction_profiles SET active=false,is_default=false,retired_at=now()
       WHERE organization_id=$1 AND id=$2 RETURNING *,effective_from::text,effective_to::text`,
      [unparsed.context.organizationId, current.id],
    )).rows[0];
    return { profile: paymentProfileDto(updated), idempotentReplay: false };
  });
}

type PreferenceRow = Readonly<{
  id: string; organization_id: string; party_account_id: string; version: number;
  preferences_ciphertext: string; key_version: number; delivery_method: "EMAIL" | "MANUAL";
  auto_send_on_issue: boolean; payment_profile_id: string | null;
  suppression_status: "NONE" | "HARD_BOUNCE" | "COMPLAINT"; updated_by: string; updated_at: Date;
}>;

async function preferenceDto(client: PoolClient, row: PreferenceRow) {
  const preferences = await decryptEmailValue(client, row, "customer_delivery_preferences", "preferences_ciphertext", row.preferences_ciphertext);
  return {
    id: row.id, partyAccountId: row.party_account_id, version: row.version,
    ...z.record(z.string(), z.unknown()).parse(preferences),
    deliveryMethod: row.delivery_method, autoSendOnIssue: row.auto_send_on_issue,
    paymentProfileId: row.payment_profile_id, suppressionStatus: row.suppression_status,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getCustomerDeliveryPreference(context: TenantTransactionContext, partyAccountId: string) {
  const id = z.uuid().parse(partyAccountId);
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, { organizationId: context.organizationId, actorId: context.actorId, permission: PERMISSIONS.readReceivables });
    const row = (await client.query<PreferenceRow>(
      "SELECT * FROM customer_delivery_preferences WHERE organization_id=$1 AND party_account_id=$2",
      [context.organizationId, id],
    )).rows[0];
    return row ? preferenceDto(client, row) : null;
  });
}

export async function saveCustomerDeliveryPreference(unparsed: ContextCommand & z.input<typeof customerDeliveryPreferenceSchema>) {
  const command = customerDeliveryPreferenceSchema.parse(withoutContext(unparsed));
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    assertTenantWritesEnabled(unparsed.context);
    await assertWritableOrganization(client, unparsed.context);
    await assertActorHasActivePermission(client, { organizationId: unparsed.context.organizationId, actorId: unparsed.context.actorId, permission: PERMISSIONS.manageReceivables });
    const account = await client.query("SELECT 1 FROM party_accounts WHERE organization_id=$1 AND id=$2 AND role='CUSTOMER' AND active", [unparsed.context.organizationId, command.partyAccountId]);
    if (!account.rows[0]) throw new Error("Customer account is unavailable");
    if (command.paymentProfileId) {
      const profile = await client.query("SELECT 1 FROM payment_instruction_profiles WHERE organization_id=$1 AND id=$2 AND active", [unparsed.context.organizationId, command.paymentProfileId]);
      if (!profile.rows[0]) throw new Error("Payment profile is unavailable or retired");
    }
    const current = (await client.query<PreferenceRow>(
      "SELECT * FROM customer_delivery_preferences WHERE organization_id=$1 AND party_account_id=$2 FOR UPDATE",
      [unparsed.context.organizationId, command.partyAccountId],
    )).rows[0];
    if (current && command.expectedVersion !== current.version) throw new Error("Customer delivery preference version changed; reload before updating it");
    if (!current && command.expectedVersion !== undefined && command.expectedVersion !== 0) throw new Error("Customer delivery preference does not exist at the requested version");
    const id = current?.id ?? randomUUID();
    const scope = { id, organization_id: unparsed.context.organizationId, key_version: current?.key_version ?? await activeEmailKeyVersion(client, unparsed.context.organizationId) };
    const safePreferences = {
      billingRecipients: command.billingRecipients,
      ccRecipients: command.ccRecipients,
      preferredLanguage: command.preferredLanguage,
      templateKey: command.templateKey,
      purchaseOrderRequired: command.purchaseOrderRequired,
      remittanceContact: command.remittanceContact,
    };
    const ciphertext = await encryptEmailValue(client, scope, "customer_delivery_preferences", "preferences_ciphertext", safePreferences);
    const suppression = command.reenableSuppressedRecipients ? "NONE" : current?.suppression_status ?? "NONE";
    const saved = current
      ? (await client.query<PreferenceRow>(
          `UPDATE customer_delivery_preferences SET version=version+1,preferences_ciphertext=$3,key_version=$4,
             delivery_method=$5,auto_send_on_issue=$6,payment_profile_id=$7,suppression_status=$8,updated_by=$9,updated_at=now()
           WHERE organization_id=$1 AND id=$2 RETURNING *`,
          [unparsed.context.organizationId, id, ciphertext, scope.key_version, command.deliveryMethod,
            command.autoSendOnIssue, command.paymentProfileId ?? null, suppression, unparsed.context.actorId],
        )).rows[0]
      : (await client.query<PreferenceRow>(
          `INSERT INTO customer_delivery_preferences
           (id,organization_id,party_account_id,version,preferences_ciphertext,key_version,delivery_method,auto_send_on_issue,payment_profile_id,suppression_status,updated_by)
           VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [id, unparsed.context.organizationId, command.partyAccountId, ciphertext, scope.key_version,
            command.deliveryMethod, command.autoSendOnIssue, command.paymentProfileId ?? null, suppression, unparsed.context.actorId],
        )).rows[0];
    return { preference: await preferenceDto(client, saved), idempotentReplay: false };
  });
}

type DeliverySettingsRow = Readonly<{
  id: string; organization_id: string; version: number; outbound_enabled: boolean;
  auto_send_enabled: boolean; transient_retention_days: number;
  quarantine_retention_days: number; operation_retention_days: number;
  updated_by: string; updated_at: Date;
}>;
function deliverySettingsDto(row: DeliverySettingsRow | undefined) {
  return row ? {
    id: row.id, version: row.version, outboundEnabled: row.outbound_enabled,
    autoSendEnabled: row.auto_send_enabled, transientRetentionDays: row.transient_retention_days,
    quarantineRetentionDays: row.quarantine_retention_days,
    operationRetentionDays: row.operation_retention_days, updatedAt: row.updated_at.toISOString(),
  } : {
    id: null, version: 0, outboundEnabled: false, autoSendEnabled: false,
    transientRetentionDays: 30, quarantineRetentionDays: 30, operationRetentionDays: 90,
    updatedAt: null,
  };
}

export async function getEmailDeliverySettings(context: TenantTransactionContext) {
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, { organizationId: context.organizationId, actorId: context.actorId, permission: PERMISSIONS.readOrganizationSettings });
    const row = (await client.query<DeliverySettingsRow>(
      "SELECT * FROM email_delivery_settings WHERE organization_id=$1", [context.organizationId],
    )).rows[0];
    return deliverySettingsDto(row);
  });
}

export async function saveEmailDeliverySettings(unparsed: ContextCommand & z.input<typeof emailDeliverySettingsSchema>) {
  const command = emailDeliverySettingsSchema.parse(withoutContext(unparsed));
  return withTenantTransaction({ ...unparsed.context, reason: command.reason }, async (client) => {
    await assertEmailAdministrator(client, unparsed.context);
    const current = (await client.query<DeliverySettingsRow>(
      "SELECT * FROM email_delivery_settings WHERE organization_id=$1 FOR UPDATE", [unparsed.context.organizationId],
    )).rows[0];
    if ((current?.version ?? 0) !== command.expectedVersion) throw new Error("Email delivery settings changed; reload before updating them");
    const saved = current
      ? (await client.query<DeliverySettingsRow>(
          `UPDATE email_delivery_settings SET version=version+1,outbound_enabled=$2,auto_send_enabled=$3,
             transient_retention_days=$4,quarantine_retention_days=$5,operation_retention_days=$6,
             updated_by=$7,updated_at=now() WHERE organization_id=$1 RETURNING *`,
          [unparsed.context.organizationId, command.outboundEnabled, command.autoSendEnabled,
            command.transientRetentionDays, command.quarantineRetentionDays, command.operationRetentionDays,
            unparsed.context.actorId],
        )).rows[0]
      : (await client.query<DeliverySettingsRow>(
          `INSERT INTO email_delivery_settings
           (organization_id,version,outbound_enabled,auto_send_enabled,transient_retention_days,quarantine_retention_days,operation_retention_days,updated_by)
           VALUES ($1,1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [unparsed.context.organizationId, command.outboundEnabled, command.autoSendEnabled,
            command.transientRetentionDays, command.quarantineRetentionDays, command.operationRetentionDays,
            unparsed.context.actorId],
        )).rows[0];
    return { settings: deliverySettingsDto(saved) };
  });
}

export function emailProviderReadiness() {
  const secrets = emailSecretReadiness();
  const routing = inboundEmailRouting();
  return {
    inbound: Boolean(secrets.inboundRelay && routing),
    outbound: Boolean(secrets.apiKey && secrets.outboundWebhook && outboundDomain()),
    inboundDomain: routing?.domain ?? null,
    outboundDomain: outboundDomain(),
  };
}

export async function loadPaymentProfileDetails(client: PoolClient, organizationId: string, profileId: string) {
  const row = (await client.query<PaymentProfileRow>(
    "SELECT *,effective_from::text,effective_to::text FROM payment_instruction_profiles WHERE organization_id=$1 AND id=$2",
    [organizationId, profileId],
  )).rows[0];
  if (!row || !row.active) throw new Error("Payment profile is unavailable or retired");
  const details = paymentInstructionDetailsSchema.parse(await decryptEmailValue(client, row, "payment_instruction_profiles", "details_ciphertext", row.details_ciphertext));
  return { row, details };
}
