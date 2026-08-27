import type { PoolClient } from "pg";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  LocalRootKeyProvider,
  generateOrganizationDek,
  parseWrappedKey,
  serializeWrappedKey,
} from "./organization-encryption";
import { loadOrganizationRootKek } from "./root-secret";

type StoredKeyEnvelope = Readonly<{
  version: number;
  key_provider: string;
  wrapped_dek: string;
}>;

export type ActiveOrganizationKey = Readonly<{
  keyVersion: number;
  dek: Buffer;
}>;

function assertBusinessWritesEnabled(): void {
  if (process.env.BUSINESS_WRITES_ENABLED !== "true") {
    throw new Error("Business writes are disabled");
  }
}

function withRootProvider<T>(work: (provider: LocalRootKeyProvider) => T): T {
  const rootKey = loadOrganizationRootKek();
  try {
    return work(new LocalRootKeyProvider(rootKey));
  } finally {
    rootKey.fill(0);
  }
}

export async function loadActiveOrganizationKey(
  client: PoolClient,
  organizationId: string,
): Promise<ActiveOrganizationKey> {
  const result = await client.query<StoredKeyEnvelope>(
    `SELECT version, key_provider, wrapped_dek
     FROM organization_key_versions
     WHERE organization_id = $1 AND active
     ORDER BY version DESC
     LIMIT 2`,
    [organizationId],
  );
  if (result.rows.length !== 1) {
    throw new Error(
      result.rows.length === 0
        ? "Organization encryption key is not provisioned"
        : "Organization has multiple active encryption keys",
    );
  }

  const stored = result.rows[0];
  const wrapped = parseWrappedKey(stored.wrapped_dek);
  if (stored.key_provider !== wrapped.provider || stored.version !== wrapped.keyVersion) {
    throw new Error("Organization key envelope does not match its database metadata");
  }

  const dek = withRootProvider((provider) => provider.unwrapOrganizationKey(organizationId, wrapped));
  return { keyVersion: stored.version, dek };
}

export async function provisionOrganizationKey(
  context: TenantTransactionContext,
): Promise<Readonly<{ keyVersion: number; alreadyProvisioned: boolean }>> {
  assertBusinessWritesEnabled();
  return withTenantTransaction(context, async (client) => {
    await assertActorHasActivePermission(client, {
      organizationId: context.organizationId,
      actorId: context.actorId,
      permission: PERMISSIONS.manageRecovery,
    });

    const existing = await client.query<{ version: number }>(
      `SELECT key_version.version
       FROM organization_key_versions key_version
       JOIN organizations organization ON organization.id = key_version.organization_id
       WHERE key_version.organization_id = $1
         AND key_version.active
         AND organization.active
         AND NOT organization.is_demo`,
      [context.organizationId],
    );
    if (existing.rows.length === 1) {
      return { keyVersion: existing.rows[0].version, alreadyProvisioned: true };
    }
    if (existing.rows.length > 1) throw new Error("Organization has multiple active encryption keys");

    const dek = generateOrganizationDek();
    try {
      const wrapped = withRootProvider((provider) =>
        provider.wrapOrganizationKey(context.organizationId, 1, dek),
      );
      const installed = await client.query<{ version: number }>(
        `SELECT app.install_initial_organization_key($1, $2)::int AS version`,
        [wrapped.provider, serializeWrappedKey(wrapped)],
      );
      if (installed.rows[0]?.version !== 1) {
        throw new Error("Organization key installation returned an invalid version");
      }
      return { keyVersion: 1, alreadyProvisioned: false };
    } finally {
      dek.fill(0);
    }
  });
}
