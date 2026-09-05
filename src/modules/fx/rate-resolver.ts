import "server-only";

import type { PoolClient } from "pg";
import { exact } from "@/kernel/money";
import {
  bankOfCanadaFxSeriesKey,
  BankOfCanadaValetError,
  fetchBankOfCanadaFxRate,
  type BankOfCanadaFxCalculation,
  type BankOfCanadaFxFormula,
  type BankOfCanadaFxObservation,
  type BankOfCanadaValetErrorCode,
} from "@/modules/fx/bank-of-canada-valet-adapter";
import {
  EcbFxReferenceError,
  fetchEcbFxReferenceRate,
  type EcbFxReferenceCalculation,
  type EcbFxReferenceErrorCode,
  type EcbFxReferenceFormula,
  type EcbFxReferenceObservation,
} from "@/modules/fx/ecb-reference-rate-adapter";
import { fxProviderObservationCache } from "@/modules/fx/provider-observation-cache";
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

export const BANK_OF_CANADA_REFERENCE_FX_POLICY = Object.freeze({
  key: "BANK_OF_CANADA_DAILY_REFERENCE_RATE",
});

export const ECB_REFERENCE_FX_POLICY = Object.freeze({
  key: "EUROPEAN_CENTRAL_BANK_REFERENCE_RATE",
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

export type ResolvedFxProviderLeg = Readonly<{
  currency: string;
  rate: string;
  rateConvention: "CAD_PER_CURRENCY_UNIT" | "CURRENCY_UNITS_PER_EUR";
  observedDate: string;
  seriesKey: string;
}>;

type ProviderCalculation = BankOfCanadaFxCalculation | EcbFxReferenceCalculation;
type ProviderFormula = BankOfCanadaFxFormula | EcbFxReferenceFormula;
type ProviderKey =
  | "BANK_OF_CANADA"
  | "EUROPEAN_CENTRAL_BANK"
  | "YAHOO_FINANCE_EXPERIMENTAL";

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
    providerKey?: ProviderKey;
    providerSymbol?: string;
    providerSourceCurrency?: string;
    providerTargetCurrency?: string;
    providerObservedAt?: string;
    providerRetrievedAt?: string;
    providerResponseSha256?: string;
    providerMaxLookbackDays?: number;
    providerCalculation?: ProviderCalculation;
    providerFormula?: ProviderFormula;
    providerLegs?: ResolvedFxProviderLeg[];
  }>;
}>;

type ProviderRequest = Readonly<{
  sourceCurrency: string;
  targetCurrency: string;
  asOfDate: string;
}>;

