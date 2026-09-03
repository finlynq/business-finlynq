import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { DemoSessionLeaseLostError } from "@/db/errors";

const previousSessionCookieName = process.env.SESSION_COOKIE_NAME;

beforeEach(() => {
  process.env.SESSION_COOKIE_NAME = "test_business_session";
});

afterAll(() => {
  if (previousSessionCookieName === undefined) delete process.env.SESSION_COOKIE_NAME;
  else process.env.SESSION_COOKIE_NAME = previousSessionCookieName;
});

describe("demo session API error response", () => {
  it("returns a no-store 401 and clears only the authentication session cookie", async () => {
    const response = demoSessionLeaseLostResponse(new DemoSessionLeaseLostError());

    expect(response).not.toBeNull();
    expect(response?.status).toBe(401);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response?.json()).toEqual({
      error: "The demo session expired. Open the demo again to continue.",
    });
    const setCookie = response?.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("test_business_session=");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("does not translate unrelated failures", () => {
    expect(demoSessionLeaseLostResponse(new Error("Demo session claim is not live"))).toBeNull();
    expect(demoSessionLeaseLostResponse({ code: "28000", message: "Demo session claim is not live" })).toBeNull();
  });

  it("maps the typed error in each shared mutation boundary before logging or returning a conflict", () => {
    const sharedBoundaryFiles = [
      "src/app/api/_shared/subledger-mutation-route.ts",
      "src/app/api/_shared/organization-administration-route.ts",
    ];
    const factoryRouteFiles = [
      "src/app/api/ledger/journals/route.ts",
      "src/app/api/ledger/journals/[journalId]/post/route.ts",
      "src/app/api/ledger/journals/[journalId]/reverse/route.ts",
      "src/app/api/ledger/periods/[periodId]/transition/route.ts",
      "src/app/api/parties/route.ts",
      "src/app/api/parties/[partyId]/accounts/route.ts",
    ];

    for (const file of sharedBoundaryFiles) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const mapping = source.indexOf("demoSessionLeaseLostResponse(error)");
      const logging = source.indexOf("logRouteFailure", mapping);
      expect(mapping, file).toBeGreaterThan(-1);
      expect(logging, file).toBeGreaterThan(mapping);
    }

    for (const file of factoryRouteFiles) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, file).toContain("createMutationRoute");
      expect(source, file).not.toContain("console.error");
    }
  });
});
