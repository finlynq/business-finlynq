import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import { assertActorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import type { SubledgerOwnerModule } from "./document-model";

export function withoutContext<T extends Readonly<{ context: TenantTransactionContext }>>(
  input: T,
): Omit<T, "context"> {
  const { context, ...payload } = input;
  void context;
  return payload;
}

export function permissionForOwner(
  ownerModule: SubledgerOwnerModule,
  operation: "read" | "manage" | "post" | "settle" | "void",
): Permission {
  const permissions = ownerModule === "receivables"
    ? {
        read: PERMISSIONS.readReceivables,
        manage: PERMISSIONS.manageReceivables,
        post: PERMISSIONS.postReceivables,
        settle: PERMISSIONS.settleReceivables,
        void: PERMISSIONS.voidReceivables,
      }
    : {
        read: PERMISSIONS.readPayables,
        manage: PERMISSIONS.managePayables,
        post: PERMISSIONS.postPayables,
        settle: PERMISSIONS.settlePayables,
        void: PERMISSIONS.voidPayables,
      };
  return permissions[operation];
}

export async function assertPermission(
  client: PoolClient,
  context: TenantTransactionContext,
  permission: Permission,
): Promise<void> {
  await assertActorHasActivePermission(client, {
    organizationId: context.organizationId,
    actorId: context.actorId,
    permission,
  });
}
