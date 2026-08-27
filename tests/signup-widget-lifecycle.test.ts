import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const signupForm = readFileSync(
  join(process.cwd(), "src/app/(auth)/_components/signup-form.client.tsx"),
  "utf8",
);

describe("signup challenge lifecycle", () => {
  it("renders Turnstile after every client-route mount and surfaces provider load failure", () => {
    expect(signupForm).toContain("onReady={renderChallenge}");
    expect(signupForm).not.toContain("onLoad={renderChallenge}");
    expect(signupForm).toContain("Signup verification could not load");
  });
});
