import "server-only";

import { createHash } from "node:crypto";
import type Decimal from "decimal.js";
import { exact } from "@/kernel/money";

export const BANK_OF_CANADA_VALET_ORIGIN = "https://www.bankofcanada.ca";
export const BANK_OF_CANADA_VALET_TIMEOUT_MS = 4_000;
export const BANK_OF_CANADA_VALET_MAX_BYTES = 128 * 1024;
export const BANK_OF_CANADA_FX_LOOKBACK_DAYS = 7;

export const BANK_OF_CANADA_FX_CURRENCIES = Object.freeze([
  "AUD",
  "BRL",
  "CHF",
  "CNY",
  "EUR",
  "GBP",
  "HKD",
  "IDR",
  "INR",
  "JPY",
  "KRW",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PEN",
  "PLN",
  "RUB",
  "SAR",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "TWD",
  "USD",
  "VND",
  "ZAR",
] as const);

const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const currencyPattern = /^[A-Z]{3}$/;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const jsonContentTypePattern = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
const supportedCurrencies = new Set<string>(BANK_OF_CANADA_FX_CURRENCIES);

export type BankOfCanadaValetErrorCode =
  | "BANK_OF_CANADA_FX_INVALID_REQUEST"
  | "BANK_OF_CANADA_FX_FUTURE_DATE"
  | "BANK_OF_CANADA_FX_UNSUPPORTED_PAIR"
  | "BANK_OF_CANADA_FX_TIMEOUT"
  | "BANK_OF_CANADA_FX_NETWORK_ERROR"
  | "BANK_OF_CANADA_FX_REDIRECT_REJECTED"
  | "BANK_OF_CANADA_FX_HTTP_ERROR"
  | "BANK_OF_CANADA_FX_RESPONSE_TOO_LARGE"
  | "BANK_OF_CANADA_FX_INVALID_RESPONSE"
  | "BANK_OF_CANADA_FX_WRONG_SERIES"
  | "BANK_OF_CANADA_FX_OBSERVATION_UNAVAILABLE";

export class BankOfCanadaValetError extends Error {
  constructor(
    readonly code: BankOfCanadaValetErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BankOfCanadaValetError";
  }
}

export type BankOfCanadaFxCalculation =
  | "DIRECT_TO_CAD"
  | "INVERSE_FROM_CAD"
  | "CROSS_VIA_CAD";

export type BankOfCanadaFxFormula =
  | "CAD_PER_SOURCE_UNIT"
  | "1 / CAD_PER_TARGET_UNIT"
  | "CAD_PER_SOURCE_UNIT / CAD_PER_TARGET_UNIT";

export type BankOfCanadaFxLeg = Readonly<{
  currency: string;
  cadPerUnit: string;
  observedDate: string;
  seriesKey: string;
}>;

export type BankOfCanadaFxObservation = Readonly<{
  rate: string;
  observedAt: string;
  sourceCurrency: string;
  targetCurrency: string;
  calculation: BankOfCanadaFxCalculation;
  formula: BankOfCanadaFxFormula;
  legs: readonly BankOfCanadaFxLeg[];
  retrievedAt: string;
  rawBodySha256: string;
}>;

export type BankOfCanadaFxRequest = Readonly<{
  sourceCurrency: string;
  targetCurrency: string;
  asOfDate: string;
}>;

export type BankOfCanadaValetDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}>;

type SeriesLeg = Readonly<{
  currency: string;
  seriesKey: string;
}>;

type NormalizedRequest = Readonly<{
  sourceCurrency: string;
  targetCurrency: string;
  asOfDate: string;
  windowStartMs: number;
  windowEndMs: number;
  calculation: BankOfCanadaFxCalculation;
  formula: BankOfCanadaFxFormula;
  seriesLegs: readonly SeriesLeg[];
}>;

type ParsedRate = Readonly<{
  raw: string;
  decimal: Decimal;
}>;

type ParsedObservation = Readonly<{
  observedDate: string;
  observedAt: string;
  rates: ReadonlyMap<string, ParsedRate>;
}>;

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!currencyPattern.test(currency)) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_REQUEST",
      "Bank of Canada FX requests require three-letter currency codes.",
    );
  }
  return currency;
}

function parseUtcDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_REQUEST",
      "Bank of Canada FX requests require a UTC date in YYYY-MM-DD format.",
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year
      || parsed.getUTCMonth() !== month - 1
      || parsed.getUTCDate() !== day) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_REQUEST",
      "Bank of Canada FX requests require a valid UTC calendar date.",
    );
  }
  return timestamp;
}

function utcStartOfDay(value: Date): number {
  if (Number.isNaN(value.valueOf())) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_REQUEST",
      "Bank of Canada FX retrieval requires a valid clock value.",
    );
  }
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

export function bankOfCanadaFxSeriesKey(currencyValue: string): string {
  const currency = normalizeCurrency(currencyValue);
  if (currency === "CAD" || !supportedCurrencies.has(currency)) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_UNSUPPORTED_PAIR",
      `Bank of Canada does not publish a supported ${currency}/CAD daily series.`,
    );
  }
  return `FX${currency}CAD`;
}

function seriesLeg(currency: string): SeriesLeg {
  return { currency, seriesKey: bankOfCanadaFxSeriesKey(currency) };
}

function normalizeRequest(input: BankOfCanadaFxRequest, now: Date): NormalizedRequest {
  const sourceCurrency = normalizeCurrency(input.sourceCurrency);
  const targetCurrency = normalizeCurrency(input.targetCurrency);
  if (sourceCurrency === targetCurrency) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_REQUEST",
      "Bank of Canada FX requests require two different currencies.",
    );
  }
  const asOfStartMs = parseUtcDate(input.asOfDate);
  if (asOfStartMs > utcStartOfDay(now)) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_FUTURE_DATE",
      "Bank of Canada FX requests cannot use a future UTC date.",
    );
  }

  let calculation: BankOfCanadaFxCalculation;
  let formula: BankOfCanadaFxFormula;
  let seriesLegs: readonly SeriesLeg[];
  if (targetCurrency === "CAD") {
    calculation = "DIRECT_TO_CAD";
    formula = "CAD_PER_SOURCE_UNIT";
    seriesLegs = [seriesLeg(sourceCurrency)];
  } else if (sourceCurrency === "CAD") {
    calculation = "INVERSE_FROM_CAD";
    formula = "1 / CAD_PER_TARGET_UNIT";
    seriesLegs = [seriesLeg(targetCurrency)];
  } else {
    calculation = "CROSS_VIA_CAD";
    formula = "CAD_PER_SOURCE_UNIT / CAD_PER_TARGET_UNIT";
    seriesLegs = [seriesLeg(sourceCurrency), seriesLeg(targetCurrency)];
  }

  return {
    sourceCurrency,
    targetCurrency,
    asOfDate: input.asOfDate,
    windowStartMs: asOfStartMs - (BANK_OF_CANADA_FX_LOOKBACK_DAYS * UTC_DAY_MS),
    windowEndMs: asOfStartMs + UTC_DAY_MS,
    calculation,
    formula,
    seriesLegs,
  };
}

function requestUrl(input: NormalizedRequest): URL {
  const seriesPath = input.seriesLegs
    .map((leg) => encodeURIComponent(leg.seriesKey))
    .join(",");
  const url = new URL(`/valet/observations/${seriesPath}/json`, BANK_OF_CANADA_VALET_ORIGIN);
  url.searchParams.set("start_date", new Date(input.windowStartMs).toISOString().slice(0, 10));
  url.searchParams.set("end_date", input.asOfDate);
  url.searchParams.set("order_dir", "desc");
  return url;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function declaredLength(response: Response): bigint | undefined {
  const raw = response.headers.get("content-length")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const length = declaredLength(response);
  if (length !== undefined && length > BigInt(BANK_OF_CANADA_VALET_MAX_BYTES)) {
    await cancelBody(response);
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_RESPONSE_TOO_LARGE",
      "Bank of Canada FX returned a response larger than the supported limit.",
    );
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > BANK_OF_CANADA_VALET_MAX_BYTES) {
        throw new BankOfCanadaValetError(
          "BANK_OF_CANADA_FX_RESPONSE_TOO_LARGE",
          "Bank of Canada FX returned a response larger than the supported limit.",
        );
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function jsonBody(body: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_RESPONSE",
      "Bank of Canada FX returned an invalid JSON response.",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_RESPONSE",
      "Bank of Canada FX returned an invalid JSON response.",
    );
  }
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function validateSeriesDetails(
  rawDetails: unknown,
  input: NormalizedRequest,
): void {
  const details = objectValue(rawDetails);
  const requestedKeys = input.seriesLegs.map((leg) => leg.seriesKey);
  if (!details
      || Object.keys(details).length !== requestedKeys.length
      || requestedKeys.some((key) => !(key in details))) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_WRONG_SERIES",
      "Bank of Canada FX returned details for different series.",
    );
  }

  for (const leg of input.seriesLegs) {
    const detail = objectValue(details[leg.seriesKey]);
    const dimension = objectValue(detail?.dimension);
    if (!detail
        || detail.label !== `${leg.currency}/CAD`
        || typeof detail.description !== "string"
        || detail.description.trim().length === 0
        || dimension?.key !== "d"
        || dimension.name !== "Date") {
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_WRONG_SERIES",
        "Bank of Canada FX returned metadata for a different currency series.",
      );
    }
  }
}

