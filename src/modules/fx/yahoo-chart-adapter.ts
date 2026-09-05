import "server-only";

import { createHash } from "node:crypto";
import { exact } from "@/kernel/money";

export const YAHOO_FX_CHART_ORIGIN = "https://query1.finance.yahoo.com";
export const YAHOO_FX_CHART_TIMEOUT_MS = 4_000;
export const YAHOO_FX_CHART_MAX_BYTES = 128 * 1024;
export const YAHOO_FX_CHART_LOOKBACK_DAYS = 7;

const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const currencyPattern = /^[A-Z]{3}$/;
const jsonContentTypePattern = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;

export type YahooFxChartErrorCode =
  | "YAHOO_FX_DISABLED"
  | "YAHOO_FX_INVALID_REQUEST"
  | "YAHOO_FX_FUTURE_DATE"
  | "YAHOO_FX_TIMEOUT"
  | "YAHOO_FX_NETWORK_ERROR"
  | "YAHOO_FX_REDIRECT_REJECTED"
  | "YAHOO_FX_HTTP_ERROR"
  | "YAHOO_FX_RESPONSE_TOO_LARGE"
  | "YAHOO_FX_INVALID_RESPONSE"
  | "YAHOO_FX_WRONG_PAIR"
  | "YAHOO_FX_OBSERVATION_UNAVAILABLE";

export class YahooFxChartError extends Error {
  constructor(
    readonly code: YahooFxChartErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "YahooFxChartError";
  }
}

export type YahooFxChartObservation = Readonly<{
  rate: string;
  observedAt: string;
  symbol: string;
  retrievedAt: string;
  rawBodySha256: string;
}>;

export type YahooFxChartRequest = Readonly<{
  enabled: boolean;
  sourceCurrency: string;
  targetCurrency: string;
  asOfDate: string;
}>;

export type YahooFxChartDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}>;

type NormalizedRequest = Readonly<{
  sourceCurrency: string;
  targetCurrency: string;
  asOfDate: string;
  asOfStartMs: number;
  windowStartMs: number;
  windowEndMs: number;
  symbol: string;
}>;

type YahooChartResult = Readonly<{
  meta: Readonly<Record<string, unknown>>;
  timestamp: readonly unknown[];
  indicators: Readonly<{
    quote: readonly Readonly<{ close: readonly unknown[] }>[];
  }>;
}>;

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!currencyPattern.test(currency)) {
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_REQUEST",
      "Yahoo FX requests require three-letter currency codes.",
    );
  }
  return currency;
}

function parseUtcDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_REQUEST",
      "Yahoo FX requests require a UTC date in YYYY-MM-DD format.",
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
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_REQUEST",
      "Yahoo FX requests require a valid UTC calendar date.",
    );
  }
  return timestamp;
}

function utcStartOfDay(value: Date): number {
  if (Number.isNaN(value.valueOf())) {
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_REQUEST",
      "Yahoo FX retrieval requires a valid clock value.",
    );
  }
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

export function yahooDirectFxSymbol(sourceCurrency: string, targetCurrency: string): string {
  const source = normalizeCurrency(sourceCurrency);
  const target = normalizeCurrency(targetCurrency);
  if (source === target) {
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_REQUEST",
      "Yahoo FX requests require two different currencies.",
    );
  }
  return source === "USD" ? `${target}=X` : `${source}${target}=X`;
}

function normalizeRequest(input: YahooFxChartRequest, now: Date): NormalizedRequest {
  const sourceCurrency = normalizeCurrency(input.sourceCurrency);
  const targetCurrency = normalizeCurrency(input.targetCurrency);
  const asOfStartMs = parseUtcDate(input.asOfDate);
  if (asOfStartMs > utcStartOfDay(now)) {
    throw new YahooFxChartError(
      "YAHOO_FX_FUTURE_DATE",
      "Yahoo FX requests cannot use a future UTC date.",
    );
  }
  return {
    sourceCurrency,
    targetCurrency,
    asOfDate: input.asOfDate,
    asOfStartMs,
    windowStartMs: asOfStartMs - (YAHOO_FX_CHART_LOOKBACK_DAYS * UTC_DAY_MS),
    windowEndMs: asOfStartMs + UTC_DAY_MS,
    symbol: yahooDirectFxSymbol(sourceCurrency, targetCurrency),
  };
}

