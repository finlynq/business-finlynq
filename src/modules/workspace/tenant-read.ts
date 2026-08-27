import "server-only";

import { redirect } from "next/navigation";
import type { PoolClient } from "pg";
import { isDemoSessionLeaseLostError } from "@/db/errors";
import {
  withTenantTransaction,
  type TenantTransactionContext,
} from "@/db/transaction";
import { safeAppPath } from "@/modules/identity/safe-redirect";

/**
 * Convert only the typed validate-to-transaction demo logout race into the
 * same signed-out navigation used when session resolution returns null.
 */
export async function withWorkspaceSessionExpiryRedirect<T>(
  nextPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isDemoSessionLeaseLostError(error)) {
      const safeNextPath = safeAppPath(nextPath);
      redirect(`/login?next=${encodeURIComponent(safeNextPath)}&reason=expired`);
    }
    throw error;
  }
}

export function withWorkspaceTenantRead<T>(
  context: TenantTransactionContext,
  nextPath: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withWorkspaceSessionExpiryRedirect(
    nextPath,
    () => withTenantTransaction(context, work),
  );
}