function validateTerms(rawTerms: unknown): void {
  const terms = objectValue(rawTerms);
  if (!terms || typeof terms.url !== "string") {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_RESPONSE",
      "Bank of Canada FX returned malformed terms metadata.",
    );
  }
  try {
    const url = new URL(terms.url);
    if (url.protocol !== "https:"
        || url.origin !== BANK_OF_CANADA_VALET_ORIGIN
        || !url.pathname.startsWith("/terms")) {
      throw new Error("unexpected terms URL");
    }
  } catch {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_RESPONSE",
      "Bank of Canada FX returned malformed terms metadata.",
    );
  }
}

function parseRate(rawRate: unknown): ParsedRate {
  const value = objectValue(rawRate);
  if (!value
      || Object.keys(value).length !== 1
      || typeof value.v !== "string"
      || !decimalPattern.test(value.v)) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_RESPONSE",
      "Bank of Canada FX returned an invalid daily rate.",
    );
  }
  const decimal = exact(value.v);
  if (!decimal.greaterThan(0)) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_RESPONSE",
      "Bank of Canada FX returned a non-positive daily rate.",
    );
  }
  return { raw: value.v, decimal };
}

function parseObservationDate(value: string): number {
  try {
    return parseUtcDate(value);
  } catch {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_RESPONSE",
      "Bank of Canada FX returned an invalid observation date.",
    );
  }
}

function parseObservations(
  rawObservations: unknown,
  input: NormalizedRequest,
): readonly ParsedObservation[] {
  if (!Array.isArray(rawObservations)) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_INVALID_RESPONSE",
      "Bank of Canada FX returned malformed observations.",
    );
  }

  const requestedKeys = new Set(input.seriesLegs.map((leg) => leg.seriesKey));
  const observedDates = new Set<string>();
  const parsed: ParsedObservation[] = [];
  for (const rawObservation of rawObservations) {
    const observation = objectValue(rawObservation);
    if (!observation || typeof observation.d !== "string") {
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_INVALID_RESPONSE",
        "Bank of Canada FX returned an invalid observation date.",
      );
    }
    const unexpectedKey = Object.keys(observation)
      .find((key) => key !== "d" && !requestedKeys.has(key));
    if (unexpectedKey) {
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_WRONG_SERIES",
        "Bank of Canada FX returned an unexpected currency series.",
      );
    }
    const observedDateMs = parseObservationDate(observation.d);
    if (observedDateMs < input.windowStartMs || observedDateMs >= input.windowEndMs) {
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_INVALID_RESPONSE",
        "Bank of Canada FX returned an observation outside the requested date window.",
      );
    }
    if (observedDates.has(observation.d)) {
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_INVALID_RESPONSE",
        "Bank of Canada FX returned duplicate observations for one date.",
      );
    }
    observedDates.add(observation.d);

    const rates = new Map<string, ParsedRate>();
    for (const key of requestedKeys) {
      if (observation[key] !== undefined) rates.set(key, parseRate(observation[key]));
    }
    parsed.push({
      observedDate: observation.d,
      observedAt: new Date(observedDateMs).toISOString(),
      rates,
    });
  }
  return parsed;
}

