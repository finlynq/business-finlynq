import Decimal from "decimal.js";
import { supportedCurrencies } from "@/kernel/money";
import type {
  SimpleFinAccount,
  SimpleFinAccountsResponse,
  SimpleFinTransaction,
} from "./simplefin-client";

/**
 * Protocol-field interpretation is adapted from Finlynq's AGPL-3.0-only
 * SimpleFIN transform. Amounts remain decimal strings here; Business Finlynq
 * never converts bank money through a JavaScript number.
 */

export type NormalizedBankTransaction = Readonly<{
  providerTransactionId: string;
  status: "POSTED" | "PENDING";
  postedOn: string;
  transactedAt: string | null;
  amount: string;
  currencyCode: string;
  details: Readonly<{
    payee: string | null;
    description: string | null;
    memo: string | null;
    merchantCategoryCode: string | null;
  }>;
}>;

export type NormalizedBankAccount = Readonly<{
  providerAccountId: string;
  displayName: string;
  currencyCode: string;
  balance: string | null;
  availableBalance: string | null;
  balanceAt: string | null;
  transactions: readonly NormalizedBankTransaction[];
}>;

export type NormalizedSimpleFinPayload = Readonly<{
  accounts: readonly NormalizedBankAccount[];
  warnings: readonly string[];
}>;

const MAX_ACCOUNTS = 100;
const MAX_TRANSACTIONS_PER_ACCOUNT = 10_000;
const MAX_TRANSACTIONS_PER_SYNC = 5_000;

function safeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function opaqueIdentifier(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return null;
  if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function exactDecimal(value: unknown, options: Readonly<{ allowZero: boolean }>): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    // JSON fractional numbers have already passed through IEEE-754 before this
    // boundary, so their original decimal value cannot be proven. SimpleFIN
    // defines money as strings; accept numeric compatibility values only when
    // they are exactly representable safe integers.
    if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
    const text = typeof value === "number" ? String(value) : value;
    if (text.length > 40 || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(text)) return null;
    const decimal = new Decimal(text);
    if (!decimal.isFinite() || decimal.abs().greaterThan("99999999999999999999999999999")) return null;
    if (!options.allowZero && decimal.isZero()) return null;
    return decimal.toFixed(decimal.decimalPlaces());
  } catch {
    return null;
  }
}

function isoDateFromEpoch(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 7_258_118_400) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function isoInstantFromEpoch(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 7_258_118_400) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function currencyCode(account: SimpleFinAccount): string | null {
  const normalized = safeText(account.currency, 20)?.toUpperCase() ?? "";
  return /^[A-Z]{3}$/.test(normalized) && supportedCurrencies.includes(normalized) ? normalized : null;
}

function isPending(transaction: SimpleFinTransaction): boolean {
  return transaction.pending === true || /\bpending\b/i.test(transaction.description ?? "");
}

function normalizeTransaction(
  transaction: SimpleFinTransaction,
  accountCurrency: string,
): NormalizedBankTransaction | null {
  const providerTransactionId = opaqueIdentifier(transaction.id, 500);
  const postedOn = isoDateFromEpoch(transaction.posted || transaction.transacted_at);
  const amount = exactDecimal(transaction.amount, { allowZero: false });
  if (!providerTransactionId || !postedOn || !amount) return null;
  return {
    providerTransactionId,
    status: isPending(transaction) ? "PENDING" : "POSTED",
    postedOn,
    transactedAt: isoInstantFromEpoch(transaction.transacted_at),
    amount,
    currencyCode: accountCurrency,
    details: {
      payee: safeText(transaction.payee, 500),
      description: safeText(transaction.description, 2000),
      memo: safeText(transaction.memo, 2000),
      merchantCategoryCode: safeText(transaction.mcc, 16),
    },
  };
}

export function normalizeSimpleFinPayload(response: SimpleFinAccountsResponse): NormalizedSimpleFinPayload {
  if (response.accounts.length > MAX_ACCOUNTS) {
    throw new Error("SimpleFIN returned more accounts than the safe ingestion limit");
  }
  const warnings = (response.errors ?? []).slice(0, 100).map(() => "The provider reported an account-level warning.");
  const accounts: NormalizedBankAccount[] = [];
  const seenAccountIds = new Set<string>();
  let transactionCount = 0;

  for (const account of response.accounts) {
    const providerAccountId = opaqueIdentifier(account.id, 500);
    const currency = currencyCode(account);
    if (!providerAccountId || seenAccountIds.has(providerAccountId) || !currency) {
      warnings.push("A provider account with invalid identity or unsupported currency was skipped.");
      continue;
    }
    seenAccountIds.add(providerAccountId);
    const rawTransactions = Array.isArray(account.transactions) ? account.transactions : [];
    if (rawTransactions.length > MAX_TRANSACTIONS_PER_ACCOUNT) {
      throw new Error("SimpleFIN returned more transactions than the safe per-account limit");
    }
    transactionCount += rawTransactions.length;
    if (transactionCount > MAX_TRANSACTIONS_PER_SYNC) {
      throw new Error("SimpleFIN returned more transactions than the safe sync limit");
    }
    const transactions: NormalizedBankTransaction[] = [];
    for (const rawTransaction of rawTransactions) {
      const normalized = normalizeTransaction(rawTransaction, currency);
      if (normalized) transactions.push(normalized);
      else warnings.push("A provider transaction with invalid identity, date, or amount was skipped.");
    }
    accounts.push({
      providerAccountId,
      displayName: safeText(account.name, 200) ?? safeText(account.org?.name, 200) ?? "Connected bank account",
      currencyCode: currency,
      balance: exactDecimal(account.balance, { allowZero: true }),
      availableBalance: exactDecimal(account["available-balance"], { allowZero: true }),
      balanceAt: isoInstantFromEpoch(account["balance-date"]),
      transactions,
    });
  }
  return { accounts, warnings: warnings.slice(0, 500) };
}
