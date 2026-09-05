import { describe, expect, it } from "vitest";
import {
  safeFxRateUnavailableDetails,
} from "@/modules/fx/error-transport";
import { FxRateUnavailableError } from "@/modules/fx/rate-resolver";
import { mcpToolFailureResult } from "@/modules/mcp/tool-types";

describe("FX failure transport", () => {
  it.each([
    "YAHOO_FX_HTTP_ERROR",
    "BANK_OF_CANADA_FX_OBSERVATION_UNAVAILABLE",
    "ECB_FX_TIMEOUT",
  ] as const)("preserves the reviewed %s provider code", (providerFailureCode) => {
    const failure = new FxRateUnavailableError(
      "USD",
      "CAD",
      "2026-09-04",
      providerFailureCode,
    );

    expect(safeFxRateUnavailableDetails(failure)).toEqual({
      code: "FX_RATE_UNAVAILABLE",
      providerFailureCode,
    });
  });

  it("fails closed when an object carries an unreviewed provider value", () => {
    expect(safeFxRateUnavailableDetails({
      code: "FX_RATE_UNAVAILABLE",
      providerFailureCode: "ECB_FX_HTTP_ERROR\nupstream-secret",
      upstreamStatus: 502,
      upstreamBody: "upstream-secret",
    })).toEqual({ code: "FX_RATE_UNAVAILABLE" });
  });

  it("includes the stable provider code in MCP structured errors without upstream details", () => {
    const failure = new FxRateUnavailableError(
      "USD",
      "CAD",
      "2026-09-04",
      "BANK_OF_CANADA_FX_HTTP_ERROR",
    );
    Object.assign(failure, {
      message: "upstream-sensitive-payload",
      upstreamStatus: 502,
      upstreamBody: "upstream-sensitive-payload",
    });

    const result = mcpToolFailureResult(failure);
    const expectedEnvelope = {
      status: "failed",
      error: {
        code: "FX_RATE_UNAVAILABLE",
        message: "No permitted FX rate is available. Record an organization rate, provide explicit FX evidence, or review the selected provider.",
        providerFailureCode: "BANK_OF_CANADA_FX_HTTP_ERROR",
      },
    };
    expect(result).toMatchObject({
      isError: true,
      structuredContent: expectedEnvelope,
      content: [{ type: "text", text: JSON.stringify(expectedEnvelope) }],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /upstream-sensitive-payload|upstreamBody|upstreamStatus/,
    );
  });
});