export type FxRateResolverDependencies = Readonly<{
  yahooFxEnabled?: boolean;
  fetchYahooFxRate?: (input: Readonly<ProviderRequest & { enabled: boolean }>) => Promise<YahooFxChartObservation>;
  fetchBankOfCanadaFxRate?: (input: ProviderRequest) => Promise<BankOfCanadaFxObservation>;
  fetchEcbFxRate?: (input: ProviderRequest) => Promise<EcbFxReferenceObservation>;
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
  if (Number.isNaN(parsed.valueOf())) throw new Error("Stored FX " + field + " is invalid");
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

function positiveDecimal(value: string): boolean {
  try {
    return exact(value).greaterThan(0);
  } catch {
    return false;
  }
}

function validProviderWindow(
  observedAtValue: string,
  retrievedAtValue: string,
  rawBodySha256: string,
  rate: string,
  asOfDate: string,
  maxLookbackDays: number,
): boolean {
  const asOfStart = Date.parse(asOfDate + "T00:00:00.000Z");
  const observedAt = Date.parse(observedAtValue);
  const retrievedAt = Date.parse(retrievedAtValue);
  return Number.isFinite(asOfStart)
    && Number.isFinite(observedAt)
    && Number.isFinite(retrievedAt)
    && Number.isInteger(maxLookbackDays)
    && maxLookbackDays >= 1
    && maxLookbackDays <= 7
    && canonicalTimestamp(observedAtValue)
    && canonicalTimestamp(retrievedAtValue)
    && /^[a-f0-9]{64}$/.test(rawBodySha256)
    && positiveDecimal(rate)
    && retrievedAt >= observedAt
    && retrievedAt <= Date.now()
    && observedAt >= asOfStart - (maxLookbackDays * UTC_DAY_MS)
    && observedAt < asOfStart + UTC_DAY_MS;
}

function validYahooProviderObservation(
  observation: YahooFxChartObservation,
  transactionCurrency: string,
  functionalCurrency: string,
  asOfDate: string,
  maxLookbackDays: number,
): boolean {
  return validProviderWindow(
    observation.observedAt,
    observation.retrievedAt,
    observation.rawBodySha256,
    observation.rate,
    asOfDate,
    maxLookbackDays,
  ) && observation.symbol === yahooDirectFxSymbol(transactionCurrency, functionalCurrency);
}

function bankOfCanadaExpectation(
  sourceCurrency: string,
  targetCurrency: string,
): Readonly<{
  calculation: BankOfCanadaFxCalculation;
  formula: BankOfCanadaFxFormula;
  currencies: readonly string[];
}> {
  if (targetCurrency === "CAD") {
    return {
      calculation: "DIRECT_TO_CAD",
      formula: "CAD_PER_SOURCE_UNIT",
      currencies: [sourceCurrency],
    };
  }
  if (sourceCurrency === "CAD") {
    return {
      calculation: "INVERSE_FROM_CAD",
      formula: "1 / CAD_PER_TARGET_UNIT",
      currencies: [targetCurrency],
    };
  }
  return {
    calculation: "CROSS_VIA_CAD",
    formula: "CAD_PER_SOURCE_UNIT / CAD_PER_TARGET_UNIT",
    currencies: [sourceCurrency, targetCurrency],
  };
}

function validBankOfCanadaProviderObservation(
  observation: BankOfCanadaFxObservation,
  transactionCurrency: string,
  functionalCurrency: string,
  asOfDate: string,
  maxLookbackDays: number,
): boolean {
  try {
    const expected = bankOfCanadaExpectation(transactionCurrency, functionalCurrency);
    const observedDate = observation.observedAt.slice(0, 10);
    const legRates = observation.legs.map((leg) => exact(leg.cadPerUnit));
    const calculatedRate = expected.calculation === "DIRECT_TO_CAD"
      ? legRates[0]!
      : expected.calculation === "INVERSE_FROM_CAD"
        ? exact(1).div(legRates[0]!)
        : legRates[0]!.div(legRates[1]!);
    return exact(observation.rate).toDecimalPlaces(18).equals(
      calculatedRate.toDecimalPlaces(18),
    )
      && observation.sourceCurrency === transactionCurrency
      && observation.targetCurrency === functionalCurrency
      && observation.calculation === expected.calculation
      && observation.formula === expected.formula
      && observation.legs.length === expected.currencies.length
      && observation.legs.every((leg, index) => (
        leg.currency === expected.currencies[index]
        && leg.seriesKey === bankOfCanadaFxSeriesKey(leg.currency)
        && leg.observedDate === observedDate
        && positiveDecimal(leg.cadPerUnit)
      ))
      && validProviderWindow(
        observation.observedAt,
        observation.retrievedAt,
        observation.rawBodySha256,
        observation.rate,
        asOfDate,
        maxLookbackDays,
      );
  } catch {
    return false;
  }
}

function ecbExpectation(
  sourceCurrency: string,
  targetCurrency: string,
): Readonly<{
  calculation: EcbFxReferenceCalculation;
  formula: EcbFxReferenceFormula;
  currencies: readonly string[];
}> {
  if (sourceCurrency === "EUR") {
    return {
      calculation: "DIRECT_FROM_EUR",
      formula: "TARGET_UNITS_PER_EUR",
      currencies: [targetCurrency],
    };
  }
  if (targetCurrency === "EUR") {
    return {
      calculation: "INVERSE_TO_EUR",
      formula: "1 / SOURCE_UNITS_PER_EUR",
      currencies: [sourceCurrency],
    };
  }
  return {
    calculation: "CROSS_VIA_EUR",
    formula: "TARGET_UNITS_PER_EUR / SOURCE_UNITS_PER_EUR",
    currencies: [sourceCurrency, targetCurrency],
  };
}

function validEcbProviderObservation(
  observation: EcbFxReferenceObservation,
  transactionCurrency: string,
  functionalCurrency: string,
  asOfDate: string,
  maxLookbackDays: number,
): boolean {
  try {
    const expected = ecbExpectation(transactionCurrency, functionalCurrency);
    const observedDate = observation.observedAt.slice(0, 10);
    const legRates = observation.legs.map((leg) => exact(leg.unitsPerEuro));
    const calculatedRate = expected.calculation === "DIRECT_FROM_EUR"
      ? legRates[0]!
      : expected.calculation === "INVERSE_TO_EUR"
        ? exact(1).div(legRates[0]!)
        : legRates[1]!.div(legRates[0]!);
    return exact(observation.rate).toDecimalPlaces(18).equals(
      calculatedRate.toDecimalPlaces(18),
    )
      && observation.sourceCurrency === transactionCurrency
      && observation.targetCurrency === functionalCurrency
      && observation.calculation === expected.calculation
      && observation.formula === expected.formula
      && observation.legs.length === expected.currencies.length
      && observation.legs.every((leg, index) => (
        leg.currency === expected.currencies[index]
        && leg.seriesKey === "EXR.D." + leg.currency + ".EUR.SP00.A"
        && leg.observedDate === observedDate
        && positiveDecimal(leg.unitsPerEuro)
      ))
      && validProviderWindow(
        observation.observedAt,
        observation.retrievedAt,
        observation.rawBodySha256,
        observation.rate,
        asOfDate,
        maxLookbackDays,
      );
  } catch {
    return false;
  }
}

export type FxProviderFailureCode =
  | YahooFxChartErrorCode
  | BankOfCanadaValetErrorCode
  | EcbFxReferenceErrorCode;

export class FxRateUnavailableError extends Error {
  readonly code = "FX_RATE_UNAVAILABLE";

  constructor(
    readonly transactionCurrency: string,
    readonly functionalCurrency: string,
    readonly asOfDate: string,
    readonly providerFailureCode?: FxProviderFailureCode,
  ) {
    super(
      "No approved " + transactionCurrency + "/" + functionalCurrency
        + " FX rate is available for " + asOfDate
        + ". Record a direct organization rate, provide explicit FX evidence, or configure an available provider.",
    );
    this.name = "FxRateUnavailableError";
  }
}

function unavailable(
  transactionCurrency: string,
  functionalCurrency: string,
  asOfDate: string,
  providerFailureCode?: FxProviderFailureCode,
): FxRateUnavailableError {
  return new FxRateUnavailableError(
    transactionCurrency,
    functionalCurrency,
    asOfDate,
    providerFailureCode,
  );
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

  let explicitRate: ReturnType<typeof exact> | undefined;
  if (input.explicitFx) {
    try {
      explicitRate = exact(input.explicitFx.rate);
    } catch {
      throw unavailable(transactionCurrency, functionalCurrency, input.asOfDate);
    }
  }

  if (transactionCurrency === functionalCurrency) {
    if (explicitRate && !explicitRate.equals(1)) {
      throw unavailable(transactionCurrency, functionalCurrency, input.asOfDate);
    }
    return {
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: input.asOfDate + "T00:00:00.000Z",
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
      provenance: coreProvenance("FUNCTIONAL", input.asOfDate, resolvedAt),
    };
  }

  if (input.explicitFx && explicitRate) {
    const asOfStart = Date.parse(input.asOfDate + "T00:00:00.000Z");
    const effectiveAt = Date.parse(input.explicitFx.effectiveAt);
    if (!explicitRate.greaterThan(0)
        || !Number.isFinite(asOfStart)
        || !Number.isFinite(effectiveAt)
        || effectiveAt >= asOfStart + UTC_DAY_MS) {
      throw unavailable(transactionCurrency, functionalCurrency, input.asOfDate);
    }
    return {
      ...input.explicitFx,
      rate: explicitRate.toFixed(),
      quoteConvention: input.explicitFx.quoteConvention
        ?? "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
      provenance: coreProvenance("EXPLICIT", input.asOfDate, resolvedAt),
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
      throw unavailable(transactionCurrency, functionalCurrency, input.asOfDate);
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
  if (!Number.isInteger(policy.version) || policy.version <= 0) {
    throw unavailable(transactionCurrency, functionalCurrency, input.asOfDate);
  }

  const providerRequest = {
    sourceCurrency: transactionCurrency,
    targetCurrency: functionalCurrency,
    asOfDate: input.asOfDate,
  };

  if (policy.providerMode === "BANK_OF_CANADA") {
    let observation: BankOfCanadaFxObservation;
    try {
      observation = dependencies.fetchBankOfCanadaFxRate
        ? await dependencies.fetchBankOfCanadaFxRate(providerRequest)
        : await fxProviderObservationCache.getOrLoad(
          `BANK_OF_CANADA:${transactionCurrency}:${functionalCurrency}:${input.asOfDate}`,
          () => fetchBankOfCanadaFxRate(providerRequest),
        );
    } catch (error) {
      throw unavailable(
        transactionCurrency,
        functionalCurrency,
        input.asOfDate,
        error instanceof BankOfCanadaValetError
          ? error.code
          : "BANK_OF_CANADA_FX_NETWORK_ERROR",
      );
    }
    if (!validBankOfCanadaProviderObservation(
      observation,
      transactionCurrency,
      functionalCurrency,
      input.asOfDate,
      policy.maxLookbackDays,
    )) {
      throw unavailable(
        transactionCurrency,
        functionalCurrency,
        input.asOfDate,
        "BANK_OF_CANADA_FX_OBSERVATION_UNAVAILABLE",
      );
    }
    return {
      rate: exact(observation.rate).toDecimalPlaces(18).toFixed(),
      source: "Bank of Canada Valet API daily exchange rates",
      effectiveAt: observation.observedAt,
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
      provenance: {
        mode: "PROVIDER_RATE",
        asOfDate: input.asOfDate,
        resolvedAt: new Date().toISOString(),
        policyKey: BANK_OF_CANADA_REFERENCE_FX_POLICY.key,
        policyVersion: policy.version,
        providerKey: "BANK_OF_CANADA",
        providerSymbol: observation.legs.map((leg) => leg.seriesKey).join("+"),
        providerSourceCurrency: transactionCurrency,
        providerTargetCurrency: functionalCurrency,
        providerObservedAt: observation.observedAt,
        providerRetrievedAt: observation.retrievedAt,
        providerResponseSha256: observation.rawBodySha256,
        providerMaxLookbackDays: policy.maxLookbackDays,
        providerCalculation: observation.calculation,
        providerFormula: observation.formula,
        providerLegs: observation.legs.map((leg) => ({
          currency: leg.currency,
          rate: leg.cadPerUnit,
          rateConvention: "CAD_PER_CURRENCY_UNIT",
          observedDate: leg.observedDate,
          seriesKey: leg.seriesKey,
        })),
      },
    };
  }

  if (policy.providerMode === "EUROPEAN_CENTRAL_BANK") {
    let observation: EcbFxReferenceObservation;
    try {
      observation = dependencies.fetchEcbFxRate
        ? await dependencies.fetchEcbFxRate(providerRequest)
        : await fxProviderObservationCache.getOrLoad(
          `EUROPEAN_CENTRAL_BANK:${transactionCurrency}:${functionalCurrency}:${input.asOfDate}`,
          () => fetchEcbFxReferenceRate(providerRequest),
        );
    } catch (error) {
      throw unavailable(
        transactionCurrency,
        functionalCurrency,
        input.asOfDate,
        error instanceof EcbFxReferenceError ? error.code : "ECB_FX_NETWORK_ERROR",
      );
    }
    if (!validEcbProviderObservation(
      observation,
      transactionCurrency,
      functionalCurrency,
      input.asOfDate,
      policy.maxLookbackDays,
    )) {
      throw unavailable(
        transactionCurrency,
        functionalCurrency,
        input.asOfDate,
        "ECB_FX_OBSERVATION_UNAVAILABLE",
      );
    }
    return {
      rate: exact(observation.rate).toDecimalPlaces(18).toFixed(),
      source: "Source: ECB statistics. Euro foreign exchange reference rates",
      effectiveAt: observation.observedAt,
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
      provenance: {
        mode: "PROVIDER_RATE",
        asOfDate: input.asOfDate,
        resolvedAt: new Date().toISOString(),
        policyKey: ECB_REFERENCE_FX_POLICY.key,
        policyVersion: policy.version,
        providerKey: "EUROPEAN_CENTRAL_BANK",
        providerSymbol: observation.legs.map((leg) => leg.seriesKey).join("+"),
        providerSourceCurrency: transactionCurrency,
        providerTargetCurrency: functionalCurrency,
        providerObservedAt: observation.observedAt,
        providerRetrievedAt: observation.retrievedAt,
        providerResponseSha256: observation.rawBodySha256,
        providerMaxLookbackDays: policy.maxLookbackDays,
        providerCalculation: observation.calculation,
        providerFormula: observation.formula,
        providerLegs: observation.legs.map((leg) => ({
          currency: leg.currency,
          rate: leg.unitsPerEuro,
          rateConvention: "CURRENCY_UNITS_PER_EUR",
          observedDate: leg.observedDate,
          seriesKey: leg.seriesKey,
        })),
      },
    };
  }

  if (policy.providerMode !== "YAHOO_FINANCE_EXPERIMENTAL"
      || !policy.licensedAndAuthorizedUseAcknowledged) {
    throw unavailable(transactionCurrency, functionalCurrency, input.asOfDate);
  }

  const yahooEnabled = dependencies.yahooFxEnabled
    ?? process.env.YAHOO_FX_ENABLED === "true";
  if (!yahooEnabled) {
    throw unavailable(
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
      ...providerRequest,
    });
  } catch (error) {
    throw unavailable(
      transactionCurrency,
      functionalCurrency,
      input.asOfDate,
      error instanceof YahooFxChartError ? error.code : "YAHOO_FX_NETWORK_ERROR",
    );
  }

  if (!validYahooProviderObservation(
    providerRate,
    transactionCurrency,
    functionalCurrency,
    input.asOfDate,
    policy.maxLookbackDays,
  )) {
    throw unavailable(
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
      resolvedAt: new Date().toISOString(),
      policyKey: YAHOO_DIRECT_FX_POLICY.key,
      policyVersion: policy.version,
      providerKey: "YAHOO_FINANCE_EXPERIMENTAL",
      providerSymbol: providerRate.symbol,
      providerSourceCurrency: transactionCurrency,
      providerTargetCurrency: functionalCurrency,
      providerObservedAt: providerRate.observedAt,
      providerRetrievedAt: providerRate.retrievedAt,
      providerResponseSha256: providerRate.rawBodySha256,
      providerMaxLookbackDays: policy.maxLookbackDays,
    },
  };
}
