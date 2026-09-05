import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  YAHOO_FX_CHART_LOOKBACK_DAYS,
  YAHOO_FX_CHART_MAX_BYTES,
  YAHOO_FX_CHART_ORIGIN,
  YAHOO_FX_CHART_TIMEOUT_MS,
  YahooFxChartError,
  fetchYahooFxChartRate,
  yahooDirectFxSymbol,
} from "@/modules/fx/yahoo-chart-adapter";

const fixedNow = new Date("2026-09-05T00:30:00.000Z");
const asOfDate = "2026-09-04";

function unix(date: string): number {
  return Date.parse(date) / 1_000;
}

function chartJson(input: Readonly<{
  symbol?: string;
  currency?: string;
  instrumentType?: string;
  dataGranularity?: string;
  timestamps?: readonly number[];
  closes?: readonly (number | null)[];
}> = {}): string {
  return JSON.stringify({
    chart: {
      result: [{
        meta: {
          symbol: input.symbol ?? "CAD=X",
          currency: input.currency ?? "CAD",
          instrumentType: input.instrumentType ?? "CURRENCY",
          dataGranularity: input.dataGranularity ?? "1d",
        },
        timestamp: input.timestamps ?? [
          unix("2026-09-02T00:00:00.000Z"),
          unix("2026-09-03T00:00:00.000Z"),
          unix("2026-09-04T00:00:00.000Z"),
        ],
        indicators: {
          quote: [{ close: input.closes ?? [1.37, 1.38, 1.39] }],
        },
      }],
      error: null,
    },
  });
}

