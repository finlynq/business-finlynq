import "server-only";

import type { PoolClient } from "pg";
import { exact } from "@/kernel/money";

export const STORED_DIRECT_FX_POLICY = Object.freeze({
  key: "STORED_DIRECT_LATEST_EFFECTIVE_UTC_DATE",
  version: 1,
});

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
    mode: "FUNCTIONAL" | "ORGANIZATION_RATE" | "EXPLICIT";
    asOfDate: string;
    resolvedAt: string;
    policyKey: string;
    policyVersion: number;
    organizationRateId?: string;
    rateRecordedAt?: string;
  }>;
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

function provenance(
  mode: ResolvedFx["provenance"]["mode"],
  asOfDate: string,
  resolvedAt: string,
  stored?: Pick<StoredRateRow, "id" | "created_at">,
): ResolvedFx["provenance"] {
  return {
    mode,
    asOfDate,
    resolvedAt,
    policyKey: mode === "ORGANIZATION_RATE"
      ? STORED_DIRECT_FX_POLICY.key
      : mode === "FUNCTIONAL" ? "FUNCTIONAL_IDENTITY" : "CALLER_EXPLICIT",
    policyVersion: 1,
    ...(stored ? {
      organizationRateId: stored.id,
      rateRecordedAt: timestamp(stored.created_at, "recorded time"),
    } : {}),
  };
}

export class FxRateUnavailableError extends Error {
  readonly code = "FX_RATE_UNAVAILABLE";

  constructor(
    readonly transactionCurrency: string,
    readonly functionalCurrency: string,
    readonly asOfDate: string,
  ) {
    super(
      `No approved stored ${transactionCurrency}/${functionalCurrency} FX rate is effective on or before ${asOfDate}. Record a direct organization rate or provide explicit FX evidence.`,
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
      provenance: provenance("EXPLICIT", input.asOfDate, resolvedAt),
    };
  }

  if (transactionCurrency === functionalCurrency) {
    return {
      rate: "1",
      source: "FUNCTIONAL",
      effectiveAt: `${input.asOfDate}T00:00:00.000Z`,
      quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
      provenance: provenance("FUNCTIONAL", input.asOfDate, resolvedAt),
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
  if (!stored || stored.source_currency !== transactionCurrency
      || stored.target_currency !== functionalCurrency) {
    throw new FxRateUnavailableError(transactionCurrency, functionalCurrency, input.asOfDate);
  }
  return {
    rate: exact(stored.rate).toFixed(),
    source: stored.source,
    effectiveAt: timestamp(stored.effective_at, "effective time"),
    quoteConvention: "FUNCTIONAL_UNITS_PER_TRANSACTION_UNIT",
    provenance: provenance(
      "ORGANIZATION_RATE",
      input.asOfDate,
      timestamp(stored.resolved_at, "resolution time"),
      stored,
    ),
  };
}
