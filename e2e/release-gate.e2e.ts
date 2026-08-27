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
const expectedEmailWorker = expectedReadiness(
  "E2E_EXPECT_AUTH_EMAIL_WORKER",
  "AUTH_EMAIL_DELIVERY_ENABLED",
);

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
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

async function readSandboxName(page: Page): Promise<string> {
  const accountButton = page.getByRole("button", { name: "Open account menu" });
  await accountButton.click();
  const details = page.getByRole("region", { name: "Account details" });
  await expect(details).toBeVisible();
  const match = (await details.textContent())?.match(/Northstar Demo Sandbox \d{3}/);
  expect(match, "The account menu must expose the leased synthetic organization name").not.toBeNull();
  await accountButton.click();
  return match?.[0] ?? "";
}

async function revokeDemoSession(page: Page): Promise<void> {
  const currentUrl = page.url();
  if (!currentUrl.startsWith("http") || !new URL(currentUrl).pathname.startsWith("/app")) return;
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function bestEffortRevokeDemoSession(page: Page): Promise<void> {
  await revokeDemoSession(page).catch(() => undefined);
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

  const bill = page.getByRole("article").filter({ hasText: input.number });
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
  await expect(live.json()).resolves.toMatchObject({ status: "live" });

  const ready = await request.get("/api/health");
  expect(ready.status()).toBe(200);
  expect(ready.headers()["cache-control"]).toContain("no-store");
  const readiness = await ready.json() as {
    status: string;
    checks: {
      database: string;
      organizationKey: string;
      identityKey: string;
      accountAuthentication: ReadinessState;
      accountSignup: ReadinessState;
      emailWorker: ReadinessState;
    };
  };
  expect(readiness).toMatchObject({
    status: "ready",
    checks: {
      database: "ready",
      organizationKey: "ready",
      identityKey: "ready",
    },
  });
  expect(["ready", "disabled"]).toContain(readiness.checks.accountAuthentication);
  expect(["ready", "disabled"]).toContain(readiness.checks.accountSignup);
  expect(["ready", "disabled"]).toContain(readiness.checks.emailWorker);
  if (expectedAccountAuthentication) {
    expect(readiness.checks.accountAuthentication).toBe(expectedAccountAuthentication);
  }
  if (expectedAccountSignup) expect(readiness.checks.accountSignup).toBe(expectedAccountSignup);
  if (expectedEmailWorker) expect(readiness.checks.emailWorker).toBe(expectedEmailWorker);
  if (readiness.checks.accountAuthentication === "ready") {
    expect(readiness.checks.emailWorker).toBe("ready");
  }
  if (readiness.checks.accountSignup === "ready") {
    expect(readiness.checks.accountAuthentication).toBe("ready");
    expect(readiness.checks.emailWorker).toBe("ready");
  }

  await createAccount.click();
  await expect(page).toHaveURL(/\/signup$/);
  if (readiness.checks.accountAuthentication === "ready" && readiness.checks.accountSignup === "ready") {
    await expect(page.getByRole("heading", { level: 1, name: "Create your workspace" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
    await expect(page.getByLabel("Signup verification").locator("iframe")).toBeVisible({ timeout: 15_000 });
  } else {
    await expect(page.getByRole("heading", { level: 1, name: "Secure account signup is being enabled" })).toBeVisible();
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
  await expect(page.getByRole("heading", { level: 1, name: "Explore Business Finlynq" })).toBeVisible();

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
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.getByRole("region", { name: "Account details" })).toContainText("Public synthetic sandbox");
  await expect(page.getByRole("link", { name: "Create account", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/app");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp$/);
  expect(errors).toEqual([]);
});

test("writable demo can create, post, and void an AR invoice", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto("/login?next=%2Fapp%2Freceivables%2Finvoices");
  const demoHref = await page.getByRole("link", { name: /Open the public demo/ }).getAttribute("href");
  if (!demoHref) throw new Error("Demo login link is missing its target");
  const demoResponse = await page.context().request.get(demoHref, { maxRedirects: 0 });
  expect(demoResponse.status()).toBe(303);
  await page.goto("/app/receivables/invoices");

  await page.getByRole("button", { name: /New invoice/ }).click();
  await page.getByLabel("Invoice number").fill("INV-E2E-VOID");
  await page.getByLabel("Description", { exact: true }).first().fill("Release-gate consulting invoice");
  const line = page.getByRole("group", { name: "Line 1" });
  await line.getByLabel("Description").fill("Implementation services");
  await line.getByLabel("Net amount").fill("100.00");
  await page.getByRole("button", { name: "Save draft" }).click();

  const invoice = page.getByRole("article").filter({ hasText: "INV-E2E-VOID" });
  await expect(invoice).toContainText("DRAFT");
  await invoice.getByRole("button", { name: "Issue", exact: true }).click();
  await expect(invoice).toContainText("POSTED");
  await invoice.getByRole("button", { name: "Void", exact: true }).click();

  const voidHeading = page.getByRole("heading", { name: "Void INV-E2E-VOID" });
  const voidPanel = page.locator("section").filter({ has: voidHeading });
  const submitVoid = page.getByRole("button", { name: "Void and reverse" });
  await expect(submitVoid).toBeEnabled();
  await page.getByLabel("Mandatory reason").fill("Release acceptance reversal");
  await submitVoid.click();
  await expect(invoice).toContainText("VOIDED");
  await expect(page.getByText("Release acceptance reversal", { exact: true })).toBeVisible();
  await expect(voidPanel).toBeHidden();

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  expect(errors).toEqual([]);
});

test("writable demo completes and exactly reverses an AP bill payment lifecycle", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openDemo(page, "/app/payables/bills");

  await createBillDraft(page, {
    number: "BILL-E2E-PAY",
    description: "Release-gate supplier bill",
    amount: "100.00",
  });

  const bill = page.getByRole("article").filter({ hasText: "BILL-E2E-PAY" });
  await bill.getByRole("button", { name: "Issue", exact: true }).click();
  await expect(bill).toContainText("POSTED");
  await expect(bill).toContainText("CAD 100.00");
  await expect(bill).toContainText("OPEN");

  await bill.getByRole("button", { name: "Record payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Record payment" })).toBeVisible();
  await page.getByLabel("Payment number").fill("PAY-E2E-VOID");
  await page.getByLabel("Description", { exact: true }).fill("Release-gate supplier payment");
  await page.getByLabel("Allocation for BILL-E2E-PAY").fill("100.00");
  await expect(page.getByLabel("Total allocated")).toHaveValue("CAD 100.00");
  await page.getByRole("button", { name: "Record and post payment" }).click();

  const payment = page.getByRole("article").filter({ hasText: "PAY-E2E-VOID" });
  await expect(payment).toContainText("POSTED");
  await expect(payment).toContainText("1 open item");
  await expect(bill).toContainText("CAD 0.00");
  await expect(bill).toContainText("SETTLED");
  await expect(bill.getByRole("button", { name: "Reverse payment first" })).toBeDisabled();

  await payment.getByRole("button", { name: "Void", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Void PAY-E2E-VOID" })).toBeVisible();
  await page.getByLabel("Mandatory reason").fill("Release acceptance payment reversal");
  await page.getByRole("button", { name: "Void and reverse" }).click();
  await expect(payment).toContainText("VOIDED");
  await expect(payment).toContainText("Release acceptance payment reversal");
  await expect(bill).toContainText("CAD 100.00");
  await expect(bill).toContainText("OPEN");

  await bill.getByRole("button", { name: "Void", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Void BILL-E2E-PAY" })).toBeVisible();
  await page.getByLabel("Mandatory reason").fill("Release acceptance bill reversal");
  await page.getByRole("button", { name: "Void and reverse" }).click();
  await expect(bill).toContainText("VOIDED");
  await expect(bill).toContainText("Release acceptance bill reversal");

  await revokeDemoSession(page);
  expect(errors).toEqual([]);
});

test("concurrent demo visitors are isolated and a released dirty slot is not reissued", async ({ browser }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Playwright baseURL is required for isolation acceptance");
  const contextA = await browser.newContext({ baseURL });
  const contextB = await browser.newContext({ baseURL });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errorsA = collectBrowserErrors(pageA);
  const errorsB = collectBrowserErrors(pageB);
  let contextC: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  let pageC: Page | null = null;
  let errorsC: string[] = [];

  try {
    await Promise.all([
      openDemo(pageA, "/app/payables/bills"),
      openDemo(pageB, "/app/payables/bills"),
    ]);
    const [sandboxA, sandboxB] = await Promise.all([
      readSandboxName(pageA),
      readSandboxName(pageB),
    ]);
    expect(sandboxA).not.toBe(sandboxB);

    await createBillDraft(pageA, {
      number: "BILL-E2E-ISOLATED",
      description: "Visitor A private draft",
      amount: "17.00",
    });
    await pageA.reload();
    await expect(pageA.getByRole("article").filter({ hasText: "BILL-E2E-ISOLATED" })).toContainText("DRAFT");
    await pageB.reload();
    await expect(pageB.getByRole("article").filter({ hasText: "BILL-E2E-ISOLATED" })).toHaveCount(0);

    await revokeDemoSession(pageA);
    contextC = await browser.newContext({ baseURL });
    pageC = await contextC.newPage();
    errorsC = collectBrowserErrors(pageC);
    await openDemo(pageC, "/app/payables/bills");
    const sandboxC = await readSandboxName(pageC);
    expect(sandboxC).not.toBe(sandboxA);
    expect(sandboxC).not.toBe(sandboxB);
    await expect(pageC.getByRole("article").filter({ hasText: "BILL-E2E-ISOLATED" })).toHaveCount(0);

    // Revoke the two remaining leases in the assertion path. The finally block
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