function jsonResponse(body = chartJson(), headers: HeadersInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function fetchReturning(response: Response) {
  return vi.fn<typeof fetch>(async (input, init) => {
    void input;
    void init;
    return response;
  });
}

function request(overrides: Partial<Parameters<typeof fetchYahooFxChartRate>[0]> = {}) {
  return {
    enabled: true,
    sourceCurrency: "USD",
    targetCurrency: "CAD",
    asOfDate,
    ...overrides,
  };
}

function dependencies(fetchMock: ReturnType<typeof fetchReturning>) {
  return {
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => fixedNow,
  };
}

describe("Yahoo FX chart adapter (mocked fetch; no live provider calls)", () => {
  it("fails the injected operator gate before making a network request", async () => {
    const fetchMock = fetchReturning(jsonResponse());

    await expect(fetchYahooFxChartRate(
      request({ enabled: false }),
      dependencies(fetchMock),
    )).rejects.toMatchObject({
      name: "YahooFxChartError",
      code: "YAHOO_FX_DISABLED",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only the fixed origin and exact seven-day UTC window, then returns the latest positive close", async () => {
    const body = chartJson({
      timestamps: [
        unix("2026-09-04T00:00:00.000Z"),
        unix("2026-08-28T00:00:00.000Z"),
        unix("2026-09-03T00:00:00.000Z"),
      ],
      closes: [1.3900000000000001, 1.35, 1.38],
    });
    const fetchMock = fetchReturning(jsonResponse(body));

    const result = await fetchYahooFxChartRate(request(), dependencies(fetchMock));

    expect(result).toEqual({
      rate: "1.3900000000000001",
      observedAt: "2026-09-04T00:00:00.000Z",
      symbol: "CAD=X",
      retrievedAt: fixedNow.toISOString(),
      rawBodySha256: createHash("sha256").update(body).digest("hex"),
    });
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe(YAHOO_FX_CHART_ORIGIN);
    expect(url.pathname).toBe("/v8/finance/chart/CAD%3DX");
    expect(url.searchParams.get("period1")).toBe(String(unix("2026-08-28T00:00:00.000Z")));
    expect(url.searchParams.get("period2")).toBe(String(unix("2026-09-05T00:00:00.000Z")));
    expect(url.searchParams.get("interval")).toBe("1d");
    expect(url.searchParams.get("events")).toBe("history");
    expect(url.searchParams.get("includeAdjustedClose")).toBe("false");
    expect(YAHOO_FX_CHART_LOOKBACK_DAYS).toBe(7);
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["USD", "CAD", "CAD=X"],
    ["CAD", "USD", "CADUSD=X"],
    ["EUR", "CAD", "EURCAD=X"],
  ])("maps the direct %s to %s pair to %s", async (sourceCurrency, targetCurrency, symbol) => {
    expect(yahooDirectFxSymbol(sourceCurrency, targetCurrency)).toBe(symbol);
    const body = chartJson({ symbol, currency: targetCurrency, closes: [1.5, null, null] });
    const fetchMock = fetchReturning(jsonResponse(body));

    await expect(fetchYahooFxChartRate(
      request({ sourceCurrency, targetCurrency }),
      dependencies(fetchMock),
    )).resolves.toMatchObject({ symbol, rate: "1.5" });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname)
      .toBe(`/v8/finance/chart/${encodeURIComponent(symbol)}`);
  });

  it.each([
    [{ symbol: "CADUSD=X" }, "YAHOO_FX_WRONG_PAIR"],
    [{ currency: "USD" }, "YAHOO_FX_WRONG_PAIR"],
    [{ instrumentType: "EQUITY" }, "YAHOO_FX_WRONG_PAIR"],
    [{ dataGranularity: "1h" }, "YAHOO_FX_WRONG_PAIR"],
  ] as const)("rejects metadata that does not validate the requested pair and direction", async (metadata, code) => {
    const fetchMock = fetchReturning(jsonResponse(chartJson(metadata)));

    await expect(fetchYahooFxChartRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code });
  });

  it("rejects future request and provider dates without using a future observation", async () => {
    const unusedFetch = fetchReturning(jsonResponse());
    await expect(fetchYahooFxChartRate(
      request({ asOfDate: "2026-09-06" }),
      dependencies(unusedFetch),
    )).rejects.toMatchObject({ code: "YAHOO_FX_FUTURE_DATE" });
    expect(unusedFetch).not.toHaveBeenCalled();

    const futureBody = chartJson({
      timestamps: [unix("2026-09-03T00:00:00.000Z"), unix("2026-09-05T00:00:00.000Z")],
      closes: [1.38, 1.4],
    });
    const futureFetch = fetchReturning(jsonResponse(futureBody));
    await expect(fetchYahooFxChartRate(request(), dependencies(futureFetch)))
      .rejects.toMatchObject({ code: "YAHOO_FX_INVALID_RESPONSE" });
  });

  it("returns observation unavailable rather than falling back, inverting, or accepting a non-positive close", async () => {
    const body = chartJson({
      timestamps: [
        unix("2026-08-27T00:00:00.000Z"),
        unix("2026-09-02T00:00:00.000Z"),
        unix("2026-09-03T00:00:00.000Z"),
      ],
      closes: [1.31, 0, -1],
    });
    const fetchMock = fetchReturning(jsonResponse(body));

    await expect(fetchYahooFxChartRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code: "YAHOO_FX_OBSERVATION_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new Response(null, { status: 302, headers: { location: "https://example.com" } }), "YAHOO_FX_REDIRECT_REJECTED"],
    [new Response("Edge: Too Many Requests", { status: 429, headers: { "content-type": "text/html" } }), "YAHOO_FX_HTTP_ERROR"],
    [new Response("{}", { status: 200, headers: { "content-type": "text/html" } }), "YAHOO_FX_INVALID_RESPONSE"],
    [jsonResponse("not json"), "YAHOO_FX_INVALID_RESPONSE"],
    [jsonResponse(JSON.stringify({ chart: { result: [{ meta: {} }], error: null } })), "YAHOO_FX_INVALID_RESPONSE"],
  ] as const)("rejects redirects, HTTP errors, non-JSON, and malformed payloads", async (response, code) => {
    const fetchMock = fetchReturning(response);

    await expect(fetchYahooFxChartRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code });
  });

  it("exposes the upstream status and retryability for a mocked 429 without parsing its body", async () => {
    const fetchMock = fetchReturning(new Response("Edge: Too Many Requests", {
      status: 429,
      headers: { "content-type": "text/html" },
    }));

    const failure = fetchYahooFxChartRate(request(), dependencies(fetchMock));
    await expect(failure).rejects.toBeInstanceOf(YahooFxChartError);
    await expect(failure).rejects.toMatchObject({
      code: "YAHOO_FX_HTTP_ERROR",
      status: 429,
      retryable: true,
    });
  });

  it.each([
    new Response(null, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(YAHOO_FX_CHART_MAX_BYTES + 1),
      },
    }),
    new Response("x".repeat(YAHOO_FX_CHART_MAX_BYTES + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ])("rejects declared and streamed bodies over 128 KiB", async (response) => {
    const fetchMock = fetchReturning(response);

    await expect(fetchYahooFxChartRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code: "YAHOO_FX_RESPONSE_TOO_LARGE" });
  });

  it("uses an exact four-second timeout and returns a stable timeout error", async () => {
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    const fetchMock = vi.fn(async () => {
      const failure = new Error("mock timeout");
      failure.name = "TimeoutError";
      throw failure;
    });

    await expect(fetchYahooFxChartRate(request(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => fixedNow,
      timeoutSignal,
    })).rejects.toMatchObject({
      code: "YAHOO_FX_TIMEOUT",
      retryable: true,
    });
    expect(timeoutSignal).toHaveBeenCalledOnce();
    expect(timeoutSignal).toHaveBeenCalledWith(YAHOO_FX_CHART_TIMEOUT_MS);
    expect(YAHOO_FX_CHART_TIMEOUT_MS).toBe(4_000);
  });

  it("rejects invalid requests and transport failures without a second provider attempt", async () => {
    expect(() => yahooDirectFxSymbol("CAD", "CAD"))
      .toThrowError(YahooFxChartError);
    expect(() => yahooDirectFxSymbol("US$", "CAD"))
      .toThrowError(YahooFxChartError);

    const fetchMock = vi.fn(async () => { throw new TypeError("mock network failure"); });
    await expect(fetchYahooFxChartRate(request(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => fixedNow,
    })).rejects.toMatchObject({
      code: "YAHOO_FX_NETWORK_ERROR",
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
