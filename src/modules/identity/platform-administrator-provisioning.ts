import type { PoolClient } from "pg";
import { z } from "zod";
import {
  decryptIdentityField,
  emailLookupHash,
  encryptIdentityField,
  identityDerivedUuid,
  normalizeEmail,
} from "@/security/identity-secret";

export const PLATFORM_ADMINISTRATOR_ROLE = "PLATFORM_ADMINISTRATOR" as const;

const provisioningSchema = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
  grantedBy: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(10).max(500),
  requestId: z.string().trim().min(1).max(200),
});

type ExistingGrant = Readonly<{
  id: string;
  role_key: string;
  status: "GRANTED" | "REVOKED";
  linked_user_id: string | null;
  email_ciphertext: string;
  effective: boolean;
}>;

export type PlatformAdministratorGrantState = "ACTIVE" | "PENDING_IDENTITY";

export type PlatformAdministratorGrantResult = Readonly<{
  grantId: string;
  roleKey: typeof PLATFORM_ADMINISTRATOR_ROLE;
  state: PlatformAdministratorGrantState;
  created: boolean;
}>;

/**
 * Reserve a global administrator role for an encrypted identity. This does not
 * create or activate an account. Database triggers link the role only when the
 * matching real identity is active, email-verified, and protected by active
 * MFA. Re-running an active grant is idempotent; revoked grants fail closed.
 */
export async function provisionPlatformAdministratorGrant(
  client: PoolClient,
  untrustedInput: z.input<typeof provisioningSchema>,
): Promise<PlatformAdministratorGrantResult> {
  const input = provisioningSchema.parse(untrustedInput);
  const normalizedEmail = normalizeEmail(input.email);
  const lookupHash = emailLookupHash(normalizedEmail);
  const grantId = identityDerivedUuid("platform-administrator-grant", lookupHash);

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`business-finlynq|account-user|${lookupHash}`],
  );
  const existing = await client.query<ExistingGrant>(
    `SELECT grant_record.id,grant_record.role_key,grant_record.status,
       grant_record.linked_user_id,grant_record.email_ciphertext,
       (
         grant_record.linked_user_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM users selected_user
           WHERE selected_user.id=grant_record.linked_user_id
             AND selected_user.email_lookup_hash=grant_record.email_lookup_hash
             AND selected_user.active AND NOT selected_user.is_demo
             AND selected_user.email_verified_at IS NOT NULL
             AND selected_user.mfa_required
             AND EXISTS (
               SELECT 1 FROM auth_mfa_factors factor
               WHERE factor.user_id=selected_user.id
                 AND factor.status='ACTIVE' AND factor.verified_at IS NOT NULL
                 AND factor.revoked_at IS NULL
             )
         )
       ) AS effective
     FROM platform_administrator_grants grant_record
     WHERE grant_record.email_lookup_hash=$1
     FOR UPDATE`,
    [lookupHash],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].status !== "GRANTED") {
      throw new Error("A revoked platform administrator grant requires a separate reviewed reauthorization");
    }
    if (existing.rows[0].id !== grantId || existing.rows[0].role_key !== PLATFORM_ADMINISTRATOR_ROLE) {
      throw new Error("The existing platform administrator grant has an invalid identity binding");
    }
    if (decryptIdentityField(existing.rows[0].email_ciphertext, "email", existing.rows[0].id) !== normalizedEmail) {
      throw new Error("The existing platform administrator grant has an invalid encrypted identity binding");
    }
    return {
      grantId: existing.rows[0].id,
      roleKey: PLATFORM_ADMINISTRATOR_ROLE,
      state: existing.rows[0].effective ? "ACTIVE" : "PENDING_IDENTITY",
      created: false,
    };
  }

  await client.query(
    `INSERT INTO platform_administrator_grants(
       id,email_lookup_hash,email_ciphertext,role_key,status,
       granted_by,grant_reason,grant_request_id
     ) VALUES($1,$2,$3,$4,'GRANTED',$5,$6,$7)`,
    [
      grantId,
      lookupHash,
      encryptIdentityField(normalizedEmail, "email", grantId),
      PLATFORM_ADMINISTRATOR_ROLE,
      input.grantedBy,
      input.reason,
      input.requestId,
    ],
  );
  const linked = await client.query<{ effective: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM platform_administrator_grants grant_record
       JOIN users selected_user ON selected_user.id=grant_record.linked_user_id
       WHERE grant_record.id=$1 AND grant_record.status='GRANTED'
         AND selected_user.email_lookup_hash=grant_record.email_lookup_hash
         AND selected_user.active AND NOT selected_user.is_demo
         AND selected_user.email_verified_at IS NOT NULL
         AND selected_user.mfa_required
         AND EXISTS (
           SELECT 1 FROM auth_mfa_factors factor
           WHERE factor.user_id=selected_user.id
             AND factor.status='ACTIVE' AND factor.verified_at IS NOT NULL
             AND factor.revoked_at IS NULL
         )
     ) AS effective`,
    [grantId],
  );
  return {
    grantId,
    roleKey: PLATFORM_ADMINISTRATOR_ROLE,
    state: linked.rows[0]?.effective ? "ACTIVE" : "PENDING_IDENTITY",
    created: true,
  };
}
