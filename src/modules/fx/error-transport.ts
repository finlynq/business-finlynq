import type { FxProviderFailureCode } from "./rate-resolver";

export const SAFE_FX_RATE_UNAVAILABLE_MESSAGE =
  "No permitted FX rate is available. Record an organization rate, provide explicit FX evidence, or review the selected provider.";

const transportableProviderFailureCodes = new Set<string>([
  "YAHOO_FX_DISABLED",
  "YAHOO_FX_INVALID_REQUEST",
  "YAHOO_FX_FUTURE_DATE",
  "YAHOO_FX_TIMEOUT",
  "YAHOO_FX_NETWORK_ERROR",
  "YAHOO_FX_REDIRECT_REJECTED",
  "YAHOO_FX_HTTP_ERROR",
  "YAHOO_FX_RESPONSE_TOO_LARGE",
  "YAHOO_FX_INVALID_RESPONSE",
  "YAHOO_FX_WRONG_PAIR",
  "YAHOO_FX_OBSERVATION_UNAVAILABLE",
  "BANK_OF_CANADA_FX_INVALID_REQUEST",
  "BANK_OF_CANADA_FX_FUTURE_DATE",
  "BANK_OF_CANADA_FX_UNSUPPORTED_PAIR",
  "BANK_OF_CANADA_FX_TIMEOUT",
  "BANK_OF_CANADA_FX_NETWORK_ERROR",
  "BANK_OF_CANADA_FX_REDIRECT_REJECTED",
  "BANK_OF_CANADA_FX_HTTP_ERROR",
  "BANK_OF_CANADA_FX_RESPONSE_TOO_LARGE",
  "BANK_OF_CANADA_FX_INVALID_RESPONSE",
  "BANK_OF_CANADA_FX_WRONG_SERIES",
  "BANK_OF_CANADA_FX_OBSERVATION_UNAVAILABLE",
  "ECB_FX_INVALID_REQUEST",
  "ECB_FX_FUTURE_DATE",
  "ECB_FX_TIMEOUT",
  "ECB_FX_NETWORK_ERROR",
  "ECB_FX_REDIRECT_REJECTED",
  "ECB_FX_HTTP_ERROR",
  "ECB_FX_RESPONSE_TOO_LARGE",
  "ECB_FX_INVALID_RESPONSE",
  "ECB_FX_WRONG_SERIES",
  "ECB_FX_OBSERVATION_UNAVAILABLE",
] satisfies readonly FxProviderFailureCode[]);

export type SafeFxRateUnavailableDetails = Readonly<{
  code: "FX_RATE_UNAVAILABLE";
  providerFailureCode?: FxProviderFailureCode;
}>;

/** Returns only reviewed, fixed-cardinality FX failure identifiers. */
export function safeFxRateUnavailableDetails(
  error: unknown,
): SafeFxRateUnavailableDetails | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; providerFailureCode?: unknown };
  if (candidate.code !== "FX_RATE_UNAVAILABLE") return undefined;
  if (typeof candidate.providerFailureCode === "string"
      && transportableProviderFailureCodes.has(candidate.providerFailureCode)) {
    return {
      code: "FX_RATE_UNAVAILABLE",
      providerFailureCode: candidate.providerFailureCode as FxProviderFailureCode,
    };
  }
  return { code: "FX_RATE_UNAVAILABLE" };
}
