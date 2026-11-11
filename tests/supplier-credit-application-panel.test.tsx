import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubledgerWorkspaceDto } from "@/modules/subledger/workspace";

const saved = vi.hoisted(() => ({ creditId: "" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => react.useState(
    typeof initial === "string" ? saved.creditId : initial,
  ) };
});
import { SupplierCreditApplicationPanel } from "@/app/_components/supplier-credit-application.client";

const workspace = {
  currentDate: "2026-11-11",
  entities: [{ id: "entity", ledgerId: "ledger", partyAccounts: [{ id: "supplier" }], periods: [], fxGainAccounts: [], fxLossAccounts: [] }],
  openItems: [
    { id: "credit-new", sourceNumber: "CREDIT-NEW", sourceType: "payables.supplier-credit-note", partyAccountId: "supplier", ledgerId: "ledger", currency: "CAD", openAmount: "10.00" },
    { id: "credit-retained", sourceNumber: "CREDIT-RETAINED", sourceType: "payables.supplier-credit-note", partyAccountId: "other-supplier", ledgerId: "ledger", currency: "CAD", openAmount: "20.00" },
    { id: "bill-new", sourceNumber: "BILL-NEW", sourceType: "payables.supplier-bill", partyAccountId: "supplier", ledgerId: "ledger", currency: "CAD", openAmount: "30.00" },
    { id: "bill-other", sourceNumber: "BILL-OTHER", sourceType: "payables.supplier-bill", partyAccountId: "other-supplier", ledgerId: "ledger", currency: "CAD", openAmount: "40.00" },
  ],
} as unknown as SubledgerWorkspaceDto;

beforeEach(() => { saved.creditId = ""; });
describe("supplier credit selection across preserved route state", () => {
  it.each(["", "credit-no-longer-open"])("selects the available credit and matching bills after refresh with saved selection %j", (creditId) => {
    saved.creditId = creditId;
    const markup = renderToStaticMarkup(<SupplierCreditApplicationPanel workspace={workspace} />);
    expect(markup).toContain('value="credit-new" selected=""');
    expect(markup).toContain('value="bill-new"');
    expect(markup).not.toContain('value="bill-other"');
    expect(markup).not.toContain('disabled=""');
  });
  it("preserves a selected credit that is still open", () => {
    saved.creditId = "credit-retained";
    const markup = renderToStaticMarkup(<SupplierCreditApplicationPanel workspace={workspace} />);
    expect(markup).toContain('value="credit-retained" selected=""');
    expect(markup).toContain('value="bill-other"');
    expect(markup).not.toContain('value="bill-new"');
  });
});
