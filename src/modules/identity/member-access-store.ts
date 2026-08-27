import "server-only";

import type { QueryResultRow } from "pg";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";

export type OrganizationSettingsRecord = Readonly<{
  organization_id: string;
  display_name: string;
  settings_version: number;
  is_demo: boolean;
  can_manage_settings: boolean;
  can_read_members: boolean;
  can_manage_members: boolean;
  can_manage_roles: boolean;
  can_manage_recovery: boolean;
  assignable_roles: unknown;
}>;

export type OrganizationMemberRecord = Readonly<{
  membership_id: string;
  user_id: string;
  email_ciphertext: string;
  display_name_ciphertext: string | null;
  membership_active: boolean;
  administration_version: number;
  role_id: string;
  role_key: string;
  role_name: string;
  invitation_id: string | null;
  invitation_status: string | null;
  invitation_version: number | null;
  invitation_expires_at: Date | null;
  is_self: boolean;
  active_session_count: string;
  last_active_at: Date | null;
}>;

type VersionRecord = Readonly<{ version: number }>;
type InvitationRecord = Readonly<{
  invitation_id: string;
  membership_id: string;
  version: number;
  expires_at: Date;
}>;

async function inContext<Row extends QueryResultRow>(
  context: TenantTransactionContext,
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly Row[]> {
  return withTenantTransaction(context, async (client) => {
    const result = await client.query<Row>(sql, [...values]);
    return result.rows;
  });
}

export async function readOrganizationSettingsRecord(
  context: TenantTransactionContext,
): Promise<OrganizationSettingsRecord | null> {
  const rows = await inContext<OrganizationSettingsRecord>(
    context,
    "SELECT * FROM app.organization_settings_read()",
  );
  return rows[0] ?? null;
}

export function readOrganizationMemberRecords(
  context: TenantTransactionContext,
): Promise<readonly OrganizationMemberRecord[]> {
  return inContext<OrganizationMemberRecord>(
    context,
    "SELECT * FROM app.organization_members_read()",
  );
}

export async function updateOrganizationSettingsRecord(
  context: TenantTransactionContext,
  input: Readonly<{ displayName: string; expectedVersion: number }>,
): Promise<number> {
  const rows = await inContext<VersionRecord>(
    context,
    "SELECT app.organization_update_settings($1,$2) AS version",
    [input.displayName, input.expectedVersion],
  );
  if (!rows[0]) throw new Error("Organization settings update returned no result");
  return rows[0].version;
}

export type InviteMemberPersistenceInput = Readonly<{
  roleId: string;
  userId: string;
  membershipId: string;
  invitationId: string;
  emailLookupHash: string;
  emailCiphertext: string;
  displayNameCiphertext: string;
  tokenId: string | null;
  tokenHash: string | null;
  outboxId: string | null;
  payloadCiphertext: string | null;
}>;

export async function inviteOrganizationMemberRecord(
  context: TenantTransactionContext,
  input: InviteMemberPersistenceInput,
): Promise<InvitationRecord> {
  const rows = await inContext<InvitationRecord>(
    context,
    "SELECT * FROM app.organization_invite_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      input.roleId,
      input.userId,
      input.membershipId,
      input.invitationId,
      input.emailLookupHash,
      input.emailCiphertext,
      input.displayNameCiphertext,
      input.tokenId,
      input.tokenHash,
      input.outboxId,
      input.payloadCiphertext,
    ],
  );
  if (!rows[0]) throw new Error("Organization invitation returned no result");
  return rows[0];
}

export type ResendInvitationPersistenceInput = Readonly<{
  invitationId: string;
  expectedVersion: number;
  tokenId: string | null;
  tokenHash: string | null;
  outboxId: string | null;
  payloadCiphertext: string | null;
}>;

export async function resendOrganizationInvitationRecord(
  context: TenantTransactionContext,
  input: ResendInvitationPersistenceInput,
): Promise<InvitationRecord> {
  const rows = await inContext<InvitationRecord>(
    context,
    "SELECT * FROM app.organization_resend_invitation($1,$2,$3,$4,$5,$6)",
    [
      input.invitationId,
      input.expectedVersion,
      input.tokenId,
      input.tokenHash,
      input.outboxId,
      input.payloadCiphertext,
    ],
  );
  if (!rows[0]) throw new Error("Invitation resend returned no result");
  return rows[0];
}

export async function cancelOrganizationInvitationRecord(
  context: TenantTransactionContext,
  invitationId: string,
  expectedVersion: number,
): Promise<number> {
  const rows = await inContext<VersionRecord>(
    context,
    "SELECT app.organization_cancel_invitation($1,$2) AS version",
    [invitationId, expectedVersion],
  );
  if (!rows[0]) throw new Error("Invitation cancellation returned no result");
  return rows[0].version;
}

export async function assignOrganizationMemberRoleRecord(
  context: TenantTransactionContext,
  input: Readonly<{ membershipId: string; roleId: string; expectedVersion: number }>,
): Promise<number> {
  const rows = await inContext<VersionRecord>(
    context,
    "SELECT app.organization_assign_member_role($1,$2,$3) AS version",
    [input.membershipId, input.roleId, input.expectedVersion],
  );
  if (!rows[0]) throw new Error("Role assignment returned no result");
  return rows[0].version;
}

export async function setOrganizationMemberActiveRecord(
  context: TenantTransactionContext,
  input: Readonly<{ membershipId: string; expectedVersion: number; active: boolean }>,
): Promise<number> {
  const rows = await inContext<VersionRecord>(
    context,
    "SELECT app.organization_set_member_active($1,$2,$3) AS version",
    [input.membershipId, input.expectedVersion, input.active],
  );
  if (!rows[0]) throw new Error("Member status update returned no result");
  return rows[0].version;
}

export async function revokeOrganizationMemberSessionsRecord(
  context: TenantTransactionContext,
  membershipId: string,
): Promise<number> {
  const rows = await inContext<{ revoked_count: string }>(
    context,
    "SELECT app.organization_revoke_member_sessions($1)::text AS revoked_count",
    [membershipId],
  );
  return Number(rows[0]?.revoked_count ?? "0");
}
