import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { PartyCreateForm } from "@/app/_components/party-create-form.client";

const option = {
  legalEntityId: "30000000-0000-4000-8000-000000000001",
  entityCode: "CA01",
  ledgerId: "30000000-0000-4000-8000-000000000002",
  ledgerCode: "PRIMARY",
  functionalCurrency: "CAD",
  role: "CUSTOMER" as const,
  controlAccountId: "30000000-0000-4000-8000-000000000003",
  controlAccountCode: "1100",
  controlAccountName: "Accounts receivable",
};

describe("party creation form", () => {
  it("requires an entity-bound AR/AP account setup alongside encrypted master data", () => {
    const markup = renderToStaticMarkup(<PartyCreateForm accountOptions={[option]} />);

    expect(markup).toContain("Customer or supplier setup");
    expect(markup).toContain("CA01 · Customer · 1100 Accounts receivable");
    expect(markup).toContain("AR/AP account number");
    expect(markup).toContain("Currency restriction (optional)");
    expect(markup).toContain("Create encrypted party and account");
  });

  it("fails closed when no active control-account combination is available", () => {
    const markup = renderToStaticMarkup(<PartyCreateForm accountOptions={[]} />);

    expect(markup).toContain("No configured AR/AP control account");
    expect(markup).toContain("Create an active AR or AP control account combination");
    expect(markup).toContain("disabled");
  });
});
