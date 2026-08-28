import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const signupForm = readFileSync(
  join(process.cwd(), "src/app/(auth)/_components/signup-form.client.tsx"),
  "utf8",
);

describe("signup form validation", () => {
  it("keeps native browser validation enabled before requesting signup", () => {
    expect(signupForm).toContain('<form className={styles.form} onSubmit={submit}>');
    expect(signupForm).not.toContain("noValidate");
    expect(signupForm).toContain('name="organizationName" autoComplete="organization" required minLength={2}');
    expect(signupForm).toContain('name="termsAccepted" type="checkbox" required');
  });
});
