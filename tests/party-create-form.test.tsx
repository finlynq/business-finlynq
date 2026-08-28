import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { PartyCreateForm } from "@/app/_components/party-create-form.client";

describe("party creation form", () => {
  it("creates the organization-wide master independently of entity accounting roles", () => {
    const markup = renderToStaticMarkup(<PartyCreateForm />);

    expect(markup).toContain("Create an address-book party");
    expect(markup).toContain("One organization-wide identifier");
    expect(markup).toContain("Add a shared address now");
    expect(markup).toContain("Create shared party");
    expect(markup).toContain("added later as accounting roles");
    expect(markup).not.toContain("Customer or supplier setup");
    expect(markup).not.toContain("AR/AP account number");
  });
});
