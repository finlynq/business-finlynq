import "server-only";

import type { PoolClient } from "pg";
import { exact } from "@/kernel/money";
import { readOrganizationFxProviderPolicy } from "@/modules/fx/provider-policy";
import {
  fetchYahooFxChartRate,
  yahooDirectFxSymbol,
  YahooFxChartError,
  type YahooFxChartErrorCode,
  type YahooFxChartObservation,
} from "@/modules/fx/yahoo-chart-adapter";

export const STORED_DIRECT_FX_POLICY = Object.freeze({
  key: "STORED_DIRECT_LATEST_EFFECTIVE_UTC_DATE",
  version: 1,
});

export const YAHOO_DIRECT_FX_POLICY = Object.freeze({
  key: "YAHOO_FINANCE_EXPERIMENTAL_DIRECT_DAILY_CLOSE",
});

const UTC_DAY_MS = 24 * 60 * 60 * 1_000;

type ExplicitFx = Readonly<{
  rate: string;
  source: string;
  effectiveAt: string;
  quoteConvention?: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT";
}>;

export type ResolvedFx = Readonly<{
  rate: string;
  source: string;
  effectiveAt: string;
  quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT";
  provenance: Readonly<{
    mode: "FUNCTIONAL" | "ORGANIZATION_RATE" | "PROVIDER_RATE" | "EXPLICIT";
    asOfDate: string;
    resolvedAt: string;
    policyKey: string;
    policyVersion: number;
    organizationRateId?: string;
    rateRecordedAt?: string;
    providerKey?: "YAHOO_FINANCE_EXPERIMENTAL";
    providerSymbol?: string;
    providerObservedAt?: string;
    providerRetrievedAt?: string;
    providerResponseSha256?: string;
    providerMaxLookbackDays?: number;
  }>;
}>;

export type FxRateResolverDependencies = Readonly<{
  yahooFxEnabled?: boolean;
  fetchYahooFxRate?: (input: Readonly<{
    enabled: boolean;
    sourceCurrency: string;
    targetCurrency: string;
    asOfDate: string;
  }>) => Promise<YahooFxChartObservation>;
}>;

type StoredRateRow = Readonly<{
  id: string;
  source_currency: string;
  target_currency: string;
  rate: string;
  effective_at: Date | string;
  source: string;
  created_at: Date | string;
  resolved_at: Date | string;
}>;

function timestamp(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`Stored FX ${field} is invalid`);
  return parsed.toISOString();
}

function coreProvenance(
  mode: "FUNCTIONAL" | "EXPLICIT",
  asOfDate: string,
  resolvedAt: string,
): ResolvedFx["provenance"] {
  return {
    mode,
    asOfDate,
    resolvedAt,
    policyKey: mode === "FUNCTIONAL" ? "FUNCTIONAL_IDENTITY" : "CALLER_EXPLICIT",
    policyVersion: 1,
  };
}

