import { describe, expect, it } from "vitest";
import { signupRateLimitMessage } from "@/modules/identity/signup-public-response";

describe("public signup rate-limit guidance", () => {
  it("turns Retry-After into generic, non-enumerating guidance", () => {
    const message = signupRateLimitMessage("91");
    expect(message).toBe(
      "Too many account signup attempts were received. Please wait about 2 minutes before trying again.",
    );
    expect(message).not.toMatch(/email|exists|account found|organization found/i);
  });

  it("fails safely when Retry-After is missing or malformed", () => {
    expect(signupRateLimitMessage(null)).toBe(
      "Too many account signup attempts were received. Please wait before trying again.",
    );
    expect(signupRateLimitMessage("tomorrow")).toBe(
      "Too many account signup attempts were received. Please wait before trying again.",
    );
  });
});
