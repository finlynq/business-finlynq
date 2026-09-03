import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PeriodControlWorkspaceDto } from "@/modules/ledger/tenant-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PeriodCreationForm } from "@/app/_components/period-creation-form.client";

const workspace: PeriodControlWorkspaceDto = {
  demoOnly: false,
  canCreate: true,
  canClose: false,
  canReopen: false,
  canSeal: false,
  recentStepUp: false,
  ledgers: [{ id: "ledger", entityCode: "US01", ledgerCode: "PRIMARY", currency: "USD" }],
  periods: [],
};
const render = (overrides: Partial<PeriodControlWorkspaceDto> = {}) =>
  renderToStaticMarkup(<PeriodCreationForm workspace={{ ...workspace, ...overrides }} defaultFiscalYear={2027} />);

describe("Add periods form", () => {
  it("offers ledger selection even when the ledger has no periods", () => {
    const html = render();
    expect(html).toContain("Add periods");
    expect(html).toContain("US01 · PRIMARY · USD");
    expect(html).toContain('value="2027"');
    expect(html).toContain("Authenticator code");
    expect(html).toContain("Creation reason");
  });
  it("explains permission and write activation without offering a mutation", () => {
    const html = render({ canCreate: false });
    expect(html).toContain("ledger.period.create");
    expect(html).not.toContain("<form");
  });
  it("guides empty organizations to accounting setup", () => {
    const html = render({ ledgers: [] });
    expect(html).toContain("/app/settings/accounting");
    expect(html).not.toContain("<form");
  });
  it("does not ask for another code during a recent step-up", () => {
    expect(render({ recentStepUp: true })).not.toContain("Authenticator code");
  });
  it("identifies the shared demo without presenting its confirmation as MFA", () => {
    const html = render({ demoOnly: true });
    expect(html).toContain("shared public demo");
    expect(html).not.toContain("Authenticator code");
  });
});
