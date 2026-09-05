import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ECB_FX_CALCULATION_DECIMAL_PLACES,
  ECB_FX_DATA_LOOKBACK_DAYS,
  ECB_FX_DATA_MAX_BYTES,
  ECB_FX_DATA_ORIGIN,
  ECB_FX_DATA_TIMEOUT_MS,
  EcbFxReferenceError,
  fetchEcbFxReferenceRate,
} from "@/modules/fx/ecb-reference-rate-adapter";

const fixedNow = new Date("2026-09-05T00:30:00.000Z");
const asOfDate = "2026-09-04";
const header = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE";

type CsvRow = Readonly<{
  currency: string;
  date: string;
  value: string;
  key?: string;
  frequency?: string;
  denominator?: string;
  rateType?: string;
  suffix?: string;
}>;

function csvBody(rows: readonly CsvRow[]): string {
  return [
    header,
    ...rows.map((row) => [
      row.key ?? `EXR.D.${row.currency}.EUR.SP00.A`,
      row.frequency ?? "D",
      row.currency,
      row.denominator ?? "EUR",
      row.rateType ?? "SP00",
      row.suffix ?? "A",
      row.date,
      row.value,
    ].join(",")),
  ].join("\r\n");
}

function csvResponse(
  body: string,
  headers: HeadersInit = {},
): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", ...headers },
  });
}

function fetchReturning(response: Response) {
  return vi.fn<typeof fetch>(async (input, init) => {
    void input;
    void init;
    return response;
  });
}

