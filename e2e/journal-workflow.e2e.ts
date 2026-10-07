import { expect, test, type Page } from "@playwright/test";
import type { JournalWorkflowEligibility } from "../src/modules/ledger/journal-workflow-eligibility";
import { installReleaseAcceptanceRoute, releaseGet } from "./release-acceptance";
import { installJournalWorkflowBrowserFixture } from "./journal-workflow-browser-fixture";

async function confirmWorkflow(page: Page, label: string, reason: string) {
  const disclosure = page.locator("details").filter({ has: page.locator("summary", { hasText: new RegExp(`^${label}$`) }) });
  await disclosure.locator("summary").click();
  const confirm = disclosure.getByRole("button", { name: `Confirm ${label.toLowerCase()}`, exact: true });
  await expect(confirm).toBeDisabled();
  await disclosure.getByLabel("Audit reason", { exact: true }).fill(reason);
  await disclosure.getByRole("checkbox").check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

async function endDemo(page: Page) {
  if (!new URL(page.url()).pathname.startsWith("/app")) return;
  await page.getByRole("button", { name: "Open account and security menu" }).click({ timeout: 1_000 }).catch(() => undefined);
  await page.getByRole("button", { name: "Sign out" }).click({ timeout: 1_000 }).catch(() => undefined);
  await page.waitForURL(/\/$/, { timeout: 2_000 }).catch(() => undefined);
}

test("synthetic demo depreciation journal can be submitted and withdrawn by its creator without recreation", async ({ page, context }) => {
  test.setTimeout(60_000);
  await installReleaseAcceptanceRoute(context);
  await page.goto("/login?next=%2Fapp%2Fjournals%2Fnew");
  const entry = await page.getByRole("link", { name: /Open the public demo/ }).getAttribute("href");
  if (!entry) throw new Error("Synthetic demo entry is unavailable");
  const login = await releaseGet(page.request, entry);
  expect(login.status()).toBe(303);
  expect(new URL(login.headers().location).pathname).toBe("/app/journals/new");
  await page.goto("/app/journals/new");
  // Use the demo's server-derived accounting month so this remains valid when
  // its rolling synthetic calendar changes. Earlier seeded months are closed.
  const accountingMonth = (await page.getByLabel("Accounting date", { exact: true }).inputValue()).slice(0, 7);
  const assetNumber = `FA-E2E-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    await page.goto("/app/assets");
    // The public demo persists between releases and retries. Give this run its
    // own synthetic asset; a prior run may already have drafted the seed asset.
    await page.getByText("Create an asset or prepaid", { exact: true }).first().click();
    const form = page.locator('[aria-labelledby="new-asset-title"]');
    const category = await form.getByRole("option", { name: /^TANGIBLE ·/ }).first().getAttribute("value");
    if (!category) throw new Error("A tangible synthetic asset category is required");
    await form.locator('select[name="categoryId"]').selectOption(category);
    await form.getByLabel("Asset number", { exact: true }).fill(assetNumber);
    await form.getByLabel("Name", { exact: true }).fill("Synthetic workflow acceptance asset");
    await form.getByLabel("Acquisition date", { exact: true }).fill(`${accountingMonth}-01`);
    await form.getByLabel("In-service / recognition start", { exact: true }).fill(`${accountingMonth}-01`);
    await form.getByLabel("Useful life (months)", { exact: true }).fill("1");
    await form.getByLabel("Cost", { exact: true }).fill("120.00");
    await form.getByLabel("Source reference", { exact: true }).fill("Synthetic release acceptance only");
    const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/assets/register") && response.request().method() === "POST");
    await form.getByRole("button", { name: "Create register record", exact: true }).click();
    const created = await createdResponse;
    expect(created.ok(), await created.text()).toBe(true);
    const schedule = page.locator('[aria-labelledby="asset-schedule-title"]').getByRole("row").filter({ hasText: assetNumber })
      .filter({ has: page.locator("td:nth-child(3)", { hasText: new RegExp(`^${accountingMonth}-`) }) })
      .filter({ has: page.getByRole("button", { name: "Create journal draft", exact: true }) }).first();
    await expect(schedule).toBeVisible();
    const generatedResponse = page.waitForResponse((response) => /\/api\/assets\/schedules\/[^/]+\/draft$/.test(response.url()) && response.request().method() === "POST");
    await schedule.getByRole("button", { name: "Create journal draft", exact: true }).click();
    const generated = await generatedResponse;
    expect(generated.ok(), await generated.text()).toBe(true);
    const { journalId } = await generated.json() as { journalId: string };
    await page.goto(`/app/journals/${journalId}`);
    await expect(page.getByRole("heading", { name: new RegExp(`Depreciation · ${assetNumber}`) })).toBeVisible();
    const summary = page.locator('[aria-labelledby="journal-summary-title"]');
    await expect(summary).toContainText("DRAFT");

    const submittedResponse = page.waitForResponse((response) => response.url().endsWith(`/journals/${journalId}/submit`) && response.request().method() === "POST");
    await confirmWorkflow(page, "Submit for approval", "Submit synthetic depreciation for independent review.");
    const submitted = await submittedResponse;
    expect(submitted.status(), await submitted.text()).toBe(200);
    const frozen = await submitted.json() as { contentHash: string; approvalVersion: number };
    expect(frozen.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(frozen.approvalVersion).toBeGreaterThan(0);
    expect(submitted.request().postDataJSON().expectedContentHash).toBe(frozen.contentHash);
    await expect(summary).toContainText("SUBMITTED");
    await expect(page.getByText("You created this journal. A different user with journal approval permission", { exact: false })).toBeVisible();
    await expect(page.locator("summary", { hasText: /^Approve journal$/ })).toHaveCount(0);
    await expect(page.locator("summary", { hasText: /^Post journal$/ })).toHaveCount(0);
    await expect(page.locator('[aria-labelledby="journal-lines-title"] input')).toHaveCount(0);

    // Exercise the HTTP boundary too: hiding the creator's approval button is
    // not the security control. The live service must reject self approval.
    const selfApproval = await page.evaluate(async ({ journalId, frozen }) => {
      const response = await fetch(`/api/ledger/journals/${journalId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedContentHash: frozen.contentHash, expectedApprovalVersion: frozen.approvalVersion, reason: "Attempt synthetic creator self approval." }) });
      return { status: response.status, body: await response.json() };
    }, { journalId, frozen });
    expect(selfApproval.status).toBe(409);
    expect(selfApproval.body.code).toBe("CREATOR_CANNOT_APPROVE");

    const withdrawalResponse = page.waitForResponse((response) => response.url().endsWith(`/journals/${journalId}/withdraw`) && response.request().method() === "POST");
    await confirmWorkflow(page, "Withdraw submission", "Withdraw synthetic depreciation to correct its supporting evidence.");
    const withdrawn = await withdrawalResponse;
    expect(withdrawn.status(), await withdrawn.text()).toBe(200);
    expect(withdrawn.request().postDataJSON()).toMatchObject({ expectedContentHash: frozen.contentHash, expectedApprovalVersion: frozen.approvalVersion });
    expect(withdrawn.request().postDataJSON().idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(await withdrawn.json()).toMatchObject({ journalId, status: "DRAFT", approvalVersion: null, contentHash: null });
    await expect(summary).toContainText("DRAFT");
    await expect(page.locator("summary", { hasText: /^Submit for approval$/ })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/app/journals/${journalId}$`));
  } finally {
    await endDemo(page);
  }
});

const fixtureJournalId = "30000000-0000-4000-8000-000000000001";
const allowed = { allowed: true, reasonCode: null, reason: null };
const blocked = { allowed: false, reasonCode: "APPROVAL_REQUIRED" as const, reason: "A different authorized approver must review the frozen version." };
function reviewerWorkflow(mode: "REVIEW_REQUIRED" | "AUTO_POST"): JournalWorkflowEligibility {
  return { status: "SUBMITTED", contentHash: "a".repeat(64), approvalVersion: 3,
    manualPostingMode: mode, actorIsCreator: false, independentApprovalRequired: true,
    actions: { submit: blocked, approve: allowed, post: blocked, withdraw: blocked, reject: allowed } };
}

// These tests mount the production component in Chromium, with explicit
// intercepted command/refresh responses. They verify browser interaction and
// frozen payloads; PostgreSQL and multi-user authorization are tested separately.
for (const mode of ["REVIEW_REQUIRED", "AUTO_POST"] as const) {
  test(`browser transport boundary: independent approval and posting refresh the ${mode} workflow`, async ({ page }) => {
    const workflow = reviewerWorkflow(mode);
    const fixture = await installJournalWorkflowBrowserFixture(page, { journalId: fixtureJournalId, journalNumber: "Submitted", workflow });
    await expect(page.getByLabel("Journal status", { exact: true })).toHaveText("SUBMITTED");
    await page.route(`**/api/ledger/journals/${fixtureJournalId}/approve`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({ expectedContentHash: workflow.contentHash, expectedApprovalVersion: 3, reason: "Independent review of synthetic depreciation evidence." });
      fixture.setState({ journalId: fixtureJournalId, journalNumber: "Approved", workflow: { ...workflow, status: "APPROVED", independentApprovalRequired: false, actions: { ...workflow.actions, post: allowed } } });
      await route.fulfill({ json: { status: "APPROVED", contentHash: workflow.contentHash, approvalVersion: 3, idempotentReplay: false } });
    });
    await confirmWorkflow(page, "Approve journal", "Independent review of synthetic depreciation evidence.");
    await expect(page.getByLabel("Journal status", { exact: true })).toHaveText("APPROVED");
    await expect(page.locator("summary", { hasText: /^Approve journal$/ })).toHaveCount(0);
    await page.route(`**/api/ledger/journals/${fixtureJournalId}/post`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({ expectedContentHash: workflow.contentHash, expectedApprovalVersion: 3, reason: "Post independently approved synthetic depreciation." });
      fixture.setState({ journalId: fixtureJournalId, journalNumber: "52", workflow: { ...workflow, status: "POSTED" } });
      await route.fulfill({ json: { status: "POSTED", journalNumber: 52, idempotentReplay: false } });
    });
    await confirmWorkflow(page, "Post journal", "Post independently approved synthetic depreciation.");
    await expect(page.getByRole("heading", { name: "Journal 52", exact: true })).toBeVisible();
    await expect(page.getByLabel("Journal status", { exact: true })).toHaveText("POSTED");
    await expect(page.locator("summary")).toHaveCount(0);
  });
}
