import { expect, test, type Page } from "@playwright/test";
import { installReleaseAcceptanceRoute, releaseGet } from "./release-acceptance";

test.beforeEach(async ({ context }) => { await installReleaseAcceptanceRoute(context); });
test.afterEach(async ({ page }) => { await bestEffortRevokeDemoSession(page); });

async function openDemo(page: Page, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  const href = await page.getByRole("link", { name: /Open the public demo/ }).getAttribute("href");
  if (!href) throw new Error("Demo entry unavailable for compact UI acceptance");
  const login = await releaseGet(page.request, href);
  expect(login.status()).toBe(303);
  expect(new URL(login.headers().location).pathname).toBe(next);
  await page.goto(next);
  await expect(page).toHaveURL(new RegExp(`${next.replaceAll("/", "\\/")}$`));
  await expect(page.getByRole("main")).toBeVisible();
}

async function bestEffortRevokeDemoSession(page: Page) {
  const currentUrl = page.url();
  if (!currentUrl.startsWith("http") || !new URL(currentUrl).pathname.startsWith("/app")) return;
  await page.getByRole("button", { name: "Open account and security menu" }).click({ timeout: 1_000 }).catch(() => undefined);
  await page.getByRole("button", { name: "Sign out" }).click({ timeout: 1_000 }).catch(() => undefined);
  await page.waitForURL(/\/$/, { timeout: 2_000 }).catch(() => undefined);
}

async function expectNoPageOverflow(page: Page) {
  const width = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(width.content, `${page.url()} should scroll tables locally, not the page`).toBeLessThanOrEqual(width.viewport + 1);
}

test("public and authentication pages fit narrow and intermediate viewports", async ({ page }) => {
  test.setTimeout(180_000);
  for (const width of [320, 900]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ["/", "/accept-invitation", "/complete-signup", "/docs/remote-mcp", "/forgot-password", "/login", "/privacy", "/reset-password", "/security", "/signup", "/terms"]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoPageOverflow(page);
    }
  }
});

test("workspace pages and major route views keep table overflow local", async ({ page }) => {
  test.setTimeout(240_000);
  await openDemo(page, "/app");
  const routes = [
    "/app", "/app/account", "/app/assets", "/app/automation", "/app/banking", "/app/banking?view=reconciliation", "/app/banking?view=rules",
    "/app/controls/period-close", "/app/entities", "/app/journals", "/app/journals/new", "/app/parties", "/app/payables/bills", "/app/receivables/invoices",
    "/app/reports", "/app/reports/account-inquiry", "/app/reports/balance-sheet", "/app/reports/profit-and-loss", "/app/reports/trial-balance",
    "/app/settings", "/app/settings/accounting", "/app/settings/documents", "/app/settings/mcp", "/app/tax", "/app/tax?view=history", "/app/tax?view=templates", "/app/tax?view=transactions", "/app/tax?status=review",
    "/app/security/recovery/approve",
  ];
  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoPageOverflow(page);
    }
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/app/journals");
  const detail = page.getByRole("link", { name: "View journal entry", exact: true }).first();
  await detail.click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Journal");
  await expectNoPageOverflow(page);
});

test("mobile chrome preserves scope, touch targets and navigation focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page, "/app");
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toHaveCount(1);
  const chrome = page.locator(".utility-bar");
  await expect(chrome.getByLabel("Working entity", { exact: true })).toBeVisible();
  await expect(chrome.locator(".entity-context-detail")).toBeVisible();
  const bounds = await chrome.boundingBox();
  expect(bounds!.height).toBeLessThan(120);
  const menu = page.getByRole("button", { name: "Open navigation", exact: true });
  expect((await menu.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await menu.click();
  await expect(page.getByRole("dialog", { name: "Navigation", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
});

test("disclosures retain edits, reveal invalid fields, and survive accounting tabs", async ({ page }) => {
  await openDemo(page, "/app/settings/accounting");
  const disclosure = page.locator("details").filter({ has: page.locator("summary", { hasText: /^Add a legal entity$/ }) });
  const summary = disclosure.locator(":scope > summary");
  await summary.click();
  const name = disclosure.getByLabel("Legal name", { exact: true });
  await name.fill("Unsaved compactness test");
  await summary.click();
  await summary.click();
  await expect(name).toHaveValue("Unsaved compactness test");
  const tabs = page.getByRole("tablist", { name: "Accounting configuration sections" });
  await tabs.getByRole("tab", { name: "Currencies & rates" }).click();
  await tabs.getByRole("tab", { name: "Entities & ledgers" }).click();
  await expect(name).toHaveValue("Unsaved compactness test");
  await name.fill("");
  await summary.click();
  // Native validation only: no submit and no accounting request is made.
  await name.evaluate((input: HTMLInputElement) => input.reportValidity());
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(name).toBeFocused();
  await expect(page.getByLabel(/Audit reason/).first()).toBeVisible();
});

test("report range switching preserves both period and date inputs", async ({ page }) => {
  await openDemo(page, "/app/reports/trial-balance");
  const basis = page.getByLabel("Range basis", { exact: true });
  await basis.selectOption("date");
  const from = page.getByLabel("From date", { exact: true });
  await from.fill("2026-01-02");
  await basis.selectOption("period");
  await expect(from).toBeHidden();
  await expect(page.getByLabel("From period", { exact: true })).toBeVisible();
  await basis.selectOption("date");
  await expect(from).toHaveValue("2026-01-02");
  await expect(page.getByLabel("From period", { exact: true })).toBeHidden();
});

test("journal evidence stays available in a full-width expanded row", async ({ page }) => {
  await openDemo(page, "/app/journals");
  const trigger = page.getByRole("button", { name: /Show account postings for/ }).first();
  const id = await trigger.getAttribute("aria-controls");
  if (!id) throw new Error("Missing evidence row association");
  const row = page.locator(`[id="${id}"]`);
  await expect(row).toBeHidden();
  await trigger.click();
  await expect(row).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(row.getByText(/Ending balance/).first()).toBeVisible();
  await trigger.click();
  await expect(row).toBeHidden();
});
