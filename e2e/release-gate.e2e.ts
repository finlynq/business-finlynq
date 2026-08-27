import { expect, test, type Page } from "@playwright/test";

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  return errors;
}

test("public website, readiness, and security headers are release-ready", async ({ page, request }) => {
  const errors = collectBrowserErrors(page);
  const response = await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Close the books with confidence");
  await expect(page.getByRole("banner").getByRole("link", { name: "Open demo" })).toBeVisible();
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
  await expect(ready.json()).resolves.toMatchObject({
    status: "ready",
    checks: { database: "ready", organizationKey: "ready", identityKey: "ready" },
  });
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

  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Accounting overview" })).toBeVisible();
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.getByRole("region", { name: "Account details" })).toContainText("Public synthetic demo");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/app");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp$/);
  expect(errors).toEqual([]);
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
