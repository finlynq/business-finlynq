import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import type { SessionPrincipal } from "@/modules/identity/session";
import { mutationContext } from "@/modules/workspace/write-policy";
import { assertPermission } from "@/modules/subledger/ar-ap-access";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { connectStorageSchema, providerSchema, safeFilenamePart, type StorageProvider } from "./model";
import { CloudDrive, exchangeStorageToken, providerConfiguration, StorageError } from "./provider";
import { activeKeyVersion, assertStorageWrite, connectionLocation, decryptStorageValue, encryptStorageValue, loadConnection, realStorageContext, type ConnectionRow } from "./store";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function startStorageConnection(principal: SessionPrincipal, input: z.input<typeof connectStorageSchema>) {
  const command = connectStorageSchema.parse(input);
  const config = providerConfiguration(command.provider);
  const context = mutationContext(principal, randomUUID(), { reason: "Authorize shared document storage" });
  const state = randomBytes(32).toString("base64url"); const verifier = randomBytes(48).toString("base64url");
  await withTenantTransaction(context, async (client) => {
    await assertStorageWrite(client, context); await assertPermission(client, context, PERMISSIONS.manageOrganizationSettings);
    let connection: ConnectionRow;
    if (command.connectionId) {
      connection = await loadConnection(client, context, command.connectionId, "admin", false);
      if (connection.provider !== command.provider || connection.legal_entity_id !== command.legalEntityId || connection.owner_module !== command.module) throw new StorageError("STORAGE_CONNECTION_CHANGED", "Reconnect using the existing provider, company, and module.");
    } else {
      const entity = await client.query("SELECT id FROM legal_entities WHERE organization_id=$1 AND id=$2 AND active", [context.organizationId, command.legalEntityId]);
      if (!entity.rows[0]) throw new StorageError("STORAGE_ENTITY_INVALID", "Select an active company in this organization.");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`storage-setup:${context.organizationId}`]);
      const count = (await client.query<{ count: string }>("SELECT count(*) FROM document_storage_connections WHERE organization_id=$1", [context.organizationId])).rows[0];
      if (Number(count.count) >= 20) throw new StorageError("STORAGE_CONNECTION_LIMIT", "Reconnect an existing storage connection; this organization has reached its connection limit.");
      connection = (await client.query<ConnectionRow>(`INSERT INTO document_storage_connections
        (organization_id,legal_entity_id,owner_module,provider,label,key_version,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [context.organizationId, command.legalEntityId, command.module, command.provider, command.label, await activeKeyVersion(client, context.organizationId), context.actorId])).rows[0];
    }
    // A new attempt invalidates earlier browser handoffs from this session.
    await client.query("UPDATE document_storage_connections SET oauth_state_hash=$3 WHERE organization_id=$1 AND id=$2", [context.organizationId, connection.id, hash(state)]);
    await client.query("UPDATE document_storage_oauth SET consumed_at=now() WHERE organization_id=$1 AND connection_id=$2 AND session_id=$3 AND consumed_at IS NULL", [context.organizationId, connection.id, context.sessionId]);
    const oauth = { id: randomUUID(), organization_id: context.organizationId, key_version: connection.key_version };
    const ciphertext = await encryptStorageValue(client, oauth, "document_storage_oauth", "verifier_ciphertext", verifier);
    await client.query(`INSERT INTO document_storage_oauth(id,organization_id,connection_id,actor_id,session_id,state_hash,verifier_ciphertext,key_version,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes')`, [oauth.id, context.organizationId, connection.id, context.actorId, context.sessionId, hash(state), ciphertext, oauth.key_version]);
  });
  const url = new URL(config.authorizationUrl);
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: config.scope, state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: command.provider === "GOOGLE_DRIVE" ? "consent select_account" : "select_account",
    ...(command.provider === "GOOGLE_DRIVE" ? { access_type: "offline" } : {}) }).toString();
  return { authorizationUrl: url.href };
}
export async function finishStorageConnection(principal: SessionPrincipal, provider: StorageProvider, state: string, code: string) {
  providerSchema.parse(provider); z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(state); z.string().min(1).max(4096).parse(code);
  const context = mutationContext(principal, randomUUID(), { reason: "Connect shared document storage" });
  // Consume state durably before exchanging the single-use code. Failures require a fresh handoff.
  const handoff = await withTenantTransaction(context, async (client) => {
    await assertStorageWrite(client, context); await assertPermission(client, context, PERMISSIONS.manageOrganizationSettings);
    const row = (await client.query<{ id: string; organization_id: string; key_version: number; connection_id: string; verifier_ciphertext: string }>(`UPDATE document_storage_oauth SET consumed_at=now()
      WHERE organization_id=$1 AND actor_id=$2 AND session_id=$3 AND state_hash=$4 AND consumed_at IS NULL AND expires_at>now() RETURNING *`, [context.organizationId, context.actorId, context.sessionId, hash(state)])).rows[0];
    if (!row) throw new StorageError("STORAGE_OAUTH_EXPIRED", "The connection request expired. Start again from Document storage.");
    const connection = await loadConnection(client, context, row.connection_id, "admin", false);
    if (connection.provider !== provider) throw new StorageError("STORAGE_OAUTH_PROVIDER", "The connection provider does not match.");
    return { connectionId: connection.id, verifier: z.string().parse(await decryptStorageValue(client, row, "document_storage_oauth", "verifier_ciphertext", row.verifier_ciphertext)) };
  });
  const credentials = await exchangeStorageToken(provider, { code, verifier: handoff.verifier });
  return withTenantTransaction(context, async (client) => {
    await assertStorageWrite(client, context);
    const row = await loadConnection(client, context, handoff.connectionId, "admin", false);
    if (row.oauth_state_hash !== hash(state)) throw new StorageError("STORAGE_OAUTH_EXPIRED", "This connection request was revoked or superseded. Start a new connection request.");
    const existing = row.config_ciphertext ? await connectionLocation(client, row) : undefined;
    const location = await new CloudDrive(provider, credentials.accessToken).provision(`FinLynQ-${safeFilenamePart(row.label, 45)}-${row.id}`, existing);
    const configCiphertext = await encryptStorageValue(client, row, "document_storage_connections", "config_ciphertext", location);
    const credentialCiphertext = await encryptStorageValue(client, row, "document_storage_connections", "credentials_ciphertext", credentials);
    await client.query("UPDATE document_storage_connections SET active=true,config_ciphertext=$3,credentials_ciphertext=$4,oauth_state_hash=NULL WHERE organization_id=$1 AND id=$2", [context.organizationId, row.id, configCiphertext, credentialCiphertext]);
    return { connectionId: row.id };
  });
}
export async function disconnectStorage(context: TenantTransactionContext, connectionId: string) {
  return withTenantTransaction(context, async (client) => {
    await assertStorageWrite(client, context); await loadConnection(client, context, z.uuid().parse(connectionId), "admin", false);
    await client.query("UPDATE document_storage_connections SET active=false,credentials_ciphertext=NULL,oauth_state_hash=NULL WHERE organization_id=$1 AND id=$2", [context.organizationId, connectionId]);
    await client.query("UPDATE document_storage_oauth SET consumed_at=now() WHERE organization_id=$1 AND connection_id=$2 AND consumed_at IS NULL", [context.organizationId, connectionId]);
    return { disconnected: true };
  });
}
export async function listStorageConnections(context: TenantTransactionContext) {
  realStorageContext(context);
  return withTenantTransaction(context, async (client) => {
    const rows = (await client.query<ConnectionRow>("SELECT * FROM document_storage_connections WHERE organization_id=$1 ORDER BY created_at DESC", [context.organizationId])).rows;
    return Promise.all(rows.map(async (row) => {
      const location = row.config_ciphertext ? await connectionLocation(client, row) : null;
      return { id: row.id, label: row.label, provider: row.provider, module: row.owner_module, legalEntityId: row.legal_entity_id,
        active: row.active, lastSyncedAt: row.last_synced_at?.toISOString() ?? null, inboxUrl: location?.inboxUrl ?? null, archiveUrl: location?.archiveUrl ?? null };
    }));
  });
}
