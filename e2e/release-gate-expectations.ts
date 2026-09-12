export type ReadinessState = "ready" | "disabled";

type SignupGateExpectations = Readonly<{
  accountAuthentication: ReadinessState | null;
  passwordSignup: ReadinessState | null;
  oidcAuthentication: ReadinessState | null;
  oidcSignup: ReadinessState | null;
}>;

export type ExpectedSignupMethods = Readonly<{
  password: boolean;
  microsoft: boolean;
}>;

export function resolveExpectedSignupMethods(
  expectations: SignupGateExpectations,
): ExpectedSignupMethods | null {
  if (Object.values(expectations).some((state) => state === null)) return null;

  const accountAuthenticationEnabled = expectations.accountAuthentication === "ready";
  return {
    password: accountAuthenticationEnabled && expectations.passwordSignup === "ready",
    microsoft: accountAuthenticationEnabled &&
      expectations.oidcAuthentication === "ready" &&
      expectations.oidcSignup === "ready",
  };
}