function selectObservation(
  observations: readonly ParsedObservation[],
  input: NormalizedRequest,
): ParsedObservation {
  const seriesKeys = input.seriesLegs.map((leg) => leg.seriesKey);
  const eligible = observations
    .filter((item) => seriesKeys.every((key) => item.rates.has(key)))
    .sort((left, right) => right.observedDate.localeCompare(left.observedDate));
  const selected = eligible[0];
  if (!selected) {
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_OBSERVATION_UNAVAILABLE",
      "Bank of Canada FX returned no common daily observation for the requested window.",
    );
  }
  return selected;
}

function calculateRate(
  selected: ParsedObservation,
  input: NormalizedRequest,
): string {
  const rates = input.seriesLegs.map((leg) => selected.rates.get(leg.seriesKey)!.decimal);
  switch (input.calculation) {
    case "DIRECT_TO_CAD":
      return rates[0]!.toFixed();
    case "INVERSE_FROM_CAD":
      return exact(1).dividedBy(rates[0]!).toFixed();
    case "CROSS_VIA_CAD":
      return rates[0]!.dividedBy(rates[1]!).toFixed();
  }
}

function responseWasRedirected(response: Response): boolean {
  if (response.redirected || (response.status >= 300 && response.status < 400)) return true;
  if (!response.url) return false;
  try {
    return new URL(response.url).origin !== BANK_OF_CANADA_VALET_ORIGIN;
  } catch {
    return true;
  }
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

export async function fetchBankOfCanadaFxRate(
  input: BankOfCanadaFxRequest,
  dependencies: BankOfCanadaValetDependencies = {},
): Promise<BankOfCanadaFxObservation> {
  const clock = dependencies.now ?? (() => new Date());
  const normalized = normalizeRequest(input, clock());
  const url = requestUrl(normalized);
  const signal = (dependencies.timeoutSignal ?? AbortSignal.timeout)(BANK_OF_CANADA_VALET_TIMEOUT_MS);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch.bind(globalThis);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    if (responseWasRedirected(response)) {
      await cancelBody(response);
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_REDIRECT_REJECTED",
        "Bank of Canada FX attempted a redirect.",
      );
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_HTTP_ERROR",
        "Bank of Canada FX returned an unsuccessful HTTP status.",
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    const contentType = response.headers.get("content-type")?.trim() ?? "";
    if (!jsonContentTypePattern.test(contentType)) {
      await cancelBody(response);
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_INVALID_RESPONSE",
        "Bank of Canada FX returned a non-JSON response.",
      );
    }

    const body = await readBoundedBody(response);
    const digest = createHash("sha256").update(body).digest("hex");
    const payload = objectValue(jsonBody(body));
    if (!payload) {
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_INVALID_RESPONSE",
        "Bank of Canada FX returned a malformed response.",
      );
    }
    validateTerms(payload.terms);
    validateSeriesDetails(payload.seriesDetail, normalized);
    const selected = selectObservation(
      parseObservations(payload.observations, normalized),
      normalized,
    );
    const legs = normalized.seriesLegs.map((leg): BankOfCanadaFxLeg => ({
      currency: leg.currency,
      cadPerUnit: selected.rates.get(leg.seriesKey)!.raw,
      observedDate: selected.observedDate,
      seriesKey: leg.seriesKey,
    }));
    const retrievedAt = clock();
    if (Number.isNaN(retrievedAt.valueOf())) {
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_INVALID_REQUEST",
        "Bank of Canada FX retrieval requires a valid clock value.",
      );
    }
    return {
      rate: calculateRate(selected, normalized),
      observedAt: selected.observedAt,
      sourceCurrency: normalized.sourceCurrency,
      targetCurrency: normalized.targetCurrency,
      calculation: normalized.calculation,
      formula: normalized.formula,
      legs,
      retrievedAt: retrievedAt.toISOString(),
      rawBodySha256: digest,
    };
  } catch (error) {
    if (error instanceof BankOfCanadaValetError) throw error;
    if (isTimeout(error, signal)) {
      throw new BankOfCanadaValetError(
        "BANK_OF_CANADA_FX_TIMEOUT",
        "Bank of Canada FX did not respond within four seconds.",
        true,
      );
    }
    throw new BankOfCanadaValetError(
      "BANK_OF_CANADA_FX_NETWORK_ERROR",
      "Bank of Canada FX could not be reached.",
      true,
    );
  }
}
