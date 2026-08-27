import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { LoginForm } from "@/app/(auth)/_components/login-form.client";
import SignupPage from "@/app/(auth)/signup/page";
import { MarketingFooter } from "@/app/(marketing)/_components/marketing-footer";
import MarketingHomePage from "@/app/(marketing)/page";

const previousLoginGate = process.env.ACCOUNT_LOGIN_ENABLED;
const previousSignupGate = process.env.ACCOUNT_SIGNUP_ENABLED;

afterEach(() => {
  if (previousLoginGate === undefined) delete process.env.ACCOUNT_LOGIN_ENABLED;
  else process.env.ACCOUNT_LOGIN_ENABLED = previousLoginGate;
  if (previousSignupGate === undefined) delete process.env.ACCOUNT_SIGNUP_ENABLED;
  else process.env.ACCOUNT_SIGNUP_ENABLED = previousSignupGate;
});

describe("public account entry points", () => {
  it("advertises account creation across the public website without reading launch gates", () => {
    process.env.ACCOUNT_LOGIN_ENABLED = "false";
    process.env.ACCOUNT_SIGNUP_ENABLED = "false";

    const homeMarkup = renderToStaticMarkup(<MarketingHomePage />);
    const footerMarkup = renderToStaticMarkup(<MarketingFooter />);
    const headerSource = readFileSync(join(
      process.cwd(),
      "src",
      "app",
      "(marketing)",
      "_components",
      "marketing-header.client.tsx",
    ), "utf8");

    expect(homeMarkup.match(/href="\/signup"/g)).toHaveLength(4);
    expect(footerMarkup).toContain('href="/signup"');
    expect(headerSource.match(/href="\/signup"/g)).toHaveLength(2);
  });

  it("keeps the signup link visible when real-account login is disabled", () => {
    const markup = renderToStaticMarkup(
      <LoginForm next="/app" accountLoginEnabled={false} />,
    );

    expect(markup).toContain('href="/signup"');
    expect(markup).toContain("Create a new business account");
    expect(markup).toContain("Open the public demo");
    expect(markup).not.toContain("<form");
  });

  it("offers account creation from the authenticated demo menu", () => {
    const accountMenuSource = readFileSync(join(
      process.cwd(),
      "src",
      "app",
      "_components",
      "account-menu.client.tsx",
    ), "utf8");
    const overviewSource = readFileSync(join(
      process.cwd(),
      "src",
      "app",
      "(workspace)",
      "app",
      "page.tsx",
    ), "utf8");

    expect(accountMenuSource).toContain('principal.sessionMode === "demo" && <Link');
    expect(accountMenuSource).toContain('href="/signup"');
    expect(overviewSource).toContain('href="/signup"');
    expect(overviewSource).toContain("Create a permanent business account");
  });

  it("renders a transparent fail-closed signup page without an account form", () => {
    process.env.ACCOUNT_LOGIN_ENABLED = "false";
    process.env.ACCOUNT_SIGNUP_ENABLED = "false";

    const markup = renderToStaticMarkup(<SignupPage />);

    expect(markup).toContain("Secure account signup is being enabled");
    expect(markup).toContain("This page will not create or retain an account request yet.");
    expect(markup).toContain("Open the live demo");
    expect(markup).toContain("Sign in to an existing account");
    expect(markup).not.toContain("<form");
  });
});
