import { expect, test } from "@playwright/test";

test("period controls creates a monthly calendar and refreshes the selectable periods", async ({ page }, testInfo) => {
  const destination = "/app/controls/period-close";
  await page.goto(`/login?next=${encodeURIComponent(destination)}`);
  const demoHref = await page.getByRole("link", { name: /Open the public demo/ }).getAttribute("href");
  if (!demoHref) throw new Error("Demo login link is missing");
  const login = await page.context().request.get(demoHref, { maxRedirects: 0 });
  expect(login.status()).toBe(303);
  await page.goto(destination);
  try {
    const form = page.getByRole("form", { name: "Add fiscal periods" });
    await expect(form).toBeVisible();
    await form.getByLabel("Fiscal year", { exact: true }).fill("2098");
    await form.getByLabel("Creation reason").fill("Verify monthly fiscal calendar creation in release acceptance");
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/ledger/periods") && response.request().method() === "POST");
    await form.getByRole("button", { name: "Add periods", exact: true }).click();
    const response = await responsePromise;
    expect([200, 201]).toContain(response.status());
    const result = await response.json();
    expect(result.accepted).toBe(true);
    expect(result.periods).toHaveLength(12);
    expect(result.summary.created + result.summary.existing).toBe(12);
    await expect(form.getByRole("status")).toContainText("2098");

    // This must appear without reloading: server refresh remounts the stateful
    // transition form, including calendars that were absent on initial render.
    const periodSelect = page.getByRole("combobox", { name: /^Fiscal period/ });
    await expect(periodSelect.locator("option").filter({ hasText: "2098" })).toHaveCount(12);
    await expect(page.getByRole("table")).toContainText("2098-12-31");

    // Retrying an unchanged command uses the same key and preserves its result.
    const replayPromise = page.waitForResponse((candidate) =>
      candidate.url().endsWith("/api/ledger/periods") && candidate.request().method() === "POST");
    await form.getByRole("button", { name: "Add periods", exact: true }).click();
    const replay = await replayPromise;
    expect(replay.status()).toBe(200);
    expect((await replay.json()).idempotentReplay).toBe(true);
    await expect(form.getByRole("status")).toContainText("Request already completed");
    await page.screenshot({ path: testInfo.outputPath("period-controls.png"), fullPage: true });
  } finally {
    await page.getByRole("button", { name: "Open account and security menu" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);
  }
});
