import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  FxRateUnavailableError,
  STORED_DIRECT_FX_POLICY,
  YAHOO_DIRECT_FX_POLICY,
  resolveFx,
} from "@/modules/fx/rate-resolver";
import { YahooFxChartError } from "@/modules/fx/yahoo-chart-adapter";
import { fxSnapshotSchema } from "@/modules/subledger/document-model";

const organizationId = "10000000-0000-4000-8000-000000000001";
const rateId = "10000000-0000-4000-8000-000000000002";
const policyId = "10000000-0000-4000-8000-000000000003";

function mockClient(
  handler: (statement: string, parameters?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
) {
  const query = vi.fn(handler);
  return { client: { query } as unknown as PoolClient, query };
}

function yahooPolicy(maxLookbackDays = 7, version = 4) {
  return {
    id: policyId,
    version,
    provider_mode: "YAHOO_FINANCE_EXPERIMENTAL",
    max_lookback_days: maxLookbackDays,
    licensed_and_authorized_use_acknowledged: true,
    configured_at: "2026-09-01 09:00:00+00",
  };
}

function storedMissWithPolicy(policyRows: Record<string, unknown>[] = []) {
  return mockClient(async (statement) => {
    if (statement.includes("FROM currency_exchange_rates rate")) return { rows: [] };
    if (statement.includes("FROM organization_fx_provider_policy_versions")) {
      return { rows: policyRows };
    }
    throw new Error(`Unexpected FX SQL: ${statement}`);
  });
}

const providerObservation = {
  rate: "1.3900000000000001",
  observedAt: "2026-09-03T16:00:00.000Z",
  symbol: "CAD=X",
  retrievedAt: "2026-09-04T09:15:00.000Z",
  rawBodySha256: "a".repeat(64),
};

describe("server FX resolution", () => {
  it("selects an enabled tenant-owned direct rate deterministically and freezes provenance", async () => {
    const { client, query } = mockClient(async () => ({ rows: [{
      id: rateId,
      source_currency: "USD",
      target_currency: "CAD",
      rate: "1.370000000000000000",
      effective_at: "2026-09-03T16:30:00.000Z",
      source: "Approved daily close",
      created_at: "2026-09-03T17:00:00.000Z",
      resolved_at: "2026-09-04T09:15:00.000Z",
    }] }));
    const fetchYahooFxRate = vi.fn();

    await expect(resolveFx(client, {
      organizationId,
      transactionCurrency: "usd",
      functionalCurrency: "cad",
      asOfDate: "2026-09-04",
    }, { yahooFxEnabled: true, fetchYahooFxRate })).resolves.toEqual({
      rate: "1.37",
      source: "Approved daily close",
      effectiveAt: "2026-09-03T16:30:00.000Z",
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
      provenance: {
        mode: "ORGANIZATION_RATE",
        asOfDate: "2026-09-04",
        resolvedAt: "2026-09-04T09:15:00.000Z",
        policyKey: STORED_DIRECT_FX_POLICY.key,
        policyVersion: STORED_DIRECT_FX_POLICY.version,
        organizationRateId: rateId,
        rateRecordedAt: "2026-09-03T17:00:00.000Z",
      },
    });

    expect(query).toHaveBeenCalledOnce();
    expect(fetchYahooFxRate).not.toHaveBeenCalled();
    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain("rate.organization_id = $1");
    expect(sql).toContain("rate.source_currency = $2");
    expect(sql).toContain("rate.target_currency = $3");
    expect(sql).toContain("source_configuration.enabled");
    expect(sql).toContain("target_configuration.enabled");
    expect(sql).toContain("AT TIME ZONE 'UTC'");
    expect(sql).toContain("ORDER BY rate.effective_at DESC, rate.created_at DESC, rate.id DESC");
    expect(parameters).toEqual([organizationId, "USD", "CAD", "2026-09-04"]);
  });

  it("resolves functional currency without a database or provider lookup", async () => {
    const { client, query } = mockClient(async () => ({ rows: [] }));
    const fetchYahooFxRate = vi.fn();
    const result = await resolveFx(client, {
      organizationId,
      transactionCurrency: "CAD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    }, { yahooFxEnabled: true, fetchYahooFxRate });

    expect(query).not.toHaveBeenCalled();
    expect(fetchYahooFxRate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: "2026-09-04T00:00:00.000Z",
      provenance: {
        mode: "FUNCTIONAL",
        asOfDate: "2026-09-04",
        policyKey: "FUNCTIONAL_IDENTITY",
        policyVersion: 1,
      },
    });
  });

  it("preserves explicit caller evidence without a database or provider lookup", async () => {
    const { client, query } = mockClient(async () => ({ rows: [] }));
    const fetchYahooFxRate = vi.fn();
    const result = await resolveFx(client, {
      organizationId,
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
      explicitFx: {
        rate: "1.390000000000000000",
        source: "Contract rate",
        effectiveAt: "2026-09-04T08:00:00.000Z",
      },
    }, { yahooFxEnabled: true, fetchYahooFxRate });

    expect(query).not.toHaveBeenCalled();
    expect(fetchYahooFxRate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      rate: "1.39",
      source: "Contract rate",
      effectiveAt: "2026-09-04T08:00:00.000Z",
      provenance: {
        mode: "EXPLICIT",
        policyKey: "CALLER_EXPLICIT",
        policyVersion: 1,
      },
    });
  });

  it("fails closed under the default stored-only tenant policy", async () => {
    const { client, query } = storedMissWithPolicy();
    const fetchYahooFxRate = vi.fn();
    const failure = resolveFx(client, {
      organizationId,
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    }, { yahooFxEnabled: true, fetchYahooFxRate });

    await expect(failure).rejects.toBeInstanceOf(FxRateUnavailableError);
    await expect(failure).rejects.toMatchObject({
      code: "FX_RATE_UNAVAILABLE",
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    });
    expect(fetchYahooFxRate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
    const [policySql, policyParameters] = query.mock.calls[1]!;
    expect(policySql).toContain("WHERE organization_id = $1");
    expect(policyParameters).toEqual([organizationId]);
  });

  it("requires the separate operator gate after tenant opt-in", async () => {
    const { client } = storedMissWithPolicy([yahooPolicy()]);
    const fetchYahooFxRate = vi.fn();

    await expect(resolveFx(client, {
      organizationId,
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    }, { yahooFxEnabled: false, fetchYahooFxRate })).rejects.toMatchObject({
      code: "FX_RATE_UNAVAILABLE",
      providerFailureCode: "YAHOO_FX_DISABLED",
    });
    expect(fetchYahooFxRate).not.toHaveBeenCalled();
  });

  it("uses an authorized direct provider quote and freezes complete immutable evidence", async () => {
    const { client, query } = storedMissWithPolicy([yahooPolicy(3, 4)]);
    const fetchYahooFxRate = vi.fn(async () => providerObservation);

    const result = await resolveFx(client, {
      organizationId,
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    }, { yahooFxEnabled: true, fetchYahooFxRate });

    expect(query).toHaveBeenCalledTimes(2);
    expect(fetchYahooFxRate).toHaveBeenCalledOnce();
    expect(fetchYahooFxRate).toHaveBeenCalledWith({
      enabled: true,
      sourceCurrency: "USD",
      targetCurrency: "CAD",
      asOfDate: "2026-09-04",
    });
    expect(result).toEqual({
      rate: "1.3900000000000001",
      source: "Yahoo Finance / ICE Data Services",
      effectiveAt: providerObservation.observedAt,
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
      provenance: {
        mode: "PROVIDER_RATE",
        asOfDate: "2026-09-04",
        resolvedAt: providerObservation.retrievedAt,
        policyKey: YAHOO_DIRECT_FX_POLICY.key,
        policyVersion: 4,
        providerKey: "YAHOO_FINANCE_EXPERIMENTAL",
        providerSymbol: providerObservation.symbol,
        providerObservedAt: providerObservation.observedAt,
        providerRetrievedAt: providerObservation.retrievedAt,
        providerResponseSha256: providerObservation.rawBodySha256,
        providerMaxLookbackDays: 3,
      },
    });
    expect(fxSnapshotSchema.parse(result)).toEqual(result);
  });

  it("rejects a provider observation older than the organization's policy window", async () => {
    const { client } = storedMissWithPolicy([yahooPolicy(1)]);
    const fetchYahooFxRate = vi.fn(async () => ({
      ...providerObservation,
      observedAt: "2026-09-02T16:00:00.000Z",
    }));

    await expect(resolveFx(client, {
      organizationId,
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    }, { yahooFxEnabled: true, fetchYahooFxRate })).rejects.toMatchObject({
      code: "FX_RATE_UNAVAILABLE",
      providerFailureCode: "YAHOO_FX_OBSERVATION_UNAVAILABLE",
    });
    expect(fetchYahooFxRate).toHaveBeenCalledOnce();
  });

  it("maps provider transport errors to the stable accounting failure without fallback", async () => {
    const { client } = storedMissWithPolicy([yahooPolicy()]);
    const fetchYahooFxRate = vi.fn(async () => {
      throw new YahooFxChartError(
        "YAHOO_FX_HTTP_ERROR",
        "mock upstream rate limit",
        true,
        429,
      );
    });

    await expect(resolveFx(client, {
      organizationId,
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    }, { yahooFxEnabled: true, fetchYahooFxRate })).rejects.toMatchObject({
      code: "FX_RATE_UNAVAILABLE",
      providerFailureCode: "YAHOO_FX_HTTP_ERROR",
    });
    expect(fetchYahooFxRate).toHaveBeenCalledOnce();
  });

  it("rejects mismatched stored rows instead of accepting inverse or cross-tenant mock data", async () => {
    const { client } = mockClient(async (statement) => {
      if (statement.includes("FROM currency_exchange_rates rate")) {
        return { rows: [{
          id: rateId,
          source_currency: "CAD",
          target_currency: "USD",
          rate: "0.73",
          effective_at: "2026-09-03T16:30:00.000Z",
          source: "Inverse only",
          created_at: "2026-09-03T17:00:00.000Z",
          resolved_at: "2026-09-04T09:15:00.000Z",
        }] };
      }
      if (statement.includes("FROM organization_fx_provider_policy_versions")) return { rows: [] };
      throw new Error(`Unexpected FX SQL: ${statement}`);
    });

    await expect(resolveFx(client, {
      organizationId,
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    })).rejects.toMatchObject({ code: "FX_RATE_UNAVAILABLE" });
  });

  it("keeps historical snapshots compatible and rejects incomplete provider evidence", () => {
    const historical = {
      rate: "1.37",
      source: "Legacy explicit rate",
      effectiveAt: "2026-09-03T16:30:00.000Z",
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const,
    };
    expect(fxSnapshotSchema.parse(historical)).toEqual(historical);
    expect(() => fxSnapshotSchema.parse({
      ...historical,
      provenance: {
        mode: "PROVIDER_RATE",
        asOfDate: "2026-09-04",
        resolvedAt: "2026-09-04T09:15:00.000Z",
        policyKey: YAHOO_DIRECT_FX_POLICY.key,
        policyVersion: 1,
        providerKey: "YAHOO_FINANCE_EXPERIMENTAL",
      },
    })).toThrow(/complete immutable observation/);
  });
});
