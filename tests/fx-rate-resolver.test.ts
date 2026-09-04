import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  FxRateUnavailableError,
  STORED_DIRECT_FX_POLICY,
  resolveFx,
} from "@/modules/fx/rate-resolver";
import { fxSnapshotSchema } from "@/modules/subledger/document-model";

const organizationId = "10000000-0000-4000-8000-000000000001";
const rateId = "10000000-0000-4000-8000-000000000002";

function clientWithRows(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn(async (...input: [string, (readonly unknown[])?]) => {
    void input;
    return { rows };
  });
  return { client: { query } as unknown as PoolClient, query };
}

describe("server FX resolution", () => {
  it("selects an enabled tenant-owned direct rate deterministically and freezes provenance", async () => {
    const { client, query } = clientWithRows([{
      id: rateId,
      source_currency: "USD",
      target_currency: "CAD",
      rate: "1.370000000000000000",
      effective_at: "2026-09-03T16:30:00.000Z",
      source: "Approved daily close",
      created_at: "2026-09-03T17:00:00.000Z",
      resolved_at: "2026-09-04T09:15:00.000Z",
    }]);

    await expect(resolveFx(client, {
      organizationId,
      transactionCurrency: "usd",
      functionalCurrency: "cad",
      asOfDate: "2026-09-04",
    })).resolves.toEqual({
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

  it("resolves functional currency without a database lookup", async () => {
    const { client, query } = clientWithRows([]);
    const result = await resolveFx(client, {
      organizationId,
      transactionCurrency: "CAD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    });

    expect(query).not.toHaveBeenCalled();
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

  it("preserves explicit caller evidence and labels it as explicit", async () => {
    const { client, query } = clientWithRows([]);
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
    });

    expect(query).not.toHaveBeenCalled();
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

  it("fails closed with a stable code when no exact direct rate is available", async () => {
    const { client } = clientWithRows([]);
    const failure = resolveFx(client, {
      organizationId,
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    });

    await expect(failure).rejects.toBeInstanceOf(FxRateUnavailableError);
    await expect(failure).rejects.toMatchObject({
      code: "FX_RATE_UNAVAILABLE",
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    });
  });

  it("rejects a mismatched row instead of accepting inverse or cross-tenant mock data", async () => {
    const { client } = clientWithRows([{
      id: rateId,
      source_currency: "CAD",
      target_currency: "USD",
      rate: "0.73",
      effective_at: "2026-09-03T16:30:00.000Z",
      source: "Inverse only",
      created_at: "2026-09-03T17:00:00.000Z",
      resolved_at: "2026-09-04T09:15:00.000Z",
    }]);

    await expect(resolveFx(client, {
      organizationId,
      transactionCurrency: "USD",
      functionalCurrency: "CAD",
      asOfDate: "2026-09-04",
    })).rejects.toMatchObject({ code: "FX_RATE_UNAVAILABLE" });
  });

  it("keeps historical FX snapshots without provenance byte-shape compatible", () => {
    const historical = {
      rate: "1.37",
      source: "Legacy explicit rate",
      effectiveAt: "2026-09-03T16:30:00.000Z",
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT" as const,
    };
    expect(fxSnapshotSchema.parse(historical)).toEqual(historical);
  });
});
