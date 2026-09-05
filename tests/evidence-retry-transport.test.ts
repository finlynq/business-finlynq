import { describe, expect, it } from "vitest";
import { StorageError, storageRetryAfterSeconds } from "@/modules/document-storage/provider";
import { mcpToolFailureResult } from "@/modules/mcp/tool-types";
import { isRetryableDatabaseError, isRetryableOperationError } from "@/modules/mcp/retryable";

function envelope(error: unknown) {
  return mcpToolFailureResult(error).structuredContent as {
    status: string;
    error: { code: string; message: string; retryAfterSeconds?: number };
  };
}

describe("evidence retry transport", () => {
  it.each(["40001", "40P01", "53300", "55P03", "57014", "57P03"])(
    "classifies transient database code %s as bounded and retryable",
    (code) => {
      const error = Object.assign(new Error("database detail must not leave the server"), { code });
      expect(isRetryableDatabaseError(error)).toBe(true);
      expect(envelope(error)).toEqual({
        status: "failed",
        error: {
          code: "MCP_RETRYABLE",
          message: "A temporary concurrency condition prevented this operation. Retry after 1 second.",
          retryAfterSeconds: 1,
        },
      });
      expect(JSON.stringify(envelope(error))).not.toContain("database detail");
    },
  );

  it("keeps non-retryable database integrity failures distinct", () => {
    const failure = envelope(Object.assign(new Error("unique constraint detail"), { code: "23505" }));
    expect(failure).toEqual({
      status: "failed",
      error: {
        code: "MCP_DATABASE_REJECTED",
        message: "The accounting operation was rejected by an integrity or concurrency control",
      },
    });
    expect(failure.error).not.toHaveProperty("retryAfterSeconds");
  });

  it("reports an audit collision as a distinct non-retryable integrity failure", () => {
    const failure = envelope(Object.assign(new Error("internal audit row details"), { code: "MCP_AUDIT_INTEGRITY" }));
    expect(failure.error).toEqual({
      code: "MCP_AUDIT_INTEGRITY",
      message: "The MCP execution audit record failed its integrity check",
    });
    expect(failure.error).not.toHaveProperty("retryAfterSeconds");
  });

  it("uses only bounded server-selected guidance for storage contention", () => {
    const retryable = new StorageError("STORAGE_RETRYABLE", "provider secret", 7);
    expect(isRetryableOperationError(retryable)).toBe(true);
    expect(storageRetryAfterSeconds(retryable)).toBe(7);
    expect(envelope(retryable).error).toEqual({
      code: "MCP_RETRYABLE",
      message: "A temporary concurrency condition prevented this operation. Retry after 7 seconds.",
      retryAfterSeconds: 7,
    });
    expect(storageRetryAfterSeconds(new StorageError("STORAGE_RETRYABLE", "busy", 300))).toBe(1);
    expect(storageRetryAfterSeconds(new StorageError("STORAGE_THROTTLED", "throttled"))).toBe(1);
    expect(envelope(new StorageError("STORAGE_THROTTLED", "provider detail")).error.code).toBe("MCP_RETRYABLE");
    expect(storageRetryAfterSeconds(new StorageError("STORAGE_MISSING", "missing"))).toBeNull();
  });
});
