import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { exact } from "@/kernel/money";
import {
  BANK_OF_CANADA_FX_LOOKBACK_DAYS,
  BANK_OF_CANADA_VALET_MAX_BYTES,
  BANK_OF_CANADA_VALET_ORIGIN,
  BANK_OF_CANADA_VALET_TIMEOUT_MS,
  BankOfCanadaValetError,
  bankOfCanadaFxSeriesKey,
  fetchBankOfCanadaFxRate,
} from "@/modules/fx/bank-of-canada-valet-adapter";

const fixedNow = new Date("2026-09-07T12:30:00.000Z");
const asOfDate = "2026-09-04";

type ObservationValue = Readonly<{ v: unknown }> | undefined;

function detailsFor(seriesKeys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(seriesKeys.map((seriesKey) => {
    const currency = seriesKey.slice(2, 5);
    return [seriesKey, {
      label: `${currency}/CAD`,
      description: `${currency} to Canadian dollar daily exchange rate`,
      dimension: { key: "d", name: "Date" },
    }];
  }));
}

function valetJson(input: Readonly<{
  seriesKeys?: readonly string[];
  seriesDetail?: unknown;
  terms?: unknown;
  observations?: readonly Readonly<Record<string, unknown>>[];
}> = {}): string {
  const seriesKeys = input.seriesKeys ?? ["FXUSDCAD"];
  return JSON.stringify({
    terms: input.terms ?? { url: "https://www.bankofcanada.ca/terms/" },
    seriesDetail: input.seriesDetail ?? detailsFor(seriesKeys),
    observations: input.observations ?? [
      { d: "2026-09-02", FXUSDCAD: { v: "1.3700" } },
      { d: "2026-09-04", FXUSDCAD: { v: "1.3900" } },
      { d: "2026-09-03", FXUSDCAD: { v: "1.3800" } },
    ],
  });
}