function requestUrl(input: NormalizedRequest): URL {
  const encodedSymbol = encodeURIComponent(input.symbol);
  const url = new URL(`/v8/finance/chart/${encodedSymbol}`, YAHOO_FX_CHART_ORIGIN);
  url.searchParams.set("period1", String(Math.floor(input.windowStartMs / 1_000)));
  url.searchParams.set("period2", String(Math.floor(input.windowEndMs / 1_000)));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");
  url.searchParams.set("includeAdjustedClose", "false");
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
  if (length !== undefined && length > BigInt(YAHOO_FX_CHART_MAX_BYTES)) {
    await cancelBody(response);
    throw new YahooFxChartError(
      "YAHOO_FX_RESPONSE_TOO_LARGE",
      "Yahoo FX returned a response larger than the supported limit.",
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
      if (total > YAHOO_FX_CHART_MAX_BYTES) {
        throw new YahooFxChartError(
          "YAHOO_FX_RESPONSE_TOO_LARGE",
          "Yahoo FX returned a response larger than the supported limit.",
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
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_RESPONSE",
      "Yahoo FX returned an invalid JSON response.",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_RESPONSE",
      "Yahoo FX returned an invalid JSON response.",
    );
  }
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function chartResult(payload: unknown): YahooChartResult {
  const root = objectValue(payload);
  const chart = objectValue(root?.chart);
  if (!chart) {
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_RESPONSE",
      "Yahoo FX returned a malformed chart response.",
    );
  }
  if (chart.error !== null && chart.error !== undefined) {
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_RESPONSE",
      "Yahoo FX returned a chart error.",
    );
  }
  if (chart.result === null || (Array.isArray(chart.result) && chart.result.length === 0)) {
    throw new YahooFxChartError(
      "YAHOO_FX_OBSERVATION_UNAVAILABLE",
      "Yahoo FX returned no observation for the requested window.",
    );
  }
  if (!Array.isArray(chart.result) || chart.result.length !== 1) {
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_RESPONSE",
      "Yahoo FX returned a malformed chart result.",
    );
  }
  const result = objectValue(chart.result[0]);
  const meta = objectValue(result?.meta);
  const indicators = objectValue(result?.indicators);
  const quotes = indicators?.quote;
  const timestamps = result?.timestamp;
  if (!result || !meta || !Array.isArray(timestamps) || !Array.isArray(quotes)
      || quotes.length !== 1) {
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_RESPONSE",
      "Yahoo FX returned malformed daily observations.",
    );
  }
  const quote = objectValue(quotes[0]);
  if (!quote || !Array.isArray(quote.close) || quote.close.length !== timestamps.length) {
    throw new YahooFxChartError(
      "YAHOO_FX_INVALID_RESPONSE",
      "Yahoo FX returned misaligned daily observations.",
    );
  }
  return {
    meta,
    timestamp: timestamps,
    indicators: { quote: [{ close: quote.close }] },
  };
}

function validateMetadata(result: YahooChartResult, input: NormalizedRequest): void {
  const symbol = result.meta.symbol;
  const currency = result.meta.currency;
  const instrumentType = result.meta.instrumentType;
  const granularity = result.meta.dataGranularity;
  if (symbol !== input.symbol
      || typeof currency !== "string"
      || currency.trim().toUpperCase() !== input.targetCurrency
      || instrumentType !== "CURRENCY"
      || granularity !== "1d") {
    throw new YahooFxChartError(
      "YAHOO_FX_WRONG_PAIR",
      "Yahoo FX returned metadata for a different pair or direction.",
    );
  }
}

