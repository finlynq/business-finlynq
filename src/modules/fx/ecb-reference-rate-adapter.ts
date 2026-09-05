import "server-only";

import { createHash } from "node:crypto";
import { exact } from "@/kernel/money";

export const ECB_FX_DATA_ORIGIN = "https://data-api.ecb.europa.eu";
export const ECB_FX_DATA_TIMEOUT_MS = 4_000;
export const ECB_FX_DATA_MAX_BYTES = 64 * 1024;
export const ECB_FX_DATA_LOOKBACK_DAYS = 7;
export const ECB_FX_CALCULATION_DECIMAL_PLACES = 18;

const ECB_BASE_CURRENCY = "EUR";
const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const currencyPattern = /^[A-Z]{3}$/;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const csvContentTypePattern = /^(?:text\/csv|application\/(?:vnd\.(?:sdmx|ecb)\.data\+csv|csv))(?:\s*;|$)/i;

export type EcbFxReferenceErrorCode =
  | "ECB_FX_INVALID_REQUEST"
  | "ECB_FX_FUTURE_DATE"
  | "ECB_FX_TIMEOUT"
  | "ECB_FX_NETWORK_ERROR"
  | "ECB_FX_REDIRECT_REJECTED"
  | "ECB_FX_HTTP_ERROR"
  | "ECB_FX_RESPONSE_TOO_LARGE"
  | "ECB_FX_INVALID_RESPONSE"
  | "ECB_FX_WRONG_SERIES"
  | "ECB_FX_OBSERVATION_UNAVAILABLE";

export class EcbFxReferenceError extends Error {
  constructor(
    readonly code: EcbFxReferenceErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EcbFxReferenceError";
  }
}

export type EcbFxReferenceCalculation =
  | "DIRECT_FROM_EUR"
  | "INVERSE_TO_EUR"
  | "CROSS_VIA_EUR";

export type EcbFxReferenceFormula =
  | "TARGET_UNITS_PER_EUR"
  | "1 / SOURCE_UNITS_PER_EUR"
  | "TARGET_UNITS_PER_EUR / SOURCE_UNITS_PER_EUR";

export type EcbFxReferenceLeg = Readonly<{
  currency: string;
  unitsPerEuro: string;
  observedDate: string;
  seriesKey: string;
}>;

export type EcbFxReferenceObservation = Readonly<{
  /** Target (functional) currency units for one source (transaction) currency unit. */
  rate: string;
  observedAt: string;
  sourceCurrency: string;
  targetCurrency: string;
  calculation: EcbFxReferenceCalculation;
  formula: EcbFxReferenceFormula;
  legs: readonly EcbFxReferenceLeg[];
  retrievedAt: string;
  rawBodySha256: string;
}>;

export type EcbFxReferenceRequest = Readonly<{
  sourceCurrency: string;
  targetCurrency: string;
  asOfDate: string;
}>;

export type EcbFxReferenceDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}>;

type NormalizedRequest = Readonly<{
  sourceCurrency: string;
  targetCurrency: string;
  asOfDate: string;
  windowStartDate: string;
  windowStartMs: number;
  windowEndMs: number;
  requestedCurrencies: readonly string[];
}>;

type ParsedObservation = Readonly<{
  currency: string;
  observedDate: string;
  unitsPerEuro: string;
}>;

function invalidResponse(message: string): EcbFxReferenceError {
  return new EcbFxReferenceError("ECB_FX_INVALID_RESPONSE", message);
}

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!currencyPattern.test(currency)) {
    throw new EcbFxReferenceError(
      "ECB_FX_INVALID_REQUEST",
      "ECB reference-rate requests require three-letter currency codes.",
    );
  }
  return currency;
}

function parseUtcDate(value: string, errorCode: "ECB_FX_INVALID_REQUEST" | "ECB_FX_INVALID_RESPONSE"): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new EcbFxReferenceError(
      errorCode,
      "ECB reference rates require UTC dates in YYYY-MM-DD format.",
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
    throw new EcbFxReferenceError(
      errorCode,
      "ECB reference rates require valid UTC calendar dates.",
    );
  }
  return timestamp;
}

