import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantTransactionContext } from "@/db/transaction";
import { demoAccountingDate } from "@/modules/demo/accounting-clock";
import { actorHasActivePermission } from "@/modules/identity/authorization";
import { PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import {
  transactionAuthMethod,
  type SessionPrincipal,
} from "@/modules/identity/session";
import {
  createBlindIndex,
  parseEncryptedField,
  decryptField,
} from "@/security/organization-encryption";
import { loadActiveOrganizationKey } from "@/security/organization-key-store";
import { principalCanWrite } from "@/modules/workspace/write-policy";
import { withWorkspaceTenantRead } from "@/modules/workspace/tenant-read";
import {
  normalizeRegisterPage,
  registerPageSize,
  registerPageWindow,
  type RegisterPagination,
} from "@/modules/workspace/register-pagination";
import {
  subledgerSourceSnapshotSchema,
  type BusinessDocumentKind,
  type SettlementDocumentKind,
  type SubledgerOwnerModule,
  type SubledgerSourceSnapshot,
} from "./document-model";
import type { OrganizationFxRate } from "./fx-suggestions";
import type { SubledgerDueFilter, SubledgerRegisterFilter } from "./register-filter";

type SourceDocumentStatus = "DRAFT" | "POSTED" | "VOIDED";
type AccountClass = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export type SubledgerAccountOptionDto = Readonly<{
  combinationId: string;
  code: string;
  displayName: string;
  accountClass: AccountClass;
}>;

export type SubledgerPeriodOptionDto = Readonly<{
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
}>;

export type SubledgerPartyAccountOptionDto = Readonly<{
  id: string;
  partyId: string;
  partyNumber: string;
  partyName: string;
  accountNumber: string;
  transactionCurrency: string | null;
  controlAccountCombinationId: string;
}>;

export type SubledgerEntityOptionDto = Readonly<{
  id: string;
  code: string;
  displayName: string;
  countryCode: string;
  regionCode: string;
  ledgerId: string;
  functionalCurrency: string;
  periods: readonly SubledgerPeriodOptionDto[];
  partyAccounts: readonly SubledgerPartyAccountOptionDto[];
  lineAccounts: readonly SubledgerAccountOptionDto[];
  taxAccounts: readonly SubledgerAccountOptionDto[];
  bankAccounts: readonly SubledgerAccountOptionDto[];
  fxGainAccounts: readonly SubledgerAccountOptionDto[];
  fxLossAccounts: readonly SubledgerAccountOptionDto[];
  roundingAccounts: readonly SubledgerAccountOptionDto[];
  tax: Readonly<{
    packKey: string;
    registrationReference: string | null;
    destinationCountry: string;
    destinationRegion: string;
    destinationCity: string | null;
    locationCode: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
  }>;
}>;

export type SubledgerOpenItemDto = Readonly<{
  id: string;
  sourceNumber: string;
  partyAccountId: string;
  partyName: string;
  entityCode: string;
  ledgerId: string;
  currency: string;
  originalAmount: string;
  openAmount: string;
  carryingFunctionalAmount: string;
  dueOn: string | null;
  status: "OPEN" | "PARTIALLY_SETTLED" | "SETTLED" | "REVERSED";
}>;

export type SubledgerWorkspaceDocumentDto = Readonly<{
  id: string;
  sourceNumber: string;
  sourceType: string;
  version: number;
  status: SourceDocumentStatus;
  snapshot: SubledgerSourceSnapshot;
  createdAt: string;
  voidReason: string | null;
  partyName: string;
  entityCode: string;
  journalId: string | null;
  journalNumber: number | null;
  openItemId: string | null;
  openAmount: string | null;
  openStatus: SubledgerOpenItemDto["status"] | null;
}>;

export type SubledgerWorkspaceDto = Readonly<{
  ownerModule: SubledgerOwnerModule;
  businessKind: BusinessDocumentKind;
  settlementKind: SettlementDocumentKind;
  demoOnly: boolean;
  canRead: boolean;
  canManage: boolean;
  canPost: boolean;
  canSettle: boolean;
  canVoid: boolean;
  currentDate: string;
  currencies: readonly Readonly<{ code: string; minorUnits: number }>[];
  fxRates: readonly OrganizationFxRate[];
  entities: readonly SubledgerEntityOptionDto[];
  documents: readonly SubledgerWorkspaceDocumentDto[];
  openItems: readonly SubledgerOpenItemDto[];
  registerFilter: SubledgerRegisterFilter;
  pagination: RegisterPagination;
  preferredEntityId: string | null;
}>;

export type SubledgerRegisterRequest = Readonly<Partial<SubledgerRegisterFilter> & {
  page?: number;
}>;

type EntityRow = Readonly<{
  id: string;
  code: string;
  display_name: string;
  country_code: string;
  region_code: string;
  ledger_id: string;
  functional_currency: string;
}>;

type PeriodRow = Readonly<{
  id: string;
  ledger_id: string;
  label: string;
  starts_on: string;
  ends_on: string;
}>;

type PartyAccountRow = Readonly<{
  id: string;
  legal_entity_id: string;
  party_id: string;
  party_number: string;
  display_name_ciphertext: string;
  display_name_key_version: number;
  account_number: string;
  transaction_currency: string | null;
  control_combination_id: string;
}>;

type AccountRow = Readonly<{
  legal_entity_id: string;
  combination_id: string;
  code: string;
  display_name: string;
  account_class: AccountClass;
}>;

type TaxRow = Readonly<{
  legal_entity_id: string;
  registration_id: string;
  regime_key: string;
  destination_country: string | null;
  destination_region: string | null;
  destination_city: string | null;
  location_code: string | null;
  registration_valid_to: string | null;
  pack_effective_from: string | null;
  pack_effective_to: string | null;
}>;

type DocumentRow = Readonly<{
  id: string;
  source_type: string;
  source_number: string;
  version: number;
  status: SourceDocumentStatus;
  snapshot: unknown;
  created_at: Date | string;
  void_reason: string | null;
  journal_id: string | null;
  journal_number: number | null;
  open_item_id: string | null;
  open_amount: string | null;
  open_status: SubledgerOpenItemDto["status"] | null;
}>;

type OpenItemRow = Readonly<{
  id: string;
  source_number: string;
  party_account_id: string;
  entity_code: string;
  ledger_id: string;
  transaction_currency: string;
  original_amount: string;
  open_amount: string;
  carrying_functional_amount: string;
  due_on: string | null;
  derived_status: SubledgerOpenItemDto["status"];
}>;

function readContext(principal: SessionPrincipal): TenantTransactionContext {
  return {
    organizationId: principal.organizationId,
    actorId: principal.userId,
    sessionId: principal.sessionId,
    sessionMode: principal.sessionMode,
    requestId: `subledger-workspace:${randomUUID()}`,
    authMethod: transactionAuthMethod(principal),
    sourceSurface: "UI",
  };
}

function permissionsFor(ownerModule: SubledgerOwnerModule): Readonly<{
  read: Permission;
  manage: Permission;
  post: Permission;
  settle: Permission;
  void: Permission;
}> {
  return ownerModule === "receivables"
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
}

async function assertMembership(
  client: PoolClient,
  principal: SessionPrincipal,
): Promise<boolean> {
  const result = await client.query<{ is_demo: boolean }>(
    `SELECT organization.is_demo
     FROM organization_memberships membership
     JOIN organizations organization
       ON organization.id = membership.organization_id
     WHERE membership.organization_id = $1
       AND membership.id = $2
       AND membership.user_id = $3
       AND membership.active AND organization.active`,
    [principal.organizationId, principal.membershipId, principal.userId],
  );
  const membership = result.rows[0];
  if (!membership) throw new Error("The session no longer has an active organization membership");
  return membership.is_demo;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function accountOptions(
  rows: readonly AccountRow[],
  predicate: (row: AccountRow) => boolean,
): readonly SubledgerAccountOptionDto[] {
  return rows.filter(predicate).map((row) => ({
    combinationId: row.combination_id,
    code: row.code,
    displayName: row.display_name,
    accountClass: row.account_class,
  }));
}

const dueFilters = new Set<SubledgerDueFilter>([
  "ALL", "OVERDUE", "DUE_TODAY", "DUE_LATER", "SETTLED", "NOT_APPLICABLE",
]);

export function normalizeSubledgerRegisterRequest(
  input: string | SubledgerRegisterRequest = "",
): Readonly<{ filter: SubledgerRegisterFilter; page: number }> {
  const candidate = typeof input === "string" ? { search: input } : input;
  const status = ["DRAFT", "POSTED", "VOIDED"].includes(candidate.status ?? "")
    ? candidate.status!
    : "";
  const due = dueFilters.has(candidate.due ?? "ALL") ? candidate.due ?? "ALL" : "ALL";
  const date = (value: string | undefined) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? value! : "";
  return {
    filter: {
      search: (candidate.search ?? "").trim().slice(0, 100),
      entityCode: /^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(candidate.entityCode ?? "")
        ? candidate.entityCode!
        : "",
      status,
      currency: /^[A-Z]{3}$/.test(candidate.currency ?? "") ? candidate.currency! : "",
      dateFrom: date(candidate.dateFrom),
      dateTo: date(candidate.dateTo),
      due,
    },
    page: normalizeRegisterPage(candidate.page),
  };
}

export async function loadSubledgerWorkspace(
  principal: SessionPrincipal,
  ownerModule: SubledgerOwnerModule,
  registerRequest: string | SubledgerRegisterRequest = "",
  preferredEntityId: string | null = null,
): Promise<SubledgerWorkspaceDto> {
  const { filter: registerFilter, page } = normalizeSubledgerRegisterRequest(registerRequest);
  const normalizedSearch = registerFilter.search.toLocaleLowerCase();
  const policy = permissionsFor(ownerModule);
  const role = ownerModule === "receivables" ? "CUSTOMER" : "SUPPLIER";
  const sourceType = ownerModule === "receivables"
    ? "receivables.sales-invoice"
    : "payables.supplier-bill";
  const currentDate = principal.sessionMode === "demo"
    ? demoAccountingDate()
    : new Date().toISOString().slice(0, 10);

  const nextPath = ownerModule === "receivables"
    ? "/app/receivables/invoices"
    : "/app/payables/bills";
  return withWorkspaceTenantRead(readContext(principal), nextPath, async (client) => {
    const demoOnly = await assertMembership(client, principal);
    const canRead = await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: policy.read,
    });
    const writable = principalCanWrite(principal);
    const canManage = canRead && writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: policy.manage,
    });
    const canPost = canRead && writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: policy.post,
    });
    const canSettle = canRead && writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: policy.settle,
    });
    const canVoid = canRead && writable && await actorHasActivePermission(client, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      permission: policy.void,
    });

    if (!canRead) {
      return {
        ownerModule,
        businessKind: ownerModule === "receivables" ? "SALES_INVOICE" : "SUPPLIER_BILL",
        settlementKind: ownerModule === "receivables" ? "CUSTOMER_RECEIPT" : "SUPPLIER_PAYMENT",
        demoOnly,
        canRead,
        canManage,
        canPost,
        canSettle,
        canVoid,
        currentDate,
        currencies: [],
        fxRates: [],
        entities: [],
        documents: [],
        openItems: [],
        registerFilter,
        pagination: {
          page,
          pageSize: registerPageSize,
          hasPrevious: page > 1,
          hasNext: false,
        },
        preferredEntityId: null,
      };
    }

    const entitiesResult = await client.query<EntityRow>(
        `SELECT entity.id, entity.code, entity.display_name,
           entity.country_code, entity.region_code,
           ledger.id AS ledger_id, ledger.functional_currency
         FROM legal_entities entity
         JOIN ledgers ledger
           ON ledger.organization_id = entity.organization_id
          AND ledger.legal_entity_id = entity.id
          AND ledger.kind = 'PRIMARY' AND ledger.active
         WHERE entity.organization_id = $1 AND entity.active
         ORDER BY entity.code`,
        [principal.organizationId],
      );
    const periodsResult = await client.query<PeriodRow>(
        `SELECT period.id, period.ledger_id, period.label,
           period.starts_on::text, period.ends_on::text
         FROM fiscal_periods period
         JOIN ledgers ledger
           ON ledger.organization_id = period.organization_id
          AND ledger.id = period.ledger_id AND ledger.active
         WHERE period.organization_id = $1 AND period.state = 'OPEN'
         ORDER BY period.starts_on`,
        [principal.organizationId],
      );
    const accountsResult = await client.query<AccountRow>(
        `SELECT entity.id AS legal_entity_id, combination.id AS combination_id,
           account.code, account.display_name, account.class AS account_class
         FROM account_combinations combination
         JOIN legal_entities entity
           ON entity.organization_id = combination.organization_id
          AND entity.id = combination.entity_id AND entity.active
         JOIN gl_accounts account
           ON account.organization_id = combination.organization_id
          AND account.ledger_id = combination.ledger_id
          AND account.id = combination.account_id
         WHERE combination.organization_id = $1
           AND combination.active AND account.active AND account.postable
           AND account.control_kind = 'NONE'
           AND account.valid_from <= $2::date
           AND (account.valid_to IS NULL OR account.valid_to >= $2::date)
         ORDER BY entity.code, account.code, combination.id`,
        [principal.organizationId, currentDate],
      );
    const partyAccountsResult = await client.query<PartyAccountRow>(
        `SELECT account.id, account.legal_entity_id, party.id AS party_id,
           party.party_number, party.display_name_ciphertext,
           party.display_name_key_version, account.account_number,
           account.transaction_currency, control_combination.id AS control_combination_id
         FROM party_accounts account
         JOIN parties party
           ON party.organization_id = account.organization_id
          AND party.id = account.party_id AND party.active
         JOIN account_combinations control_combination
           ON control_combination.organization_id = account.organization_id
          AND control_combination.ledger_id = account.ledger_id
          AND control_combination.entity_id = account.legal_entity_id
          AND control_combination.account_id = account.control_account_id
          AND control_combination.active
         WHERE account.organization_id = $1 AND account.role = $2 AND account.active
         ORDER BY account.account_number`,
        [principal.organizationId, role],
      );
    const taxResult = await client.query<TaxRow>(
        `SELECT registration.legal_entity_id,
           registration.id AS registration_id, registration.regime_key,
           registration.destination_country, registration.destination_region,
           registration.destination_city, registration.location_code,
           registration.valid_to::text AS registration_valid_to,
           version.effective_from::text AS pack_effective_from,
           version.effective_to::text AS pack_effective_to
         FROM entity_tax_registrations registration
         LEFT JOIN LATERAL (
           SELECT pack.effective_from, pack.effective_to
           FROM tax_pack_versions pack
           WHERE pack.pack_key = registration.regime_key
             AND pack.effective_from <= $2::date
           ORDER BY pack.effective_from DESC, pack.approved_at DESC
           LIMIT 1
         ) version ON true
         WHERE registration.organization_id = $1
           AND registration.valid_from <= $2::date
         ORDER BY registration.legal_entity_id, registration.valid_from DESC,
           registration.id DESC`,
        [principal.organizationId, currentDate],
      );
    const currencyResult = await client.query<{ code: string; minor_units: number }>(
         `SELECT definition.code, definition.minor_units
         FROM currency_definitions definition
         WHERE (
             definition.active
             AND EXISTS (
               SELECT 1
               FROM organization_currencies configured
               WHERE configured.organization_id = $1
                 AND configured.currency_code = definition.code
                 AND configured.enabled
             )
           )
           OR EXISTS (
             SELECT 1
             FROM ledgers functional_ledger
             WHERE functional_ledger.organization_id = $1
               AND functional_ledger.functional_currency = definition.code
               AND functional_ledger.active
           )
         ORDER BY CASE definition.code WHEN 'USD' THEN 0 WHEN 'CAD' THEN 1 ELSE 2 END,
           definition.code`,
        [principal.organizationId],
      );
    const fxRateResult = await client.query<{
      id: string;
      source_currency: string;
      target_currency: string;
      rate: string;
      effective_at: string;
      source: string;
    }>(
        `SELECT rate.id, rate.source_currency, rate.target_currency,
           rate.rate::text, rate.effective_at::text, rate.source
         FROM currency_exchange_rates rate
         WHERE rate.organization_id = $1
         ORDER BY rate.effective_at DESC, rate.created_at DESC, rate.id DESC
         LIMIT 500`,
        [principal.organizationId],
      );
    let partySearchToken: ReturnType<typeof createBlindIndex> | null = null;
    if (normalizedSearch && partyAccountsResult.rows.length > 0) {
      const searchKey = await loadActiveOrganizationKey(client, principal.organizationId);
      try {
        partySearchToken = createBlindIndex(
          registerFilter.search,
          searchKey.dek,
          principal.organizationId,
          "parties.display-name",
        );
      } finally {
        searchKey.dek.fill(0);
      }
    }
    const searchPattern = `%${normalizedSearch.replace(/[\\%_]/g, "\\$&")}%`;
    const documentsResult = await client.query<DocumentRow>(
        `SELECT current.id, current.source_type, current.source_number,
           current.version, current.status, current.snapshot,
           current.created_at, current.void_reason,
           linked_journal.id AS journal_id,
           linked_journal.journal_number,
           balance.id AS open_item_id,
           balance.open_transaction_amount::text AS open_amount,
           balance.derived_status AS open_status
         FROM source_documents current
         LEFT JOIN LATERAL (
           SELECT journal.id, journal.journal_number
           FROM journal_entries journal
           WHERE journal.organization_id = current.organization_id
             AND journal.status = 'POSTED'
             AND journal.source_document_id IN (
               current.id, coalesce(current.supersedes_source_document_id, current.id)
             )
           ORDER BY journal.created_at DESC, journal.id DESC
           LIMIT 1
         ) linked_journal ON true
         LEFT JOIN LATERAL (
           SELECT item_balance.*
           FROM source_documents posted_source
           JOIN subledger_events event
             ON event.organization_id = posted_source.organization_id
            AND event.source_document_id = posted_source.id
           JOIN open_item_balances item_balance
             ON item_balance.organization_id = event.organization_id
            AND item_balance.source_event_id = event.id
           WHERE posted_source.organization_id = current.organization_id
             AND posted_source.source_type = current.source_type
             AND posted_source.source_number = current.source_number
           ORDER BY posted_source.version DESC
           LIMIT 1
         ) balance ON true
         WHERE current.organization_id = $1
           AND current.owner_module = $2
           AND ($3 = '' OR current.source_number ILIKE $4 ESCAPE '\\'
             OR current.source_type ILIKE $4 ESCAPE '\\'
             OR current.status::text ILIKE $4 ESCAPE '\\'
             OR current.snapshot ->> 'description' ILIKE $4 ESCAPE '\\'
             OR current.snapshot ->> 'currency' ILIKE $4 ESCAPE '\\'
             OR linked_journal.journal_number::text ILIKE $4 ESCAPE '\\'
             OR EXISTS (
               SELECT 1
               FROM party_accounts searched_account
               JOIN parties searched_party
                 ON searched_party.organization_id = searched_account.organization_id
                AND searched_party.id = searched_account.party_id
               WHERE searched_account.organization_id = current.organization_id
                 AND searched_account.id::text = current.snapshot ->> 'partyAccountId'
                 AND searched_party.search_token = $5
             )
             OR EXISTS (
               SELECT 1 FROM legal_entities searched_entity
               WHERE searched_entity.organization_id = current.organization_id
                 AND searched_entity.id::text = current.snapshot ->> 'legalEntityId'
                 AND searched_entity.code ILIKE $4 ESCAPE '\\'
             ))
           AND ($6 = '' OR EXISTS (
             SELECT 1 FROM legal_entities filtered_entity
             WHERE filtered_entity.organization_id = current.organization_id
               AND filtered_entity.id::text = current.snapshot ->> 'legalEntityId'
               AND filtered_entity.code = $6
           ))
           AND ($7 = '' OR current.status::text = $7)
           AND ($8 = '' OR current.snapshot ->> 'currency' = $8)
           AND ($9 = '' OR coalesce(current.snapshot ->> 'documentDate', current.snapshot ->> 'settlementDate') >= $9)
           AND ($10 = '' OR coalesce(current.snapshot ->> 'documentDate', current.snapshot ->> 'settlementDate') <= $10)
           AND (
             $11 = 'ALL'
             OR ($11 = 'NOT_APPLICABLE' AND (NOT (current.snapshot ? 'dueOn') OR balance.id IS NULL))
             OR ($11 = 'SETTLED' AND current.snapshot ? 'dueOn' AND balance.id IS NOT NULL AND balance.open_transaction_amount <= 0)
             OR ($11 = 'OVERDUE' AND current.snapshot ? 'dueOn' AND balance.open_transaction_amount > 0 AND (current.snapshot ->> 'dueOn') < $12)
             OR ($11 = 'DUE_TODAY' AND current.snapshot ? 'dueOn' AND balance.open_transaction_amount > 0 AND (current.snapshot ->> 'dueOn') = $12)
             OR ($11 = 'DUE_LATER' AND current.snapshot ? 'dueOn' AND balance.open_transaction_amount > 0 AND (current.snapshot ->> 'dueOn') > $12)
           )
           AND NOT EXISTS (
             SELECT 1 FROM source_documents newer
             WHERE newer.organization_id = current.organization_id
               AND newer.source_type = current.source_type
               AND newer.source_number = current.source_number
               AND newer.version > current.version
         )
         ORDER BY current.created_at DESC, current.source_number
         LIMIT $13 OFFSET $14`,
        [
          principal.organizationId,
          ownerModule,
          normalizedSearch,
          searchPattern,
          partySearchToken,
          registerFilter.entityCode,
          registerFilter.status,
          registerFilter.currency,
          registerFilter.dateFrom,
          registerFilter.dateTo,
          registerFilter.due,
          currentDate,
          registerPageSize + 1,
          (page - 1) * registerPageSize,
        ],
      );
    const openItemsResult = await client.query<OpenItemRow>(
        `SELECT balance.id, source.source_number,
           balance.party_account_id, entity.code AS entity_code,
           balance.ledger_id, balance.transaction_currency,
           balance.original_transaction_amount::text AS original_amount,
           balance.open_transaction_amount::text AS open_amount,
           balance.carrying_functional_amount::text,
           balance.due_on::text, balance.derived_status
         FROM open_item_balances balance
         JOIN subledger_events event
           ON event.organization_id = balance.organization_id
          AND event.id = balance.source_event_id
         JOIN source_documents source
           ON source.organization_id = event.organization_id
          AND source.id = event.source_document_id
         JOIN party_accounts account
           ON account.organization_id = balance.organization_id
          AND account.id = balance.party_account_id
         JOIN legal_entities entity
           ON entity.organization_id = account.organization_id
          AND entity.id = account.legal_entity_id
         WHERE balance.organization_id = $1
           AND source.source_type = $2
           AND balance.open_transaction_amount > 0
           AND balance.derived_status IN ('OPEN', 'PARTIALLY_SETTLED')
         ORDER BY balance.due_on NULLS LAST, source.source_number`,
        [principal.organizationId, sourceType],
      );

    const activeKey = partyAccountsResult.rows.length > 0
      ? await loadActiveOrganizationKey(client, principal.organizationId)
      : null;
    const partyNameByAccount = new Map<string, string>();
    try {
      if (activeKey) {
        for (const account of partyAccountsResult.rows) {
          partyNameByAccount.set(account.id, decryptField(
            parseEncryptedField(account.display_name_ciphertext),
            activeKey.dek,
            {
              organizationId: principal.organizationId,
              table: "parties",
              column: "display_name_ciphertext",
              recordId: account.party_id,
              keyVersion: account.display_name_key_version,
            },
          ));
        }
      }
    } finally {
      activeKey?.dek.fill(0);
    }

    const periodsByLedger = new Map<string, PeriodRow[]>();
    for (const period of periodsResult.rows) {
      const existing = periodsByLedger.get(period.ledger_id) ?? [];
      existing.push(period);
      periodsByLedger.set(period.ledger_id, existing);
    }
    const accountsByEntity = new Map<string, AccountRow[]>();
    for (const account of accountsResult.rows) {
      const existing = accountsByEntity.get(account.legal_entity_id) ?? [];
      existing.push(account);
      accountsByEntity.set(account.legal_entity_id, existing);
    }
    const partyAccountsByEntity = new Map<string, PartyAccountRow[]>();
    for (const account of partyAccountsResult.rows) {
      const existing = partyAccountsByEntity.get(account.legal_entity_id) ?? [];
      existing.push(account);
      partyAccountsByEntity.set(account.legal_entity_id, existing);
    }
    const taxByEntity = new Map<string, TaxRow>();
    for (const registration of taxResult.rows) {
      if (!taxByEntity.has(registration.legal_entity_id)) {
        taxByEntity.set(registration.legal_entity_id, registration);
      }
    }

    const entities = entitiesResult.rows.map<SubledgerEntityOptionDto>((entity) => {
      const accounts = accountsByEntity.get(entity.id) ?? [];
      const taxCandidate = taxByEntity.get(entity.id);
      const tax = taxCandidate
        && (!taxCandidate.registration_valid_to || taxCandidate.registration_valid_to >= currentDate)
        ? taxCandidate
        : undefined;
      const configuredTax = tax?.destination_country && tax.destination_region ? tax : undefined;
      const countryCode = entity.country_code.toUpperCase();
      const regionCode = entity.region_code.toUpperCase();
      return {
        id: entity.id,
        code: entity.code,
        displayName: entity.display_name,
        countryCode,
        regionCode,
        ledgerId: entity.ledger_id,
        functionalCurrency: entity.functional_currency,
        periods: (periodsByLedger.get(entity.ledger_id) ?? []).map((period) => ({
          id: period.id,
          label: period.label,
          startsOn: period.starts_on,
          endsOn: period.ends_on,
        })),
        partyAccounts: (partyAccountsByEntity.get(entity.id) ?? []).map((account) => ({
          id: account.id,
          partyId: account.party_id,
          partyNumber: account.party_number,
          partyName: partyNameByAccount.get(account.id) ?? "Encrypted party",
          accountNumber: account.account_number,
          transactionCurrency: account.transaction_currency,
          controlAccountCombinationId: account.control_combination_id,
        })),
        lineAccounts: accountOptions(accounts, (account) => ownerModule === "receivables"
          ? account.account_class === "REVENUE"
          : account.account_class === "EXPENSE" || account.account_class === "ASSET"),
        taxAccounts: accountOptions(accounts, (account) => ownerModule === "receivables"
          ? account.account_class === "LIABILITY"
          : account.account_class === "ASSET" || account.account_class === "EXPENSE"
            || account.account_class === "LIABILITY"),
        bankAccounts: accountOptions(accounts, (account) => account.account_class === "ASSET"),
        fxGainAccounts: accountOptions(accounts, (account) => account.account_class === "REVENUE"),
        fxLossAccounts: accountOptions(accounts, (account) => account.account_class === "EXPENSE"),
        roundingAccounts: accountOptions(accounts, () => true),
        tax: {
          packKey: configuredTax?.regime_key ?? "generic.unsupported",
          registrationReference: configuredTax?.registration_id ?? null,
          destinationCountry: configuredTax?.destination_country ?? "ZZ",
          destinationRegion: configuredTax?.destination_region ?? "NA",
          destinationCity: configuredTax?.destination_city ?? null,
          locationCode: configuredTax?.location_code ?? null,
          effectiveFrom: configuredTax?.pack_effective_from ?? null,
          effectiveTo: configuredTax?.pack_effective_to ?? null,
        },
      };
    });

    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const partyAccountById = new Map(entities.flatMap((entity) =>
      entity.partyAccounts.map((account) => [account.id, account] as const)));
    const documentPage = registerPageWindow(documentsResult.rows, page);
    const documents = documentPage.rows.map<SubledgerWorkspaceDocumentDto>((row) => {
      const snapshot = subledgerSourceSnapshotSchema.parse(row.snapshot);
      const party = partyAccountById.get(snapshot.partyAccountId);
      const entity = entityById.get(snapshot.legalEntityId);
      return {
        id: row.id,
        sourceNumber: row.source_number,
        sourceType: row.source_type,
        version: row.version,
        status: row.status,
        snapshot,
        createdAt: iso(row.created_at),
        voidReason: row.void_reason,
        partyName: party?.partyName ?? "Party account unavailable",
        entityCode: entity?.code ?? "Unknown entity",
        journalId: row.journal_id,
        journalNumber: row.journal_number,
        openItemId: row.open_item_id,
        openAmount: row.open_amount,
        openStatus: row.open_status,
      };
    });
    const openItems = openItemsResult.rows.map<SubledgerOpenItemDto>((item) => ({
      id: item.id,
      sourceNumber: item.source_number,
      partyAccountId: item.party_account_id,
      partyName: partyAccountById.get(item.party_account_id)?.partyName ?? "Party account unavailable",
      entityCode: item.entity_code,
      ledgerId: item.ledger_id,
      currency: item.transaction_currency,
      originalAmount: item.original_amount,
      openAmount: item.open_amount,
      carryingFunctionalAmount: item.carrying_functional_amount,
      dueOn: item.due_on,
      status: item.derived_status,
    }));

    return {
      ownerModule,
      businessKind: ownerModule === "receivables" ? "SALES_INVOICE" : "SUPPLIER_BILL",
      settlementKind: ownerModule === "receivables" ? "CUSTOMER_RECEIPT" : "SUPPLIER_PAYMENT",
      demoOnly,
      canRead,
      canManage,
      canPost,
      canSettle,
      canVoid,
      currentDate,
      currencies: currencyResult.rows.map((currency) => ({
        code: currency.code,
        minorUnits: currency.minor_units,
      })),
      fxRates: fxRateResult.rows.map((rate) => ({
        id: rate.id,
        sourceCurrency: rate.source_currency,
        targetCurrency: rate.target_currency,
        rate: rate.rate,
        effectiveAt: rate.effective_at,
        source: rate.source,
      })),
      entities,
      documents,
      openItems,
      registerFilter,
      pagination: documentPage.pagination,
      preferredEntityId: entities.some((entity) => entity.id === preferredEntityId)
        ? preferredEntityId
        : entities[0]?.id ?? null,
    };
  });
}
