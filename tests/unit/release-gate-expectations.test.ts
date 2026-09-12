import { describe, expect, it } from "vitest";
import {
  resolveExpectedSignupMethods,
  type ReadinessState,
} from "../../e2e/release-gate-expectations";

const state = (enabled: boolean): ReadinessState => enabled ? "ready" : "disabled";

describe("release signup gate expectations", () => {
  for (const accountAuthentication of [false, true]) {
    for (const passwordSignup of [false, true]) {
      for (const oidcAuthentication of [false, true]) {
        for (const oidcSignup of [false, true]) {
          it(`resolves account=${accountAuthentication}, password=${passwordSignup}, oidc=${oidcAuthentication}, oidcSignup=${oidcSignup}`, () => {
            expect(resolveExpectedSignupMethods({
              accountAuthentication: state(accountAuthentication),
              passwordSignup: state(passwordSignup),
              oidcAuthentication: state(oidcAuthentication),
              oidcSignup: state(oidcSignup),
            })).toEqual({
              password: accountAuthentication && passwordSignup,
              microsoft: accountAuthentication && oidcAuthentication && oidcSignup,
            });
          });
        }
      }
    }
  }

  it("does not assert an exact method set when an expectation is absent", () => {
    expect(resolveExpectedSignupMethods({
      accountAuthentication: "ready",
      passwordSignup: "disabled",
      oidcAuthentication: null,
      oidcSignup: "ready",
    })).toBeNull();
  });
});
