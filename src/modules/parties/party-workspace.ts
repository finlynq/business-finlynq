import "server-only";

import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "@/db/transaction";
import { actorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS } from "@/modules/identity/permissions";
import {
  transactionAuthMethod,
  type SessionPrincipal,
} from "@/modules/identity/session";
import { principalCanWrite } from "@/modules/workspace/write-policy";

export type PartyAccountCreationOptionDto = Readonly<{
  legalEntityId: string;
  entityCode: string;
  ledgerId: string;
  ledgerCode: string;
  functionalCurrency: string;
  role: "CUSTOMER" | "SUPPLIER";
  controlAccountId: string;
  controlAccountCode: string;
  controlAccountName: string;
}>;

export async function loadPartyAccountCreationOptions(
  principal: SessionPrincipal,
): Promise<readonly PartyAccountCreationOptionDto[]> {
  return withTenantTransaction({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `party-account-options:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI",
  }, async (client) => {
    const membership = await client.query(
      `SELECT 1
       FROM organization_memberships membership
       JOIN organizations organization
         ON organization.id = membership.organization_id
       WHERE membership.organization_id = $1
         AND membership.id = $2
         AND membership.user_id = $3
         AND membership.active
         AND organization.active`,
      [principal.organizationId, principal.membershipId, principal.userId],
    );
    if (!membership.rows[0] || !principalCanWrite(principal)) return [];

    const canManage = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: PERMISSIONS.manageParties,
    });
    if (!canManage) return [];

    const result = await client.query<{
      legal_entity_id: string;
      entity_code: string;
      ledger_id: string;
      ledger_code: string;
      functional_currency: string;
      role: "CUSTOMER" | "SUPPLIER";
      control_account_id: string;
      control_account_code: string;
      control_account_name: string;
    }>(
      `SELECT DISTINCT entity.id AS legal_entity_id, entity.code AS entity_code,
         ledger.id AS ledger_id, ledger.code AS ledger_code,
         ledger.functional_currency,
         CASE control_account.control_kind
           WHEN 'AR' THEN 'CUSTOMER'::text
           WHEN 'AP' THEN 'SUPPLIER'::text
         END AS role,
         control_account.id AS control_account_id,
         control_account.code AS control_account_code,
         control_account.display_name AS control_account_name
       FROM legal_entities entity
       JOIN ledgers ledger
         ON ledger.organization_id = entity.organization_id
        AND ledger.legal_entity_id = entity.id
        AND ledger.kind = 'PRIMARY'
        AND ledger.active
       JOIN gl_accounts control_account
         ON control_account.organization_id = ledger.organization_id
        AND control_account.ledger_id = ledger.id
        AND control_account.control_kind IN ('AR', 'AP')
        AND control_account.active
        AND control_account.postable
        AND control_account.valid_from <= current_date
        AND (control_account.valid_to IS NULL OR control_account.valid_to >= current_date)
       JOIN account_combinations combination
         ON combination.organization_id = entity.organization_id
        AND combination.ledger_id = ledger.id
        AND combination.entity_id = entity.id
        AND combination.account_id = control_account.id
        AND combination.active
       WHERE entity.organization_id = $1
         AND entity.active
         AND entity.country_code IN ('CA', 'US')
       ORDER BY entity.code, role, control_account.code`,
      [principal.organizationId],
    );

    return result.rows.map((row) => ({
      legalEntityId: row.legal_entity_id,
      entityCode: row.entity_code,
      ledgerId: row.ledger_id,
      ledgerCode: row.ledger_code,
      functionalCurrency: row.functional_currency,
      role: row.role,
      controlAccountId: row.control_account_id,
      controlAccountCode: row.control_account_code,
      controlAccountName: row.control_account_name,
    }));
  });
}