function request(overrides: Partial<Parameters<typeof fetchEcbFxReferenceRate>[0]> = {}) {
  return {
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

describe("ECB reference-rate adapter (mocked fetch; no live provider calls)", () => {
  it("uses one fixed-origin request for the exact daily series and bounded UTC window", async () => {
    const body = csvBody([
      { currency: "CAD", date: "2026-09-04", value: "1.60" },
      { currency: "USD", date: "2026-09-04", value: "1.25" },
    ]);
    const fetchMock = fetchReturning(csvResponse(body));

    const result = await fetchEcbFxReferenceRate(request(), dependencies(fetchMock));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe(ECB_FX_DATA_ORIGIN);
    expect(url.pathname).toBe("/service/data/EXR/D.CAD+USD.EUR.SP00.A");
    expect(url.searchParams.get("startPeriod")).toBe("2026-08-28");
    expect(url.searchParams.get("endPeriod")).toBe("2026-09-04");
    expect(url.searchParams.get("detail")).toBe("dataonly");
    expect(url.searchParams.get("format")).toBe("csvdata");
    expect(ECB_FX_DATA_LOOKBACK_DAYS).toBe(7);
    expect(init).toMatchObject({
      method: "GET",
      headers: { Accept: "text/csv" },
      cache: "no-store",
      redirect: "manual",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(result.rawBodySha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("returns an ECB direct leg and preserves its published decimal", async () => {
    const body = csvBody([
      { currency: "CAD", date: "2026-09-03", value: "1.59" },
      { currency: "CAD", date: "2026-09-04", value: "1.60" },
    ]);
    const fetchMock = fetchReturning(csvResponse(body));

    await expect(fetchEcbFxReferenceRate(
      request({ sourceCurrency: "EUR", targetCurrency: "CAD" }),
      dependencies(fetchMock),
    )).resolves.toEqual({
      rate: "1.6",
      observedAt: "2026-09-04T00:00:00.000Z",
      sourceCurrency: "EUR",
      targetCurrency: "CAD",
      calculation: "DIRECT_FROM_EUR",
      formula: "TARGET_UNITS_PER_EUR",
      legs: [{
        currency: "CAD",
        unitsPerEuro: "1.60",
        observedDate: "2026-09-04",
        seriesKey: "EXR.D.CAD.EUR.SP00.A",
      }],
      retrievedAt: fixedNow.toISOString(),
      rawBodySha256: createHash("sha256").update(body).digest("hex"),
    });
  });

  it("uses exact decimal arithmetic to invert a source-units-per-EUR leg", async () => {
    const fetchMock = fetchReturning(csvResponse(csvBody([
      { currency: "CAD", date: "2026-09-04", value: "1.6" },
    ])));

    await expect(fetchEcbFxReferenceRate(
      request({ sourceCurrency: "CAD", targetCurrency: "EUR" }),
      dependencies(fetchMock),
    )).resolves.toMatchObject({
      rate: "0.625",
      calculation: "INVERSE_TO_EUR",
      formula: "1 / SOURCE_UNITS_PER_EUR",
      legs: [{ currency: "CAD", unitsPerEuro: "1.6" }],
    });
    expect(ECB_FX_CALCULATION_DECIMAL_PLACES).toBe(18);
  });

  it("derives target units per source unit from two legs on the latest common date", async () => {
    const fetchMock = fetchReturning(csvResponse(csvBody([
      { currency: "CAD", date: "2026-09-03", value: "1.50" },
      { currency: "CAD", date: "2026-09-04", value: "1.60" },
      { currency: "USD", date: "2026-09-02", value: "1.20" },
      { currency: "USD", date: "2026-09-03", value: "1.25" },
    ])));

    await expect(fetchEcbFxReferenceRate(request(), dependencies(fetchMock))).resolves.toMatchObject({
      rate: "1.2",
      observedAt: "2026-09-03T00:00:00.000Z",
      sourceCurrency: "USD",
      targetCurrency: "CAD",
      calculation: "CROSS_VIA_EUR",
      formula: "TARGET_UNITS_PER_EUR / SOURCE_UNITS_PER_EUR",
      legs: [
        {
          currency: "USD",
          unitsPerEuro: "1.25",
          observedDate: "2026-09-03",
          seriesKey: "EXR.D.USD.EUR.SP00.A",
        },
        {
          currency: "CAD",
          unitsPerEuro: "1.50",
          observedDate: "2026-09-03",
          seriesKey: "EXR.D.CAD.EUR.SP00.A",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when cross-rate legs have no common observation date", async () => {
    const fetchMock = fetchReturning(csvResponse(csvBody([
      { currency: "CAD", date: "2026-09-04", value: "1.60" },
      { currency: "USD", date: "2026-09-03", value: "1.25" },
    ])));

    await expect(fetchEcbFxReferenceRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code: "ECB_FX_OBSERVATION_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [{ key: "EXR.D.USD.EUR.SP00.B" }, "ECB_FX_WRONG_SERIES"],
    [{ frequency: "M" }, "ECB_FX_WRONG_SERIES"],
    [{ denominator: "GBP" }, "ECB_FX_WRONG_SERIES"],
    [{ rateType: "EN00" }, "ECB_FX_WRONG_SERIES"],
    [{ suffix: "H" }, "ECB_FX_WRONG_SERIES"],
    [{ currency: "GBP" }, "ECB_FX_WRONG_SERIES"],
  ] as const)("rejects series metadata that does not exactly match the query", async (override, code) => {
    const row = {
      currency: "USD",
      date: "2026-09-04",
      value: "1.25",
      ...override,
    };
    const fetchMock = fetchReturning(csvResponse(csvBody([row])));

    await expect(fetchEcbFxReferenceRate(
      request({ targetCurrency: "EUR" }),
      dependencies(fetchMock),
    )).rejects.toMatchObject({ code });
  });

  it("rejects future request dates and observations outside the exact requested window", async () => {
    const unusedFetch = fetchReturning(csvResponse(csvBody([])));
    await expect(fetchEcbFxReferenceRate(
      request({ asOfDate: "2026-09-06" }),
      dependencies(unusedFetch),
    )).rejects.toMatchObject({ code: "ECB_FX_FUTURE_DATE" });
    expect(unusedFetch).not.toHaveBeenCalled();

    for (const date of ["2026-08-27", "2026-09-05"]) {
      const fetchMock = fetchReturning(csvResponse(csvBody([
        { currency: "USD", date, value: "1.25" },
      ])));
      await expect(fetchEcbFxReferenceRate(
        request({ targetCurrency: "EUR" }),
        dependencies(fetchMock),
      )).rejects.toMatchObject({ code: "ECB_FX_INVALID_RESPONSE" });
    }
  });

  it.each([
    ["not,a,recognized,header\r\n1,2,3,4", "ECB_FX_INVALID_RESPONSE"],
    [`${header}\r\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-04`, "ECB_FX_INVALID_RESPONSE"],
    [`${header}\r\n\"unterminated`, "ECB_FX_INVALID_RESPONSE"],
    [csvBody([{ currency: "USD", date: "2026-02-30", value: "1.25" }]), "ECB_FX_INVALID_RESPONSE"],
    [csvBody([{ currency: "USD", date: "2026-09-04", value: "NaN" }]), "ECB_FX_INVALID_RESPONSE"],
    [csvBody([{ currency: "USD", date: "2026-09-04", value: "0" }]), "ECB_FX_INVALID_RESPONSE"],
  ] as const)("rejects malformed CSV, invalid dates, and invalid rates", async (body, code) => {
    const fetchMock = fetchReturning(csvResponse(body));

    await expect(fetchEcbFxReferenceRate(
      request({ targetCurrency: "EUR" }),
      dependencies(fetchMock),
    )).rejects.toMatchObject({ code });
  });

  it("rejects duplicate currency-date observations", async () => {
    const row = { currency: "USD", date: "2026-09-04", value: "1.25" };
    const fetchMock = fetchReturning(csvResponse(csvBody([row, row])));

    await expect(fetchEcbFxReferenceRate(
      request({ targetCurrency: "EUR" }),
      dependencies(fetchMock),
    )).rejects.toMatchObject({ code: "ECB_FX_INVALID_RESPONSE" });
  });

  it.each([
    [new Response(null, { status: 302, headers: { location: "https://example.com" } }), "ECB_FX_REDIRECT_REJECTED"],
    [new Response("busy", { status: 503, headers: { "content-type": "text/plain" } }), "ECB_FX_HTTP_ERROR"],
    [new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), "ECB_FX_INVALID_RESPONSE"],
  ] as const)("rejects redirects, unsuccessful statuses, and non-CSV responses", async (response, code) => {
    const fetchMock = fetchReturning(response);

    await expect(fetchEcbFxReferenceRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code });
  });

  it("accepts the official SDMX CSV media type", async () => {
    const body = csvBody([{ currency: "USD", date: "2026-09-04", value: "1.25" }]);
    const fetchMock = fetchReturning(csvResponse(body, {
      "content-type": "application/vnd.sdmx.data+csv;version=2.0.0",
    }));

    await expect(fetchEcbFxReferenceRate(
      request({ targetCurrency: "EUR" }),
      dependencies(fetchMock),
    )).resolves.toMatchObject({ rate: "0.8" });
  });

  it("exposes upstream retryability and status without parsing the error body", async () => {
    const fetchMock = fetchReturning(new Response("temporarily unavailable", {
      status: 503,
      headers: { "content-type": "text/plain" },
    }));

    const failure = fetchEcbFxReferenceRate(request(), dependencies(fetchMock));
    await expect(failure).rejects.toBeInstanceOf(EcbFxReferenceError);
    await expect(failure).rejects.toMatchObject({
      code: "ECB_FX_HTTP_ERROR",
      status: 503,
      retryable: true,
    });
  });

  it.each([
    new Response(null, {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-length": String(ECB_FX_DATA_MAX_BYTES + 1),
      },
    }),
    new Response("x".repeat(ECB_FX_DATA_MAX_BYTES + 1), {
      status: 200,
      headers: { "content-type": "text/csv" },
    }),
  ])("rejects declared and streamed bodies over 64 KiB", async (response) => {
    const fetchMock = fetchReturning(response);

    await expect(fetchEcbFxReferenceRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code: "ECB_FX_RESPONSE_TOO_LARGE" });
  });

  it("uses an exact four-second timeout and makes no retry", async () => {
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    const fetchMock = vi.fn(async () => {
      const error = new Error("mock timeout");
      error.name = "TimeoutError";
      throw error;
    });

    await expect(fetchEcbFxReferenceRate(request(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => fixedNow,
      timeoutSignal,
    })).rejects.toMatchObject({ code: "ECB_FX_TIMEOUT", retryable: true });
    expect(timeoutSignal).toHaveBeenCalledOnce();
    expect(timeoutSignal).toHaveBeenCalledWith(ECB_FX_DATA_TIMEOUT_MS);
    expect(ECB_FX_DATA_TIMEOUT_MS).toBe(4_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects invalid requests and network failures before any retry", async () => {
    const unusedFetch = fetchReturning(csvResponse(csvBody([])));
    for (const overrides of [
      { sourceCurrency: "US$" },
      { sourceCurrency: "CAD", targetCurrency: "CAD" },
      { asOfDate: "2026-09-31" },
    ]) {
      await expect(fetchEcbFxReferenceRate(
        request(overrides),
        dependencies(unusedFetch),
      )).rejects.toMatchObject({ code: "ECB_FX_INVALID_REQUEST" });
    }
    expect(unusedFetch).not.toHaveBeenCalled();

    const fetchMock = vi.fn(async () => { throw new TypeError("mock network failure"); });
    await expect(fetchEcbFxReferenceRate(request(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => fixedNow,
    })).rejects.toMatchObject({ code: "ECB_FX_NETWORK_ERROR", retryable: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
