import type { PoolClient } from "pg";
import type { Permission } from "./permissions";

type PermissionLookup = Readonly<{
  allowed: boolean;
}>;

export type ActorPermissionRequest = Readonly<{
  organizationId: string;
  actorId: string;
  permission: Permission;
}>;

/**
 * Resolve authorization from the tenant database inside the active transaction.
 * Callers must never supply precomputed roles or permissions to a write service.
 */
export async function actorHasActivePermission(
  client: PoolClient,
  request: ActorPermissionRequest,
): Promise<boolean> {
  const result = await client.query<PermissionLookup>(
    `SELECT true AS allowed
     FROM organization_memberships AS membership
     INNER JOIN organizations AS organization
       ON organization.id = membership.organization_id
     INNER JOIN membership_roles AS membership_role
       ON membership_role.organization_id = membership.organization_id
      AND membership_role.membership_id = membership.id
     INNER JOIN roles AS role
       ON role.organization_id = membership_role.organization_id
      AND role.id = membership_role.role_id
     INNER JOIN role_permissions AS role_permission
       ON role_permission.organization_id = role.organization_id
      AND role_permission.role_id = role.id
     WHERE membership.organization_id = $1
       AND membership.user_id = $2
       AND membership.active
       AND organization.active
       AND role.active
       AND role_permission.permission_key = $3
     LIMIT 1`,
    [request.organizationId, request.actorId, request.permission],
  );

  return result.rows.length === 1 && result.rows[0]?.allowed === true;
}

export async function assertActorHasActivePermission(
  client: PoolClient,
  request: ActorPermissionRequest,
): Promise<void> {
  if (!(await actorHasActivePermission(client, request))) {
    throw new Error("Posting permission is required for an active organization member");
  }
}

export async function actorHasActiveOrganizationRole(
  client: PoolClient,
  request: Readonly<{
    organizationId: string;
    actorId: string;
    roleKeys: readonly string[];
  }>,
): Promise<boolean> {
  if (request.roleKeys.length === 0) return false;
  const result = await client.query<PermissionLookup>(
    `SELECT true AS allowed
     FROM organization_memberships membership
     JOIN organizations organization ON organization.id = membership.organization_id
     JOIN membership_roles membership_role
       ON membership_role.organization_id = membership.organization_id
      AND membership_role.membership_id = membership.id
     JOIN roles role
       ON role.organization_id = membership_role.organization_id
      AND role.id = membership_role.role_id
     WHERE membership.organization_id = $1
       AND membership.user_id = $2
       AND membership.active
       AND organization.active
       AND role.active
       AND role.key = ANY($3::text[])
     LIMIT 1`,
    [request.organizationId, request.actorId, request.roleKeys],
  );
  return result.rows[0]?.allowed === true;
}

export async function assertActorHasActiveOrganizationRole(
  client: PoolClient,
  request: Parameters<typeof actorHasActiveOrganizationRole>[1],
): Promise<void> {
  if (!(await actorHasActiveOrganizationRole(client, request))) {
    throw new Error("An active organization owner or administrator role is required");
  }
}