function observation(result: YahooChartResult, input: NormalizedRequest): Pick<YahooFxChartObservation, "rate" | "observedAt"> {
  const closes = result.indicators.quote[0]!.close;
  let selected: Readonly<{ timestampMs: number; rate: string }> | undefined;
  for (let index = 0; index < result.timestamp.length; index += 1) {
    const rawTimestamp = result.timestamp[index];
    const rawClose = closes[index];
    if (!Number.isSafeInteger(rawTimestamp) || Number(rawTimestamp) <= 0) {
      throw new YahooFxChartError(
        "YAHOO_FX_INVALID_RESPONSE",
        "Yahoo FX returned an invalid observation timestamp.",
      );
    }
    const timestampMs = Number(rawTimestamp) * 1_000;
    if (!Number.isFinite(timestampMs) || Number.isNaN(new Date(timestampMs).valueOf())) {
      throw new YahooFxChartError(
        "YAHOO_FX_INVALID_RESPONSE",
        "Yahoo FX returned an invalid observation timestamp.",
      );
    }
    if (timestampMs >= input.windowEndMs) {
      throw new YahooFxChartError(
        "YAHOO_FX_INVALID_RESPONSE",
        "Yahoo FX returned an observation after the requested UTC date.",
      );
    }
    if (timestampMs < input.windowStartMs || rawClose === null) continue;
    if (typeof rawClose !== "number" || !Number.isFinite(rawClose)) {
      throw new YahooFxChartError(
        "YAHOO_FX_INVALID_RESPONSE",
        "Yahoo FX returned an invalid daily close.",
      );
    }
    const rate = exact(String(rawClose));
    if (!rate.greaterThan(0)) continue;
    if (!selected || timestampMs > selected.timestampMs) {
      selected = { timestampMs, rate: rate.toFixed() };
    }
  }
  if (!selected) {
    throw new YahooFxChartError(
      "YAHOO_FX_OBSERVATION_UNAVAILABLE",
      "Yahoo FX returned no positive daily close for the requested window.",
    );
  }
  return { rate: selected.rate, observedAt: new Date(selected.timestampMs).toISOString() };
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

export async function fetchYahooFxChartRate(
  input: YahooFxChartRequest,
  dependencies: YahooFxChartDependencies = {},
): Promise<YahooFxChartObservation> {
  if (!input.enabled) {
    throw new YahooFxChartError(
      "YAHOO_FX_DISABLED",
      "Yahoo FX retrieval is disabled by the operator.",
    );
  }

  const clock = dependencies.now ?? (() => new Date());
  const normalized = normalizeRequest(input, clock());
  const url = requestUrl(normalized);
  const signal = (dependencies.timeoutSignal ?? AbortSignal.timeout)(YAHOO_FX_CHART_TIMEOUT_MS);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch.bind(globalThis);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    if (response.redirected
        || (response.status >= 300 && response.status < 400)
        || (response.url && new URL(response.url).origin !== YAHOO_FX_CHART_ORIGIN)) {
      await cancelBody(response);
      throw new YahooFxChartError(
        "YAHOO_FX_REDIRECT_REJECTED",
        "Yahoo FX attempted a redirect.",
      );
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new YahooFxChartError(
        "YAHOO_FX_HTTP_ERROR",
        "Yahoo FX returned an unsuccessful HTTP status.",
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    const contentType = response.headers.get("content-type")?.trim() ?? "";
    if (!jsonContentTypePattern.test(contentType)) {
      await cancelBody(response);
      throw new YahooFxChartError(
        "YAHOO_FX_INVALID_RESPONSE",
        "Yahoo FX returned a non-JSON response.",
      );
    }
    const body = await readBoundedBody(response);
    const digest = createHash("sha256").update(body).digest("hex");
    const result = chartResult(jsonBody(body));
    validateMetadata(result, normalized);
    const selected = observation(result, normalized);
    return {
      ...selected,
      symbol: normalized.symbol,
      retrievedAt: clock().toISOString(),
      rawBodySha256: digest,
    };
  } catch (error) {
    if (error instanceof YahooFxChartError) throw error;
    if (isTimeout(error, signal)) {
      throw new YahooFxChartError(
        "YAHOO_FX_TIMEOUT",
        "Yahoo FX did not respond within four seconds.",
        true,
      );
    }
    throw new YahooFxChartError(
      "YAHOO_FX_NETWORK_ERROR",
      "Yahoo FX could not be reached.",
      true,
    );
  }
}
