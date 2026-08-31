import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("redacted application route failure logging", () => {
  it("keeps console.error behind the single reviewed redaction boundary", () => {
    const appRoot = join(process.cwd(), "src/app");
    const sinks = sourceFiles(appRoot)
      .filter((path) => readFileSync(path, "utf8").includes("console.error"))
      .map((path) => relative(appRoot, path).replaceAll("\\", "/"));

    expect(sinks).toEqual(["api/_shared/route-failure-log.ts"]);
  });

  it("requires every route call to provide a bounded literal operation, request ID, and error", () => {
    const appRoot = join(process.cwd(), "src/app");
    const callPattern = /logRouteFailure\(\s*"[a-z-]+"\s*,\s*requestId\s*,\s*error\s*\)/g;

    for (const path of sourceFiles(appRoot)) {
      const source = readFileSync(path, "utf8");
      if (!source.includes("logRouteFailure(") || path.endsWith("route-failure-log.ts")) continue;
      expect(source.match(callPattern)?.length, relative(appRoot, path)).toBe(
        source.match(/logRouteFailure\(/g)?.length,
      );
    }
  });

  it("never emits a custom error name, message, stack, or invalid request ID", () => {
    const error = new Error("email=user@example.com token=secret otp=123456");
    error.name = "UserEmailTokenFailure";
    error.stack = "UserEmailTokenFailure: secret\n    at sensitive/body.ts:1:1";
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      logRouteFailure("account-login", "user@example.com\nsecret", error);

      expect(logging).toHaveBeenCalledOnce();
      expect(logging).toHaveBeenCalledWith("Business Finlynq route failure", {
        operation: "account-login",
        requestId: "invalid-request-id",
        errorType: "Error",
      });
      const serialized = JSON.stringify(logging.mock.calls);
      expect(serialized).not.toMatch(/user@example\.com|secret|123456|UserEmailTokenFailure|sensitive\/body/);
    } finally {
      logging.mockRestore();
    }
  });

  it.each([
    [new TypeError("private"), "TypeError"],
    [new RangeError("private"), "RangeError"],
    [new SyntaxError("private"), "SyntaxError"],
    [{ message: "private", stack: "private" }, "Unknown"],
  ])("maps failures only into the bounded category set", (error, errorType) => {
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      logRouteFailure("health-readiness", "11111111-1111-4111-8111-111111111111", error);
      expect(logging.mock.calls[0]?.[1]).toEqual({
        operation: "health-readiness",
        requestId: "11111111-1111-4111-8111-111111111111",
        errorType,
      });
    } finally {
      logging.mockRestore();
    }
  });
});
