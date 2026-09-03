import { expect, test, type Page } from "@playwright/test";

type ReadinessState = "ready" | "disabled";

function expectedReadiness(...environmentNames: string[]): ReadinessState | null {
  const configured = environmentNames
    .map((name) => process.env[name])
    .find((value) => value !== undefined);
  if (configured === undefined) return null;
  if (configured === "true") return "ready";
  if (configured === "false") return "disabled";
  throw new Error(`${environmentNames[0]} must be true or false when configured`);
}

const expectedAccountAuthentication = expectedReadiness(
  "E2E_EXPECT_ACCOUNT_LOGIN_ENABLED",
  "ACCOUNT_LOGIN_ENABLED",
);
const expectedAccountSignup = expectedReadiness(
  "E2E_EXPECT_ACCOUNT_SIGNUP_ENABLED",
  "ACCOUNT_SIGNUP_ENABLED",
);

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      errors.push(`response: ${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  return errors;
}

async function openDemo(page: Page, destination: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(destination)}`);
  const demoHref = await page.getByRole("link", { name: /Open the public demo/ }).getAttribute("href");
  if (!demoHref) throw new Error("Demo login link is missing its target");

  const response = await page.context().request.get(demoHref, { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(new URL(response.headers().location).pathname).toBe(destination);
  await page.goto(destination);
  await expect(page).toHaveURL(new RegExp(`${destination.replaceAll("/", "\\/")}$`));
}

async function readDemoOrganizationName(page: Page): Promise<string> {
  const accountButton = page.getByRole("button", { name: "Open account and security menu" });
  await accountButton.click();
  const details = page.getByRole("dialog");
  await expect(details).toBeVisible();
  const match = (await details.textContent())?.match(/Northstar Demo Group/);
  expect(match, "The account menu must expose the shared demo organization name").not.toBeNull();
  await page.getByRole("button", { name: "Close account menu" }).click();
  return match?.[0] ?? "";
}

async function revokeDemoSession(page: Page): Promise<void> {
  const currentUrl = page.url();
  if (!currentUrl.startsWith("http") || !new URL(currentUrl).pathname.startsWith("/app")) return;
  await page.getByRole("button", { name: "Open account and security menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function bestEffortRevokeDemoSession(page: Page): Promise<void> {
  const currentUrl = page.url();
  if (!currentUrl.startsWith("http") || !new URL(currentUrl).pathname.startsWith("/app")) return;
  await page.getByRole("button", { name: "Open account and security menu" }).click({ timeout: 1_000 }).catch(() => undefined);
  await page.getByRole("button", { name: "Sign out" }).click({ timeout: 1_000 }).catch(() => undefined);
  await page.waitForURL(/\/$/, { timeout: 2_000 }).catch(() => undefined);
}

async function createBillDraft(
  page: Page,
  input: Readonly<{ number: string; description: string; amount: string }>,
): Promise<void> {
  await page.getByRole("button", { name: /New bill/ }).click();
  await page.getByLabel("Bill number").fill(input.number);
  await page.getByLabel("Description", { exact: true }).first().fill(input.description);
  const line = page.getByRole("group", { name: "Line 1" });
  await line.getByLabel("Description").fill(`${input.description} line`);
  await line.getByLabel("Net amount").fill(input.amount);
  await line.getByLabel("Tax treatment").selectOption("OUT_OF_SCOPE");
  await page.getByRole("button", { name: "Save draft" }).click();

  const bill = page.getByRole("row").filter({ hasText: input.number });
  await expect(bill).toContainText("DRAFT");
}

test("public website, readiness, and security headers are release-ready", async ({ page, request }) => {
  const errors = collectBrowserErrors(page);
  const response = await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Close the books with confidence");
  await expect(page.getByRole("banner").getByRole("link", { name: "Open demo" })).toBeVisible();
  const createAccount = page.getByRole("banner").getByRole("link", { name: "Create account" });
  await expect(createAccount).toBeVisible();
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");

  const live = await request.get("/api/live");
  expect(live.status()).toBe(200);
  expect(live.headers()["cache-control"]).toContain("no-store");
  await expect(live.json()).resolves.toEqual({ status: "live" });

  const ready = await request.get("/api/health");
  expect(ready.status()).toBe(200);
  expect(ready.headers()["cache-control"]).toContain("no-store");
  await expect(ready.json()).resolves.toEqual({ status: "ready" });

  await createAccount.click();
  await expect(page).toHaveURL(/\/signup$/);
  const enabledSignup = page.getByRole("heading", { level: 1, name: "Create your workspace" });
  const disabledSignup = page.getByRole("heading", {
    level: 1,
    name: "Secure account signup is being enabled",
  });
  await expect(enabledSignup.or(disabledSignup)).toBeVisible();
  const signupIsEnabled = await enabledSignup.isVisible();
  if (expectedAccountAuthentication === "disabled" || expectedAccountSignup === "disabled") {
    expect(signupIsEnabled).toBe(false);
  } else if (expectedAccountAuthentication === "ready" && expectedAccountSignup === "ready") {
    expect(signupIsEnabled).toBe(true);
  }
  if (signupIsEnabled) {
    await expect(page.getByRole("heading", { level: 1, name: "Create your workspace" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
    const signupVerification = page.getByLabel("Signup verification");
    await expect(signupVerification).toBeVisible();
    // Turnstile's iframe can live behind Cloudflare-controlled implementation
    // details and managed challenges may solve without displaying it. The
    // response input is created only after the public widget API renders.
    await expect(signupVerification.locator('input[name="cf-turnstile-response"]')).toHaveCount(1, {
      timeout: 15_000,
    });
  } else {
    await expect(disabledSignup).toBeVisible();
    await expect(page.getByRole("link", { name: /Open the live demo/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in to an existing account" })).toBeVisible();
    await expect(page.locator("form")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test("demo session protects workspace routes and is revoked by sign-out", async ({ page }) => {
  const errors = collectBrowserErrors(page);

  await page.goto("/app/journals");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fjournals$/);
  if (expectedAccountAuthentication === "ready") {
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  } else if (expectedAccountAuthentication === "disabled") {
    await expect(page.getByRole("heading", { level: 1, name: "Explore Business Finlynq" })).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { level: 1, name: /Welcome back|Explore Business Finlynq/ })).toBeVisible();
  }

  const demoLink = page.getByRole("link", { name: /Open the public demo/ });
  const demoHref = await demoLink.getAttribute("href");
  expect(demoHref).toBe("/try-demo?next=%2Fapp%2Fjournals");
  if (!demoHref) throw new Error("Demo login link is missing its target");

  // Exercise the route through the browser context's shared cookie jar. A normal
  // document click can be preceded by browser speculation, which this stateful
  // endpoint deliberately answers with 204 and must never treat as a login.
  const demoResponse = await page.context().request.get(demoHref, { maxRedirects: 0 });
  expect(demoResponse.status()).toBe(303);
  expect(new URL(demoResponse.headers().location).pathname).toBe("/app/journals");
  await page.goto("/app/journals");
  await expect(page).toHaveURL(/\/app\/journals$/);
  await expect(page.getByRole("heading", { level: 1, name: "Journals" })).toBeVisible();

  // Keep the banking workspace in the production release gate. Its initial
  // server render loads connection, reconciliation, and rule data together,
  // so this catches query-shape failures even when live provider calls are
  // deliberately disabled.
  await page.goto("/app/banking");
  await expect(page.getByRole("heading", { level: 1, name: "Banking" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Banking views" })).toBeVisible();
  await page.goto("/app/journals");

  const seededDraft = page.getByRole("row").filter({ hasText: "Synthetic Canadian software accrual" });
  await expect(seededDraft).toContainText("DRAFT");
  await seededDraft.getByText("Post draft", { exact: true }).click();
  await seededDraft.getByRole("checkbox").check();
  await seededDraft.getByRole("button", { name: "Confirm posting" }).click();
  await expect(seededDraft).toContainText("POSTED");
  await expect(seededDraft.getByText("Reverse", { exact: true })).toBeVisible();

  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Accounting overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create a permanent business account" })).toBeVisible();
  await page.getByRole("button", { name: "Open account and security menu" }).click();
  await expect(page.getByRole("dialog")).toContainText("Shared public demo");
  await expect(page.getByRole("link", { name: "Create account", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/app");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp$/);
  expect(errors).toEqual([]);
});

test("writable demo can create, post, and void an AR invoice", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const invoiceNumber = `INV-E2E-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  await page.goto("/login?next=%2Fapp%2Freceivables%2Finvoices");
  const demoHref = await page.getByRole("link", { name: /Open the public demo/ }).getAttribute("href");
  if (!demoHref) throw new Error("Demo login link is missing its target");
  const demoResponse = await page.context().request.get(demoHref, { maxRedirects: 0 });
  expect(demoResponse.status()).toBe(303);
  await page.goto("/app/receivables/invoices");

  await page.getByRole("button", { name: /New invoice/ }).click();
  await page.getByLabel("Invoice number").fill(invoiceNumber);
  await page.getByLabel("Description", { exact: true }).first().fill("Release-gate consulting invoice");
  const line = page.getByRole("group", { name: "Line 1" });
  await line.getByLabel("Description").fill("Implementation services");
  await line.getByLabel("Net amount").fill("100.00");
  await page.getByRole("button", { name: "Save draft" }).click();

  const invoice = page.getByRole("row").filter({ hasText: invoiceNumber });
  await expect(invoice).toContainText("DRAFT");
  await invoice.getByRole("button", { name: "Issue", exact: true }).click();
  await expect(invoice).toContainText("POSTED");
  await invoice.getByRole("button", { name: "Void", exact: true }).click();

  const voidHeading = page.getByRole("heading", { name: `Void ${invoiceNumber}` });
  const voidPanel = page.locator("section").filter({ has: voidHeading });
  const submitVoid = page.getByRole("button", { name: "Void and reverse" });
  await expect(submitVoid).toBeEnabled();
  await page.getByLabel("Mandatory reason").fill("Release acceptance reversal");
  await submitVoid.click();
  await expect(invoice).toContainText("VOIDED");
  await expect(page.getByText("Release acceptance reversal", { exact: true })).toBeVisible();
  await expect(voidPanel).toBeHidden();

  await page.getByRole("button", { name: "Open account and security menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  expect(errors).toEqual([]);
});

test("writable demo completes and exactly reverses an AP bill payment lifecycle", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const billNumber = `BILL-E2E-PAY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const paymentNumber = `PAY-E2E-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  await openDemo(page, "/app/payables/bills");

  await createBillDraft(page, {
    number: billNumber,
    description: "Release-gate supplier bill",
    amount: "100.00",
  });

  const bill = page.getByRole("row").filter({ hasText: billNumber });
  await bill.getByRole("button", { name: "Issue", exact: true }).click();
  await expect(bill).toContainText("POSTED");
  await expect(bill).toContainText("CAD 100.00");
  await expect(bill).toContainText("OPEN");

  await bill.getByRole("button", { name: "Record payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Record payment" })).toBeVisible();
  await page.getByLabel("Payment number").fill(paymentNumber);
  await page.getByLabel("Description", { exact: true }).fill("Release-gate supplier payment");
  await page.getByLabel(`Allocation for ${billNumber}`).fill("100.00");
  await expect(page.getByLabel("Total allocated")).toHaveValue("CAD 100.00");
  await page.getByRole("button", { name: "Record and post payment" }).click();

  const payment = page.getByRole("row").filter({ hasText: paymentNumber });
  await expect(payment).toContainText("POSTED");
  await expect(payment).toContainText("1 open item");
  await expect(bill).toContainText("CAD 0.00");
  await expect(bill).toContainText("SETTLED");
  await expect(bill.getByRole("button", { name: "Reverse payment first" })).toBeDisabled();

  await payment.getByRole("button", { name: "Void", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Void ${paymentNumber}` })).toBeVisible();
  await page.getByLabel("Mandatory reason").fill("Release acceptance payment reversal");
  await page.getByRole("button", { name: "Void and reverse" }).click();
  await expect(payment).toContainText("VOIDED");
  await expect(payment).toContainText("Release acceptance payment reversal");
  await expect(bill).toContainText("CAD 100.00");
  await expect(bill).toContainText("OPEN");

  await bill.getByRole("button", { name: "Void", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Void ${billNumber}` })).toBeVisible();
  await page.getByLabel("Mandatory reason").fill("Release acceptance bill reversal");
  await page.getByRole("button", { name: "Void and reverse" }).click();
  await expect(bill).toContainText("VOIDED");
  await expect(bill).toContainText("Release acceptance bill reversal");

  await revokeDemoSession(page);
  expect(errors).toEqual([]);
});

test("concurrent demo visitors share one company and see each other's changes", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Playwright baseURL is required for shared-demo acceptance");
  const contextA = await browser.newContext({ baseURL });
  const contextB = await browser.newContext({ baseURL });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errorsA = collectBrowserErrors(pageA);
  const errorsB = collectBrowserErrors(pageB);
  let contextC: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  let pageC: Page | null = null;
  let errorsC: string[] = [];
  const billNumber = `BILL-E2E-SHARED-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  try {
    await Promise.all([
      openDemo(pageA, "/app/payables/bills"),
      openDemo(pageB, "/app/payables/bills"),
    ]);
    const [organizationA, organizationB] = await Promise.all([
      readDemoOrganizationName(pageA),
      readDemoOrganizationName(pageB),
    ]);
    expect(organizationA).toBe("Northstar Demo Group");
    expect(organizationB).toBe(organizationA);

    await createBillDraft(pageA, {
      number: billNumber,
      description: "Visitor A shared draft",
      amount: "17.00",
    });
    await pageA.reload();
    await expect(pageA.getByRole("row").filter({ hasText: billNumber })).toContainText("DRAFT");
    await pageB.reload();
    await expect(pageB.getByRole("row").filter({ hasText: billNumber })).toContainText("DRAFT");

    await revokeDemoSession(pageA);
    contextC = await browser.newContext({ baseURL });
    pageC = await contextC.newPage();
    errorsC = collectBrowserErrors(pageC);
    await openDemo(pageC, "/app/payables/bills");
    const organizationC = await readDemoOrganizationName(pageC);
    expect(organizationC).toBe(organizationA);
    await expect(pageC.getByRole("row").filter({ hasText: billNumber })).toContainText("DRAFT");

    // Revoke the two remaining sessions in the assertion path. The finally block
    // remains only a safety net for an earlier failure.
    await revokeDemoSession(pageB);
    await revokeDemoSession(pageC);

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
    expect(errorsC).toEqual([]);
  } finally {
    await Promise.all([
      bestEffortRevokeDemoSession(pageA),
      bestEffortRevokeDemoSession(pageB),
      pageC ? bestEffortRevokeDemoSession(pageC) : Promise.resolve(),
    ]);
    await Promise.all([
      contextA.close(),
      contextB.close(),
      contextC?.close() ?? Promise.resolve(),
    ]);
  }
});

test("mobile navigation traps focus and restores it when dismissed", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Open website navigation" });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Website navigation" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mobile website" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Website navigation" })).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(errors).toEqual([]);
});