function jsonResponse(body = valetJson(), headers: HeadersInit = {}): Response {
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

function request(overrides: Partial<Parameters<typeof fetchBankOfCanadaFxRate>[0]> = {}) {
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

function value(v: unknown): ObservationValue {
  return { v };
}

describe("Bank of Canada Valet FX adapter (mocked fetch; no live provider calls)", () => {
  it("uses the fixed official origin and bounded UTC window, then selects the latest observation regardless of response order", async () => {
    const body = valetJson({
      observations: [
        { d: "2026-09-03", FXUSDCAD: value("1.3800") },
        { d: "2026-08-28", FXUSDCAD: value("1.3500") },
        { d: "2026-09-04", FXUSDCAD: value("1.3900") },
      ],
    });
    const fetchMock = fetchReturning(jsonResponse(body));

    const result = await fetchBankOfCanadaFxRate(request(), dependencies(fetchMock));

    expect(result).toEqual({
      rate: "1.39",
      observedAt: "2026-09-04T00:00:00.000Z",
      sourceCurrency: "USD",
      targetCurrency: "CAD",
      calculation: "DIRECT_TO_CAD",
      formula: "CAD_PER_SOURCE_UNIT",
      legs: [{
        currency: "USD",
        cadPerUnit: "1.3900",
        observedDate: "2026-09-04",
        seriesKey: "FXUSDCAD",
      }],
      retrievedAt: fixedNow.toISOString(),
      rawBodySha256: createHash("sha256").update(body).digest("hex"),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe(BANK_OF_CANADA_VALET_ORIGIN);
    expect(url.pathname).toBe("/valet/observations/FXUSDCAD/json");
    expect(url.searchParams.get("start_date")).toBe("2026-08-28");
    expect(url.searchParams.get("end_date")).toBe("2026-09-04");
    expect(url.searchParams.get("order_dir")).toBe("desc");
    expect(BANK_OF_CANADA_FX_LOOKBACK_DAYS).toBe(7);
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("inverts a published foreign-to-CAD leg for a CAD-to-foreign request", async () => {
    const body = valetJson({
      seriesKeys: ["FXEURCAD"],
      observations: [{ d: "2026-09-04", FXEURCAD: value("1.6000") }],
    });
    const fetchMock = fetchReturning(jsonResponse(body));

    await expect(fetchBankOfCanadaFxRate(
      request({ sourceCurrency: "CAD", targetCurrency: "EUR" }),
      dependencies(fetchMock),
    )).resolves.toMatchObject({
      rate: "0.625",
      calculation: "INVERSE_FROM_CAD",
      formula: "1 / CAD_PER_TARGET_UNIT",
      sourceCurrency: "CAD",
      targetCurrency: "EUR",
      legs: [{
        currency: "EUR",
        cadPerUnit: "1.6000",
        observedDate: "2026-09-04",
        seriesKey: "FXEURCAD",
      }],
    });
  });

  it("derives a cross through CAD from the latest date common to both raw legs", async () => {
    const body = valetJson({
      seriesKeys: ["FXEURCAD", "FXUSDCAD"],
      observations: [
        { d: "2026-09-04", FXEURCAD: value("1.6200") },
        { d: "2026-09-02", FXUSDCAD: value("1.3800") },
        {
          d: "2026-09-03",
          FXEURCAD: value("1.6100"),
          FXUSDCAD: value("1.3900"),
        },
      ],
    });
    const fetchMock = fetchReturning(jsonResponse(body));

    const result = await fetchBankOfCanadaFxRate(
      request({ sourceCurrency: "EUR", targetCurrency: "USD" }),
      dependencies(fetchMock),
    );

    expect(result).toMatchObject({
      rate: exact("1.6100").dividedBy("1.3900").toFixed(),
      observedAt: "2026-09-03T00:00:00.000Z",
      calculation: "CROSS_VIA_CAD",
      formula: "CAD_PER_SOURCE_UNIT / CAD_PER_TARGET_UNIT",
      legs: [
        {
          currency: "EUR",
          cadPerUnit: "1.6100",
          observedDate: "2026-09-03",
          seriesKey: "FXEURCAD",
        },
        {
          currency: "USD",
          cadPerUnit: "1.3900",
          observedDate: "2026-09-03",
          seriesKey: "FXUSDCAD",
        },
      ],
    });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname)
      .toBe("/valet/observations/FXEURCAD,FXUSDCAD/json");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the prior business-day observation for a weekend as-of date", async () => {
    const body = valetJson({
      observations: [
        { d: "2026-09-03", FXUSDCAD: value("1.3800") },
        { d: "2026-09-04", FXUSDCAD: value("1.3900") },
      ],
    });
    const fetchMock = fetchReturning(jsonResponse(body));

    await expect(fetchBankOfCanadaFxRate(
      request({ asOfDate: "2026-09-06" }),
      dependencies(fetchMock),
    )).resolves.toMatchObject({
      rate: "1.39",
      observedAt: "2026-09-04T00:00:00.000Z",
    });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("start_date")).toBe("2026-08-30");
    expect(url.searchParams.get("end_date")).toBe("2026-09-06");
  });

  it.each([
    ["USD", "FXUSDCAD"],
    ["EUR", "FXEURCAD"],
    ["jpy", "FXJPYCAD"],
    [" pln ", "FXPLNCAD"],
  ])("maps the supported %s currency to the official %s series", (currency, seriesKey) => {
    expect(bankOfCanadaFxSeriesKey(currency)).toBe(seriesKey);
  });

  it("rejects invalid, identity, unsupported, and future requests before any provider call", async () => {
    const fetchMock = fetchReturning(jsonResponse());

    expect(() => bankOfCanadaFxSeriesKey("CAD")).toThrowError(BankOfCanadaValetError);
    expect(() => bankOfCanadaFxSeriesKey("AED")).toThrowError(BankOfCanadaValetError);
    expect(() => bankOfCanadaFxSeriesKey("US$")).toThrowError(BankOfCanadaValetError);
    await expect(fetchBankOfCanadaFxRate(
      request({ sourceCurrency: "USD", targetCurrency: "USD" }),
      dependencies(fetchMock),
    )).rejects.toMatchObject({ code: "BANK_OF_CANADA_FX_INVALID_REQUEST" });
    await expect(fetchBankOfCanadaFxRate(
      request({ sourceCurrency: "AED", targetCurrency: "CAD" }),
      dependencies(fetchMock),
    )).rejects.toMatchObject({ code: "BANK_OF_CANADA_FX_UNSUPPORTED_PAIR" });
    await expect(fetchBankOfCanadaFxRate(
      request({ asOfDate: "2026-09-08" }),
      dependencies(fetchMock),
    )).rejects.toMatchObject({ code: "BANK_OF_CANADA_FX_FUTURE_DATE" });
    await expect(fetchBankOfCanadaFxRate(
      request({ asOfDate: "2026-02-30" }),
      dependencies(fetchMock),
    )).rejects.toMatchObject({ code: "BANK_OF_CANADA_FX_INVALID_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      { ...detailsFor(["FXUSDCAD"]), FXEURCAD: detailsFor(["FXEURCAD"]).FXEURCAD },
      "extra series detail",
    ],
    [
      { FXUSDCAD: { ...detailsFor(["FXUSDCAD"]).FXUSDCAD as object, label: "EUR/CAD" } },
      "wrong label",
    ],
    [
      { FXUSDCAD: { ...detailsFor(["FXUSDCAD"]).FXUSDCAD as object, dimension: { key: "x", name: "Date" } } },
      "wrong dimension",
    ],
  ])("rejects %s metadata instead of accepting the wrong published series", async (seriesDetail, label) => {
    expect(label).toEqual(expect.any(String));
    const fetchMock = fetchReturning(jsonResponse(valetJson({ seriesDetail })));

    await expect(fetchBankOfCanadaFxRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code: "BANK_OF_CANADA_FX_WRONG_SERIES" });
  });

  it("rejects observations for an unrequested series", async () => {
    const fetchMock = fetchReturning(jsonResponse(valetJson({
      observations: [{
        d: "2026-09-04",
        FXUSDCAD: value("1.3900"),
        FXEURCAD: value("1.6100"),
      }],
    })));

    await expect(fetchBankOfCanadaFxRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code: "BANK_OF_CANADA_FX_WRONG_SERIES" });
  });

  it.each([
    [valetJson({ terms: { url: "https://example.com/terms" } }), "invalid terms"],
    [valetJson({ observations: [{ d: "2026-02-30", FXUSDCAD: value("1.39") }] }), "invalid date"],
    [valetJson({ observations: [{ d: "2026-09-05", FXUSDCAD: value("1.39") }] }), "after-date observation"],
    [valetJson({ observations: [{ d: "2026-08-27", FXUSDCAD: value("1.39") }] }), "before-window observation"],
    [valetJson({ observations: [
      { d: "2026-09-04", FXUSDCAD: value("1.39") },
      { d: "2026-09-04", FXUSDCAD: value("1.40") },
    ] }), "duplicate date"],
    [valetJson({ observations: [{ d: "2026-09-04", FXUSDCAD: value("NaN") }] }), "non-decimal rate"],
    [valetJson({ observations: [{ d: "2026-09-04", FXUSDCAD: value("0") }] }), "non-positive rate"],
    [valetJson({ observations: [{ d: "2026-09-04", FXUSDCAD: { v: "1.39", extra: true } }] }), "extra rate fields"],
  ])("rejects a mocked %s response as malformed", async (body) => {
    const fetchMock = fetchReturning(jsonResponse(body));

    await expect(fetchBankOfCanadaFxRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code: "BANK_OF_CANADA_FX_INVALID_RESPONSE" });
  });

  it("fails closed when the requested window has no common cross-rate date", async () => {
    const body = valetJson({
      seriesKeys: ["FXEURCAD", "FXUSDCAD"],
      observations: [
        { d: "2026-09-04", FXEURCAD: value("1.6200") },
        { d: "2026-09-03", FXUSDCAD: value("1.3900") },
      ],
    });
    const fetchMock = fetchReturning(jsonResponse(body));

    await expect(fetchBankOfCanadaFxRate(
      request({ sourceCurrency: "EUR", targetCurrency: "USD" }),
      dependencies(fetchMock),
    )).rejects.toMatchObject({
      code: "BANK_OF_CANADA_FX_OBSERVATION_UNAVAILABLE",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [new Response(null, { status: 302, headers: { location: "https://example.com" } }), "BANK_OF_CANADA_FX_REDIRECT_REJECTED"],
    [new Response("Busy", { status: 503, headers: { "content-type": "text/plain" } }), "BANK_OF_CANADA_FX_HTTP_ERROR"],
    [new Response("{}", { status: 200, headers: { "content-type": "text/html" } }), "BANK_OF_CANADA_FX_INVALID_RESPONSE"],
    [jsonResponse("not json"), "BANK_OF_CANADA_FX_INVALID_RESPONSE"],
    [jsonResponse(JSON.stringify({ terms: {}, seriesDetail: {}, observations: [] })), "BANK_OF_CANADA_FX_INVALID_RESPONSE"],
  ] as const)("rejects redirects, HTTP failures, non-JSON, and malformed payloads", async (response, code) => {
    const fetchMock = fetchReturning(response);

    await expect(fetchBankOfCanadaFxRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code });
  });

  it("exposes upstream status and retryability without parsing an error body", async () => {
    const fetchMock = fetchReturning(new Response("Too Many Requests", {
      status: 429,
      headers: { "content-type": "text/plain" },
    }));

    const failure = fetchBankOfCanadaFxRate(request(), dependencies(fetchMock));
    await expect(failure).rejects.toBeInstanceOf(BankOfCanadaValetError);
    await expect(failure).rejects.toMatchObject({
      code: "BANK_OF_CANADA_FX_HTTP_ERROR",
      status: 429,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    new Response(null, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(BANK_OF_CANADA_VALET_MAX_BYTES + 1),
      },
    }),
    new Response("x".repeat(BANK_OF_CANADA_VALET_MAX_BYTES + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ])("rejects declared and streamed bodies over 128 KiB", async (response) => {
    const fetchMock = fetchReturning(response);

    await expect(fetchBankOfCanadaFxRate(request(), dependencies(fetchMock)))
      .rejects.toMatchObject({ code: "BANK_OF_CANADA_FX_RESPONSE_TOO_LARGE" });
  });

  it("uses an exact four-second timeout and returns a stable retryable error", async () => {
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    const fetchMock = vi.fn(async () => {
      const failure = new Error("mock timeout");
      failure.name = "TimeoutError";
      throw failure;
    });

    await expect(fetchBankOfCanadaFxRate(request(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => fixedNow,
      timeoutSignal,
    })).rejects.toMatchObject({
      code: "BANK_OF_CANADA_FX_TIMEOUT",
      retryable: true,
    });
    expect(timeoutSignal).toHaveBeenCalledOnce();
    expect(timeoutSignal).toHaveBeenCalledWith(BANK_OF_CANADA_VALET_TIMEOUT_MS);
    expect(BANK_OF_CANADA_VALET_TIMEOUT_MS).toBe(4_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps a transport failure without retrying or attempting another source", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("mock network failure"); });

    await expect(fetchBankOfCanadaFxRate(request(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => fixedNow,
    })).rejects.toMatchObject({
      code: "BANK_OF_CANADA_FX_NETWORK_ERROR",
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
