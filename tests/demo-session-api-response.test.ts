import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { DemoSessionLeaseLostError } from "@/db/errors";

const previousSessionCookieName = process.env.SESSION_COOKIE_NAME;
const previousDemoClaimCookieName = process.env.DEMO_CLAIM_COOKIE_NAME;

beforeEach(() => {
  process.env.SESSION_COOKIE_NAME = "test_business_session";
  process.env.DEMO_CLAIM_COOKIE_NAME = "test_demo_claim";
});

afterAll(() => {
  if (previousSessionCookieName === undefined) delete process.env.SESSION_COOKIE_NAME;
  else process.env.SESSION_COOKIE_NAME = previousSessionCookieName;
  if (previousDemoClaimCookieName === undefined) delete process.env.DEMO_CLAIM_COOKIE_NAME;
  else process.env.DEMO_CLAIM_COOKIE_NAME = previousDemoClaimCookieName;
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
    expect(setCookie).not.toContain("test_demo_claim=");
  });

  it("does not translate unrelated failures", () => {
    expect(demoSessionLeaseLostResponse(new Error("Demo session claim is not live"))).toBeNull();
    expect(demoSessionLeaseLostResponse({ code: "28000", message: "Demo session claim is not live" })).toBeNull();
  });

  it("maps the typed error before every tenant mutation boundary logs or returns a conflict", () => {
    const boundaryFiles = [
      "src/app/api/_shared/subledger-mutation-route.ts",
      "src/app/api/_shared/organization-administration-route.ts",
      "src/app/api/ledger/journals/route.ts",
      "src/app/api/ledger/journals/[journalId]/post/route.ts",
      "src/app/api/ledger/journals/[journalId]/reverse/route.ts",
      "src/app/api/ledger/periods/[periodId]/transition/route.ts",
      "src/app/api/parties/route.ts",
    ];

    for (const file of boundaryFiles) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const mapping = source.indexOf("demoSessionLeaseLostResponse(error)");
      const logging = source.indexOf("console.error", mapping);
      expect(mapping, file).toBeGreaterThan(-1);
      expect(logging, file).toBeGreaterThan(mapping);
    }
  });
});