function utcStartOfDay(value: Date): number {
  if (Number.isNaN(value.valueOf())) {
    throw new EcbFxReferenceError(
      "ECB_FX_INVALID_REQUEST",
      "ECB reference-rate retrieval requires a valid clock value.",
    );
  }
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizeRequest(input: EcbFxReferenceRequest, now: Date): NormalizedRequest {
  const sourceCurrency = normalizeCurrency(input.sourceCurrency);
  const targetCurrency = normalizeCurrency(input.targetCurrency);
  if (sourceCurrency === targetCurrency) {
    throw new EcbFxReferenceError(
      "ECB_FX_INVALID_REQUEST",
      "ECB reference-rate requests require two different currencies.",
    );
  }
  const asOfStartMs = parseUtcDate(input.asOfDate, "ECB_FX_INVALID_REQUEST");
  if (asOfStartMs > utcStartOfDay(now)) {
    throw new EcbFxReferenceError(
      "ECB_FX_FUTURE_DATE",
      "ECB reference-rate requests cannot use a future UTC date.",
    );
  }
  const requestedCurrencies = [sourceCurrency, targetCurrency]
    .filter((currency) => currency !== ECB_BASE_CURRENCY)
    .sort();
  const windowStartMs = asOfStartMs - (ECB_FX_DATA_LOOKBACK_DAYS * UTC_DAY_MS);
  return {
    sourceCurrency,
    targetCurrency,
    asOfDate: input.asOfDate,
    windowStartDate: utcDate(windowStartMs),
    windowStartMs,
    windowEndMs: asOfStartMs + UTC_DAY_MS,
    requestedCurrencies,
  };
}

function seriesKey(currency: string): string {
  return `EXR.D.${currency}.EUR.SP00.A`;
}

function requestUrl(input: NormalizedRequest): URL {
  const selectedCurrencies = input.requestedCurrencies.join("+");
  const url = new URL(
    `/service/data/EXR/D.${selectedCurrencies}.EUR.SP00.A`,
    ECB_FX_DATA_ORIGIN,
  );
  url.searchParams.set("startPeriod", input.windowStartDate);
  url.searchParams.set("endPeriod", input.asOfDate);
  url.searchParams.set("detail", "dataonly");
  url.searchParams.set("format", "csvdata");
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
  if (length !== undefined && length > BigInt(ECB_FX_DATA_MAX_BYTES)) {
    await cancelBody(response);
    throw new EcbFxReferenceError(
      "ECB_FX_RESPONSE_TOO_LARGE",
      "The ECB returned a response larger than the supported limit.",
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
      if (total > ECB_FX_DATA_MAX_BYTES) {
        throw new EcbFxReferenceError(
          "ECB_FX_RESPONSE_TOO_LARGE",
          "The ECB returned a response larger than the supported limit.",
        );
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function utf8Body(body: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body).replace(/^\uFEFF/, "");
  } catch {
    throw invalidResponse("The ECB returned a CSV response that was not valid UTF-8.");
  }
}

function csvRows(text: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  const finishField = () => {
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw invalidResponse("The ECB returned malformed quoted CSV data.");
    }
    if (character === '"') {
      if (field.length > 0 || closedQuote) {
        throw invalidResponse("The ECB returned malformed quoted CSV data.");
      }
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n") {
      finishRow();
    } else if (character === "\r") {
      if (text[index + 1] !== "\n") {
        throw invalidResponse("The ECB returned malformed CSV line endings.");
      }
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw invalidResponse("The ECB returned an unterminated quoted CSV field.");
  }
  if (field.length > 0 || row.length > 0 || closedQuote) finishRow();
  return rows;
}

function indexedHeaders(header: readonly string[]): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>();
  for (let index = 0; index < header.length; index += 1) {
    const name = header[index]!;
    if (indexes.has(name)) {
      throw invalidResponse("The ECB returned duplicate CSV columns.");
    }
    indexes.set(name, index);
  }
  const required = [
    "KEY",
    "FREQ",
    "CURRENCY",
    "CURRENCY_DENOM",
    "EXR_TYPE",
    "EXR_SUFFIX",
    "TIME_PERIOD",
    "OBS_VALUE",
  ] as const;
  if (required.some((name) => !indexes.has(name))) {
    throw invalidResponse("The ECB response omitted required series or observation columns.");
  }
  return indexes;
}

function cell(row: readonly string[], headers: ReadonlyMap<string, number>, name: string): string {
  return row[headers.get(name)!]!;
}

function parseObservations(body: Buffer, input: NormalizedRequest): readonly ParsedObservation[] {
  const rows = csvRows(utf8Body(body));
  if (rows.length === 0) {
    throw new EcbFxReferenceError(
      "ECB_FX_OBSERVATION_UNAVAILABLE",
      "The ECB returned no observations for the requested window.",
    );
  }
  const header = rows[0]!;
  const headers = indexedHeaders(header);
  const requested = new Set(input.requestedCurrencies);
  const observations: ParsedObservation[] = [];
  const uniqueObservations = new Set<string>();

  for (const row of rows.slice(1)) {
    if (row.length !== header.length) {
      throw invalidResponse("The ECB returned a CSV row with an unexpected number of columns.");
    }
    const currency = cell(row, headers, "CURRENCY");
    if (!requested.has(currency)
        || cell(row, headers, "KEY") !== seriesKey(currency)
        || cell(row, headers, "FREQ") !== "D"
        || cell(row, headers, "CURRENCY_DENOM") !== ECB_BASE_CURRENCY
        || cell(row, headers, "EXR_TYPE") !== "SP00"
        || cell(row, headers, "EXR_SUFFIX") !== "A") {
      throw new EcbFxReferenceError(
        "ECB_FX_WRONG_SERIES",
        "The ECB returned metadata for a different exchange-rate series.",
      );
    }
    const observedDate = cell(row, headers, "TIME_PERIOD");
    const observedMs = parseUtcDate(observedDate, "ECB_FX_INVALID_RESPONSE");
    if (observedMs < input.windowStartMs || observedMs >= input.windowEndMs) {
      throw invalidResponse("The ECB returned an observation outside the requested UTC window.");
    }
    const rawValue = cell(row, headers, "OBS_VALUE");
    if (rawValue.length > 100 || !decimalPattern.test(rawValue)) {
      throw invalidResponse("The ECB returned an invalid reference-rate observation.");
    }
    const value = exact(rawValue);
    if (!value.greaterThan(0)) {
      throw invalidResponse("The ECB returned a non-positive reference-rate observation.");
    }
    const uniquenessKey = `${currency}:${observedDate}`;
    if (uniqueObservations.has(uniquenessKey)) {
      throw invalidResponse("The ECB returned duplicate observations for a currency and date.");
    }
    uniqueObservations.add(uniquenessKey);
    observations.push({ currency, observedDate, unitsPerEuro: rawValue });
  }
  if (observations.length === 0) {
    throw new EcbFxReferenceError(
      "ECB_FX_OBSERVATION_UNAVAILABLE",
      "The ECB returned no observations for the requested window.",
    );
  }
  return observations;
}

function selectCommonDate(
  observations: readonly ParsedObservation[],
  input: NormalizedRequest,
): Readonly<{ observedDate: string; legs: readonly EcbFxReferenceLeg[] }> {
  const byCurrency = new Map<string, Map<string, string>>();
  for (const observation of observations) {
    const values = byCurrency.get(observation.currency) ?? new Map<string, string>();
    values.set(observation.observedDate, observation.unitsPerEuro);
    byCurrency.set(observation.currency, values);
  }
  const formulaCurrencies = input.sourceCurrency === ECB_BASE_CURRENCY
    ? [input.targetCurrency]
    : input.targetCurrency === ECB_BASE_CURRENCY
      ? [input.sourceCurrency]
      : [input.sourceCurrency, input.targetCurrency];
  const firstDates = byCurrency.get(formulaCurrencies[0]!)?.keys();
  let selectedDate: string | undefined;
  if (firstDates) {
    for (const date of firstDates) {
      if (formulaCurrencies.every((currency) => byCurrency.get(currency)?.has(date))
          && (selectedDate === undefined || date > selectedDate)) {
        selectedDate = date;
      }
    }
  }
  if (!selectedDate) {
    throw new EcbFxReferenceError(
      "ECB_FX_OBSERVATION_UNAVAILABLE",
      "The ECB returned no common daily observation for the requested currencies.",
    );
  }
  return {
    observedDate: selectedDate,
    legs: formulaCurrencies.map((currency) => ({
      currency,
      unitsPerEuro: byCurrency.get(currency)!.get(selectedDate)!,
      observedDate: selectedDate,
      seriesKey: seriesKey(currency),
    })),
  };
}

function calculateRate(
  input: NormalizedRequest,
  legs: readonly EcbFxReferenceLeg[],
): Pick<EcbFxReferenceObservation, "rate" | "calculation" | "formula"> {
  if (input.sourceCurrency === ECB_BASE_CURRENCY) {
    return {
      rate: exact(legs[0]!.unitsPerEuro).toFixed(),
      calculation: "DIRECT_FROM_EUR",
      formula: "TARGET_UNITS_PER_EUR",
    };
  }
  if (input.targetCurrency === ECB_BASE_CURRENCY) {
    return {
      rate: exact(1).div(legs[0]!.unitsPerEuro)
        .toDecimalPlaces(ECB_FX_CALCULATION_DECIMAL_PLACES).toFixed(),
      calculation: "INVERSE_TO_EUR",
      formula: "1 / SOURCE_UNITS_PER_EUR",
    };
  }
  return {
    rate: exact(legs[1]!.unitsPerEuro).div(legs[0]!.unitsPerEuro)
      .toDecimalPlaces(ECB_FX_CALCULATION_DECIMAL_PLACES).toFixed(),
    calculation: "CROSS_VIA_EUR",
    formula: "TARGET_UNITS_PER_EUR / SOURCE_UNITS_PER_EUR",
  };
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

export async function fetchEcbFxReferenceRate(
  input: EcbFxReferenceRequest,
  dependencies: EcbFxReferenceDependencies = {},
): Promise<EcbFxReferenceObservation> {
  const clock = dependencies.now ?? (() => new Date());
  const normalized = normalizeRequest(input, clock());
  const url = requestUrl(normalized);
  const signal = (dependencies.timeoutSignal ?? AbortSignal.timeout)(ECB_FX_DATA_TIMEOUT_MS);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch.bind(globalThis);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "text/csv" },
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    if (response.redirected
        || (response.status >= 300 && response.status < 400)
        || (response.url && new URL(response.url).origin !== ECB_FX_DATA_ORIGIN)) {
      await cancelBody(response);
      throw new EcbFxReferenceError(
        "ECB_FX_REDIRECT_REJECTED",
        "The ECB data service attempted a redirect.",
      );
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new EcbFxReferenceError(
        "ECB_FX_HTTP_ERROR",
        "The ECB data service returned an unsuccessful HTTP status.",
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    const contentType = response.headers.get("content-type")?.trim() ?? "";
    if (!csvContentTypePattern.test(contentType)) {
      await cancelBody(response);
      throw invalidResponse("The ECB returned a non-CSV response.");
    }
    const body = await readBoundedBody(response);
    const digest = createHash("sha256").update(body).digest("hex");
    const observations = parseObservations(body, normalized);
    const selected = selectCommonDate(observations, normalized);
    const calculated = calculateRate(normalized, selected.legs);
    return {
      ...calculated,
      observedAt: `${selected.observedDate}T00:00:00.000Z`,
      sourceCurrency: normalized.sourceCurrency,
      targetCurrency: normalized.targetCurrency,
      legs: selected.legs,
      retrievedAt: clock().toISOString(),
      rawBodySha256: digest,
    };
  } catch (error) {
    if (error instanceof EcbFxReferenceError) throw error;
    if (isTimeout(error, signal)) {
      throw new EcbFxReferenceError(
        "ECB_FX_TIMEOUT",
        "The ECB data service did not respond within four seconds.",
        true,
      );
    }
    throw new EcbFxReferenceError(
      "ECB_FX_NETWORK_ERROR",
      "The ECB data service could not be reached.",
      true,
    );
  }
}