function storedProvenance(
  asOfDate: string,
  resolvedAt: string,
  stored: Pick<StoredRateRow, "id" | "created_at">,
): ResolvedFx["provenance"] {
  return {
    mode: "ORGANIZATION_RATE",
    asOfDate,
    resolvedAt,
    policyKey: STORED_DIRECT_FX_POLICY.key,
    policyVersion: STORED_DIRECT_FX_POLICY.version,
    organizationRateId: stored.id,
    rateRecordedAt: timestamp(stored.created_at, "recorded time"),
  };
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validProviderObservation(
  observation: YahooFxChartObservation,
  transactionCurrency: string,
  functionalCurrency: string,
  asOfDate: string,
  maxLookbackDays: number,
): boolean {
  const asOfStart = Date.parse(`${asOfDate}T00:00:00.000Z`);
  const observedAt = Date.parse(observation.observedAt);
  if (!Number.isFinite(asOfStart)
      || !Number.isFinite(observedAt)
      || !Number.isInteger(maxLookbackDays)
      || maxLookbackDays < 1
      || maxLookbackDays > 7
      || !canonicalTimestamp(observation.observedAt)
      || !canonicalTimestamp(observation.retrievedAt)
      || observation.symbol !== yahooDirectFxSymbol(transactionCurrency, functionalCurrency)
      || !/^[a-f0-9]{64}$/.test(observation.rawBodySha256)) return false;
  try {
    if (!exact(observation.rate).greaterThan(0)) return false;
  } catch {
    return false;
  }
  return observedAt >= asOfStart - (maxLookbackDays * UTC_DAY_MS)
    && observedAt < asOfStart + UTC_DAY_MS;
}

export class FxRateUnavailableError extends Error {
  readonly code = "FX_RATE_UNAVAILABLE";

  constructor(
    readonly transactionCurrency: string,
    readonly functionalCurrency: string,
    readonly asOfDate: string,
    readonly providerFailureCode?: YahooFxChartErrorCode,
  ) {
    super(
      `No approved ${transactionCurrency}/${functionalCurrency} FX rate is available for ${asOfDate}. Record a direct organization rate, provide explicit FX evidence, or configure an available provider.`,
    );
    this.name = "FxRateUnavailableError";
  }
}

export async function resolveFx(
  client: PoolClient,
  input: Readonly<{
    organizationId: string;
    transactionCurrency: string;
    functionalCurrency: string;
    asOfDate: string;
    explicitFx?: ExplicitFx;
  }>,
  dependencies: FxRateResolverDependencies = {},
): Promise<ResolvedFx> {
  const transactionCurrency = input.transactionCurrency.trim().toUpperCase();
  const functionalCurrency = input.functionalCurrency.trim().toUpperCase();
  const resolvedAt = new Date().toISOString();

  if (input.explicitFx) {
    return {
      ...input.explicitFx,
      rate: exact(input.explicitFx.rate).toFixed(),
      quoteConvention: input.explicitFx.quoteConvention
        ?? "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
      provenance: coreProvenance("EXPLICIT", input.asOfDate, resolvedAt),
    };
  }

  if (transactionCurrency === functionalCurrency) {
    return {
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: `${input.asOfDate}T00:00:00.000Z`,
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
      provenance: coreProvenance("FUNCTIONAL", input.asOfDate, resolvedAt),
    };
  }

  const result = await client.query<StoredRateRow>(
    `SELECT rate.id, rate.source_currency, rate.target_currency,
       rate.rate::text, rate.effective_at, rate.source, rate.created_at,
       statement_timestamp() AS resolved_at
     FROM currency_exchange_rates rate
     JOIN organization_currencies source_configuration
       ON source_configuration.organization_id = rate.organization_id
      AND source_configuration.currency_code = rate.source_currency
      AND source_configuration.enabled
     JOIN organization_currencies target_configuration
       ON target_configuration.organization_id = rate.organization_id
      AND target_configuration.currency_code = rate.target_currency
      AND target_configuration.enabled
     WHERE rate.organization_id = $1
       AND rate.source_currency = $2
       AND rate.target_currency = $3
       AND (rate.effective_at AT TIME ZONE 'UTC')::date <= $4::date
     ORDER BY rate.effective_at DESC, rate.created_at DESC, rate.id DESC
     LIMIT 1`,
    [input.organizationId, transactionCurrency, functionalCurrency, input.asOfDate],
  );
  const stored = result.rows[0];
  if (stored) {
    if (stored.source_currency !== transactionCurrency
        || stored.target_currency !== functionalCurrency) {
      throw new FxRateUnavailableError(transactionCurrency, functionalCurrency, input.asOfDate);
    }
    return {
      rate: exact(stored.rate).toFixed(),
      source: stored.source,
      effectiveAt: timestamp(stored.effective_at, "effective time"),
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
      provenance: storedProvenance(
        input.asOfDate,
        timestamp(stored.resolved_at, "resolution time"),
        stored,
      ),
    };
  }

  const policy = await readOrganizationFxProviderPolicy(client, input.organizationId);
  if (policy.providerMode !== "YAHOO_FINANCE_EXPERIMENTAL"
      || !policy.licensedAndAuthorizedUseAcknowledged) {
    throw new FxRateUnavailableError(transactionCurrency, functionalCurrency, input.asOfDate);
  }

  const yahooEnabled = dependencies.yahooFxEnabled
    ?? process.env.YAHOO_FX_ENABLED === "true";
  if (!yahooEnabled) {
    throw new FxRateUnavailableError(
      transactionCurrency,
      functionalCurrency,
      input.asOfDate,
      "YAHOO_FX_DISABLED",
    );
  }

  let providerRate: YahooFxChartObservation;
  try {
    const fetchRate = dependencies.fetchYahooFxRate ?? ((request) => (
      fetchYahooFxChartRate(request)
    ));
    providerRate = await fetchRate({
      enabled: true,
      sourceCurrency: transactionCurrency,
      targetCurrency: functionalCurrency,
      asOfDate: input.asOfDate,
    });
  } catch (error) {
    throw new FxRateUnavailableError(
      transactionCurrency,
      functionalCurrency,
      input.asOfDate,
      error instanceof YahooFxChartError ? error.code : "YAHOO_FX_NETWORK_ERROR",
    );
  }

  if (!Number.isInteger(policy.version) || policy.version <= 0 || !validProviderObservation(
    providerRate,
    transactionCurrency,
    functionalCurrency,
    input.asOfDate,
    policy.maxLookbackDays,
  )) {
    throw new FxRateUnavailableError(
      transactionCurrency,
      functionalCurrency,
      input.asOfDate,
      "YAHOO_FX_OBSERVATION_UNAVAILABLE",
    );
  }

  return {
    rate: exact(providerRate.rate).toDecimalPlaces(18).toFixed(),
    source: "Yahoo Finance / ICE Data Services",
    effectiveAt: providerRate.observedAt,
    quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
    provenance: {
      mode: "PROVIDER_RATE",
      asOfDate: input.asOfDate,
      resolvedAt: providerRate.retrievedAt,
      policyKey: YAHOO_DIRECT_FX_POLICY.key,
      policyVersion: policy.version,
      providerKey: "YAHOO_FINANCE_EXPERIMENTAL",
      providerSymbol: providerRate.symbol,
      providerObservedAt: providerRate.observedAt,
      providerRetrievedAt: providerRate.retrievedAt,
      providerResponseSha256: providerRate.rawBodySha256,
      providerMaxLookbackDays: policy.maxLookbackDays,
    },
  };
}
