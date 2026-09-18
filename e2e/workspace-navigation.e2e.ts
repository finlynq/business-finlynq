import { expect, test, type Page } from "@playwright/test";
import { installReleaseAcceptanceRoute } from "./release-acceptance";

test.beforeEach(async ({ context }) => {
  await installReleaseAcceptanceRoute(context);
});

async function openDemo(page: Page, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  const href = await page.getByRole("link", { name: /Open the public demo/ }).getAttribute("href");
  if (!href) throw new Error("The demo entry link was unavailable.");
  await page.goto(href);
  await expect(page).toHaveURL(new RegExp(`${next.replaceAll("/", "\\/")}$`));
}

test("workspace navigation stays clear, accessible and state-preserving", async ({ page }) => {
  await openDemo(page, "/app/reports");
  await expect(page.getByRole("heading", { level: 1, name: "Reports", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open balance sheet" }).click();
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  await expect(sidebar.getByRole("link", { name: "Reports", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Accounting reports" }).getByRole("link", { name: "Balance sheet", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto("/app/settings/documents");
  await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(sidebar.getByRole("link", { name: "Documents", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main")).toHaveCount(1);

  await page.goto("/app/settings/accounting#currencies");
  const tabs = page.getByRole("tablist", { name: "Accounting configuration sections" });
  const rates = tabs.getByRole("tab", { name: "Currencies & rates" });
  await expect(rates).toHaveAttribute("aria-selected", "true");
  await rates.focus();
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: "Tax registrations" })).toBeFocused();
  await expect(page).toHaveURL(/#tax-packs$/);
  await page.keyboard.press("Home");
  await expect(tabs.getByRole("tab", { name: "Entities & ledgers" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/tax");
  const taxTabs = page.getByRole("tablist", { name: "Tax preparation sections" });
  await page.getByLabel("Period start", { exact: true }).fill("2026-01-01");
  await taxTabs.getByRole("tab", { name: "Account mappings" }).click();
  await page.getByRole("searchbox", { name: "Find a template field" }).fill("revenue");
  await taxTabs.getByRole("tab", { name: "Prepare or reconcile" }).click();
  await expect(page.getByLabel("Period start", { exact: true })).toHaveValue("2026-01-01");
  await taxTabs.getByRole("tab", { name: "Account mappings" }).click();
  await expect(page.getByRole("searchbox", { name: "Find a template field" })).toHaveValue("revenue");
  const width = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Navigation", exact: true }).getByRole("link", { name: "Reports", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
});
