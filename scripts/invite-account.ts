import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { loadEmailDeliveryMetadata } from "@/modules/identity/email-provider";
import { createOpaqueToken } from "@/modules/identity/session";
import {
  emailLookupHash,
  encryptAuthPayload,
  encryptIdentityField,
  identityDerivedUuid,
  normalizeEmail,
} from "@/security/identity-secret";
import { operatorDatabaseConfig } from "./operator-database";

const optionsSchema = z.object({
  organization: z.uuid(),
  role: z.uuid(),
  email: z.email().max(254),
  name: z.string().trim().min(1).max(160),
  invitedBy: z.uuid().optional(),
});

function parseArguments(values: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error("Arguments must be --name value pairs");
    options.set(name.slice(2), value);
  }
  return optionsSchema.parse({
    organization: options.get("organization"),
    role: options.get("role"),
    email: options.get("email"),
    name: options.get("name"),
    invitedBy: options.get("invited-by"),
  });
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  loadEmailDeliveryMetadata();
  const pool = new Pool({ ...operatorDatabaseConfig(), max: 1, application_name: "business-finlynq-account-invite" });
  const client = await pool.connect();
  const requestId = randomUUID();
  const normalizedEmail = normalizeEmail(input.email);
  const emailHash = emailLookupHash(normalizedEmail);
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`business-finlynq|account-user|${emailHash}`],
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`account-invite|${input.organization}`]);
    const target = await client.query<{ organization_name: string; role_name: string }>(
      `SELECT organization.display_name AS organization_name, role.display_name AS role_name
       FROM organizations organization
       JOIN roles role ON role.organization_id = organization.id
       WHERE organization.id = $1 AND role.id = $2
         AND organization.active AND NOT organization.is_demo AND role.active`,
      [input.organization, input.role],
    );
    if (!target.rows[0]) throw new Error("The active role does not belong to the active organization");

    const activeMembers = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM organization_memberships WHERE organization_id=$1 AND active",
      [input.organization],
    );
    const isBootstrap = Number(activeMembers.rows[0]?.count ?? 0) === 0;
    if (isBootstrap) {
      const recoveryRole = await client.query(
        `SELECT 1 FROM role_permissions
         WHERE organization_id=$1 AND role_id=$2 AND permission_key='organization.recovery.manage'`,
        [input.organization, input.role],
      );
      if (!recoveryRole.rowCount) throw new Error("The first account must receive a role with organization.recovery.manage");
    } else {
      if (!input.invitedBy) throw new Error("--invited-by is required after the first organization account");
      const inviter = await client.query(
        `SELECT 1
         FROM organization_memberships membership
         JOIN users selected_user ON selected_user.id=membership.user_id AND selected_user.active
         JOIN membership_roles membership_role
           ON membership_role.organization_id=membership.organization_id AND membership_role.membership_id=membership.id
         JOIN role_permissions role_permission
           ON role_permission.organization_id=membership_role.organization_id AND role_permission.role_id=membership_role.role_id
         WHERE membership.organization_id=$1 AND membership.user_id=$2 AND membership.active
           AND role_permission.permission_key='organization.recovery.manage'`,
        [input.organization, input.invitedBy],
      );
      if (!inviter.rowCount) throw new Error("The inviting user lacks active recovery-administration permission");
    }

    const existing = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE email_lookup_hash=$1 FOR UPDATE", [emailHash],
    );
    if (existing.rows[0]) throw new Error("This email already has an identity or pending flow");
    const userId = identityDerivedUuid("account-user", emailHash);
    await client.query(
      `INSERT INTO users(
         id,email_lookup_hash,email_ciphertext,display_name_ciphertext,password_hash,
         active,is_demo,mfa_required
       ) VALUES ($1,$2,$3,$4,'!invitation-pending!',false,false,true)`,
      [userId, emailHash, encryptIdentityField(normalizedEmail, "email", userId),
        encryptIdentityField(input.name, "display-name", userId)],
    );

    const membershipId = randomUUID();
    const membership = await client.query<{ id: string }>(
      `INSERT INTO organization_memberships(id,organization_id,user_id,active)
       VALUES ($1,$2,$3,false)
       ON CONFLICT (organization_id,user_id) DO UPDATE SET active=false
       RETURNING id`,
      [membershipId, input.organization, userId],
    );
    const selectedMembershipId = membership.rows[0]!.id;
    await client.query("DELETE FROM membership_roles WHERE organization_id=$1 AND membership_id=$2", [input.organization, selectedMembershipId]);
    await client.query(
      `INSERT INTO membership_roles(organization_id,membership_id,role_id,assigned_by)
       VALUES ($1,$2,$3,$4)`,
      [input.organization, selectedMembershipId, input.role, input.invitedBy ?? userId],
    );
    await client.query(
      `UPDATE auth_one_time_tokens SET consumed_at=coalesce(consumed_at,now())
       WHERE user_id=$1 AND purpose IN ('INVITATION','MFA_SETUP') AND consumed_at IS NULL`,
      [userId],
    );
    await client.query(
      "UPDATE auth_mfa_factors SET status='REVOKED', revoked_at=now() WHERE user_id=$1 AND status IN ('PENDING','ACTIVE')",
      [userId],
    );

    const invitation = createOpaqueToken();
    const outboxId = randomUUID();
    await client.query(
      `INSERT INTO auth_one_time_tokens(token_hash,purpose,user_id,organization_id,expires_at)
       VALUES ($1,'INVITATION',$2,$3,now()+interval '72 hours')`,
      [invitation.hash, userId, input.organization],
    );
    await client.query(
      `INSERT INTO auth_email_outbox(
         id,user_id,organization_id,template_type,payload_ciphertext,request_id
       ) VALUES ($1,$2,$3,'INVITATION',$4,$5)`,
      [outboxId, userId, input.organization,
        encryptAuthPayload(JSON.stringify({ token: invitation.raw }), "email-payload", outboxId), requestId],
    );
    await client.query(
      `INSERT INTO auth_security_events(user_id,organization_id,event_type,outcome,request_id,metadata)
       VALUES ($1,$2,'INVITATION_ISSUED','SUCCESS',$3,
         jsonb_build_object('invitedBy',$4::text,'roleId',$5::text))`,
      [userId, input.organization, requestId, input.invitedBy ?? "bootstrap", input.role],
    );
    await client.query("COMMIT");
    console.log(`Invitation queued in ${target.rows[0].organization_name} (${target.rows[0].role_name}).`);
    console.log(`User ${userId}; membership ${selectedMembershipId}; request ${requestId}. No token was printed.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Account invitation failed");
  process.exitCode = 1;
});
