import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import type { SessionPrincipal } from "@/modules/identity/session";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { assertPermission, permissionForOwner } from "@/modules/subledger/ar-ap-access";
import { canonicalHash } from "@/modules/subledger/document-model";
import { mutationContext } from "@/modules/workspace/write-policy";
import { oauthPublicOrigin } from "@/modules/mcp/protocol";
import { storageAccessPolicy } from "./access-policy";
import { assertStorageRoot } from "./boundaries";
import { startStorageConnection } from "./connections";
import { approveStorageSetupSchema, prepareStorageSetupSchema, safeFilenamePart } from "./model";
import { credentialSchema, providerConfiguration, StorageError } from "./provider";
import { activeKeyVersion, assertStorageWrite, connectedDrive, connectionLocation, encryptStorageValue, loadConnection, prepareConnectedDrive, realStorageContext, type ConnectionRow } from "./store";

type SetupRow = ConnectionRow & {
  setup_key: string | null; setup_hash: string | null; reuse_connection_id: string | null;
  sharing_consent_ciphertext: string | null;
};
async function authorizeSetup(client: PoolClient, context: TenantTransactionContext, row: ConnectionRow) {
  realStorageContext(context);
  await assertPermission(client, context, PERMISSIONS.manageOrganizationSettings);
  await assertPermission(client, context, permissionForOwner(row.owner_module, "manage"));
  const entity = await client.query("SELECT id FROM legal_entities WHERE organization_id=$1 AND id=$2 AND active", [context.organizationId, row.legal_entity_id]);
  if (!entity.rows[0]) throw new StorageError("STORAGE_ENTITY_INVALID", "Select an active company in this organization.");
}
async function loadSetup(client: PoolClient, context: TenantTransactionContext, connectionId: string) {
  const row = await loadConnection(client, context, z.uuid().parse(connectionId), "admin", false) as SetupRow;
  await authorizeSetup(client, context, row);
  if (!row.setup_hash || row.created_by !== context.actorId) throw new StorageError("STORAGE_SETUP_UNAVAILABLE", "This setup request belongs to another user or is unavailable. Prepare a request from your own connection.");
  return row;
}
async function setupResult(client: PoolClient, row: SetupRow) {
  const location = row.active ? await connectionLocation(client, row) : null;
  const entity = (await client.query<{ display_name: string }>("SELECT display_name FROM legal_entities WHERE organization_id=$1 AND id=$2", [row.organization_id, row.legal_entity_id])).rows[0];
  return {
    connectionId: row.id, statusHandle: row.id, provider: row.provider, legalEntityId: row.legal_entity_id,
    company: entity?.display_name ?? "Company", module: row.owner_module, label: row.label,
    status: row.active ? "READY" as const : row.sharing_consent_ciphertext ? "CONNECTION_REQUIRED" as const : "USER_APPROVAL_REQUIRED" as const,
    expectedSetupHash: row.setup_hash, access: storageAccessPolicy(row.provider),
    providerScopes: row.provider === "ONEDRIVE" ? ["offline_access", "Files.ReadWrite.AppFolder"] : [],
    sharing: { legalEntityId: row.legal_entity_id, module: row.owner_module, audience: "Organization members authorized for this company and accounting module", approved: Boolean(row.sharing_consent_ciphertext) },
    reuseConnectionId: row.reuse_connection_id,
    handoffUrl: new URL(`/app/settings/documents/setup/${row.id}`, oauthPublicOrigin()).href,
    inboxUrl: location?.inboxUrl ?? null, archiveUrl: location?.archiveUrl ?? null,
    instruction: row.active ? "Use this connectionId to upload, sync, claim, read and complete documents for the selected module." : "The requesting user must open the handoff URL, review the exact company/module sharing scope and approve. Then poll this status handle. Never supply provider credentials to MCP.",
  };
}
export async function prepareStorageSetup(context: TenantTransactionContext, input: z.input<typeof prepareStorageSetupSchema>) {
  const command = prepareStorageSetupSchema.parse(input);
  if (!storageAccessPolicy(command.provider).newConnections) throw new StorageError("STORAGE_AUTHORIZATION_UNSUPPORTED", storageAccessPolicy(command.provider).limitation);
  providerConfiguration(command.provider);
  const setupKey = canonicalHash(command.idempotencyKey), setupHash = canonicalHash(command);
  return withTenantTransaction(context, async (client) => {
    await assertStorageWrite(client, context);
    await assertPermission(client, context, PERMISSIONS.manageOrganizationSettings);
    await assertPermission(client, context, permissionForOwner(command.module, "manage"));
    const entity = await client.query("SELECT id FROM legal_entities WHERE organization_id=$1 AND id=$2 AND active", [context.organizationId, command.legalEntityId]);
    if (!entity.rows[0]) throw new StorageError("STORAGE_ENTITY_INVALID", "Select an active company in this organization.");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`storage-setup:${context.organizationId}`]);
    const replay = (await client.query<SetupRow>("SELECT * FROM document_storage_connections WHERE organization_id=$1 AND created_by=$2 AND setup_key=$3", [context.organizationId, context.actorId, setupKey])).rows[0];
    if (replay) {
      if (replay.setup_hash !== setupHash) throw new StorageError("STORAGE_SETUP_CONFLICT", "This setup key was used for another request. Retry identical arguments or use a new key for a new scope.");
      return { ...await setupResult(client, replay), idempotentReplay: true };
    }
    if (command.reuseConnectionId) {
      const donor = await loadConnection(client, context, command.reuseConnectionId, "admin");
      await assertPermission(client, context, permissionForOwner(donor.owner_module, "manage"));
      if (donor.provider !== "ONEDRIVE" || donor.provider !== command.provider || donor.legal_entity_id !== command.legalEntityId || donor.created_by !== context.actorId) {
        throw new StorageError("STORAGE_GRANT_REUSE_DENIED", "Reuse requires your own active OneDrive app-folder connection for the same company. Choose browser authorization otherwise.");
      }
    }
    const duplicate = (await client.query<SetupRow>(`SELECT * FROM document_storage_connections WHERE organization_id=$1 AND legal_entity_id=$2 AND owner_module=$3 AND provider=$4 AND lower(label)=lower($5)`, [context.organizationId, command.legalEntityId, command.module, command.provider, command.label])).rows[0];
    if (duplicate) throw new StorageError("STORAGE_CONNECTION_EXISTS", `A connection with this company, module, provider and label already exists. Use connection ${duplicate.id} or choose a distinct label only for a separate inbox.`);
    const count = (await client.query<{ count: string }>("SELECT count(*) FROM document_storage_connections WHERE organization_id=$1", [context.organizationId])).rows[0];
    if (Number(count.count) >= 20) throw new StorageError("STORAGE_CONNECTION_LIMIT", "Reconnect an existing storage connection; this organization has reached its connection limit.");
    const row = (await client.query<SetupRow>(`INSERT INTO document_storage_connections
      (organization_id,legal_entity_id,owner_module,provider,label,key_version,created_by,setup_key,setup_hash,reuse_connection_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [context.organizationId, command.legalEntityId, command.module, command.provider, command.label, await activeKeyVersion(client, context.organizationId), context.actorId, setupKey, setupHash, command.reuseConnectionId ?? null])).rows[0];
    return { ...await setupResult(client, row), idempotentReplay: false };
  });
}
export async function getStorageSetup(context: TenantTransactionContext, connectionId: string) {
  return withTenantTransaction(context, async (client) => setupResult(client, await loadSetup(client, context, connectionId)));
}
export async function approveStorageSetup(principal: SessionPrincipal, input: z.input<typeof approveStorageSetupSchema>) {
  const command = approveStorageSetupSchema.parse(input);
  if (principal.sessionMode !== "real" || principal.mcpConnectionId) throw new StorageError("STORAGE_USER_CONSENT_REQUIRED", "Open the handoff in your signed-in browser to approve module sharing.");
  const context = mutationContext(principal, randomUUID(), { reason: "Approve company and module document sharing", sourceSurface: "UI" });
  // Record consent durably before any external folders or grant reuse occurs.
  const approved = await withTenantTransaction(context, async (client) => {
    await assertStorageWrite(client, context);
    const row = await loadSetup(client, context, command.connectionId);
    if (row.setup_hash !== command.expectedSetupHash) throw new StorageError("STORAGE_SETUP_CHANGED", "This setup request changed. Reload and review the company and sharing scope.");
    if (!row.sharing_consent_ciphertext) {
      const ciphertext = await encryptStorageValue(client, row, "document_storage_connections", "sharing_consent_ciphertext", {
        version: 1, approvedBy: context.actorId, sessionId: context.sessionId, approvedAt: new Date().toISOString(),
        legalEntityId: row.legal_entity_id, module: row.owner_module, provider: row.provider,
        providerScopes: ["offline_access", "Files.ReadWrite.AppFolder"], sharedWithOrganization: true,
        accessAcknowledged: true, reuseConnectionId: row.reuse_connection_id, setupHash: row.setup_hash,
      });
      await client.query("UPDATE document_storage_connections SET sharing_consent_ciphertext=$3 WHERE organization_id=$1 AND id=$2", [context.organizationId, row.id, ciphertext]);
      row.sharing_consent_ciphertext = ciphertext;
    }
    return row;
  });
  if (approved.active) return getStorageSetup(context, approved.id);
  if (approved.reuse_connection_id) {
    try {
      return await withTenantTransaction(context, async (client) => {
        await assertStorageWrite(client, context);
        const target = await loadSetup(client, context, approved.id);
        if (target.active) return setupResult(client, target);
        const donor = await loadConnection(client, context, approved.reuse_connection_id!, "admin");
        await assertPermission(client, context, permissionForOwner(donor.owner_module, "manage"));
        if (donor.provider !== "ONEDRIVE" || donor.legal_entity_id !== target.legal_entity_id || donor.created_by !== context.actorId) throw new StorageError("STORAGE_GRANT_REUSE_DENIED", "The original grant is no longer eligible for this setup.");
        const { drive, location: original } = await connectedDrive(client, donor);
        await assertStorageRoot(drive, original);
        const location = await drive.provision(`FinLynQ-${safeFilenamePart(target.label, 45)}-${target.id}`);
        if (location.accountId !== original.accountId || location.driveId !== original.driveId) throw new StorageError("STORAGE_ACCOUNT_MISMATCH", "Grant reuse must retain the original OneDrive account.");
        await assertStorageRoot(drive, location);
        const currentDonor = await loadConnection(client, context, donor.id, "admin");
        const { credentials } = await prepareConnectedDrive(client, currentDonor);
        const config = await encryptStorageValue(client, target, "document_storage_connections", "config_ciphertext", location);
        const secrets = await encryptStorageValue(client, target, "document_storage_connections", "credentials_ciphertext", credentialSchema.parse(credentials));
        const saved = (await client.query<SetupRow>("UPDATE document_storage_connections SET active=true,config_ciphertext=$3,credentials_ciphertext=$4,oauth_state_hash=NULL WHERE organization_id=$1 AND id=$2 RETURNING *", [context.organizationId, target.id, config, secrets])).rows[0];
        return setupResult(client, saved);
      });
    } catch (error) {
      // Consent remains recorded. Renew only the same narrow grant in a browser.
      if (!(error instanceof StorageError) || !["STORAGE_RECONNECT", "STORAGE_DISCONNECTED"].includes(error.code)) throw error;
    }
  }
  const handoff = await startStorageConnection(principal, {
    connectionId: approved.id, provider: approved.provider, legalEntityId: approved.legal_entity_id,
    module: approved.owner_module, label: approved.label, sharedWithOrganization: true, accessAcknowledged: true,
  });
  return { ...await getStorageSetup(context, approved.id), ...handoff };
}
