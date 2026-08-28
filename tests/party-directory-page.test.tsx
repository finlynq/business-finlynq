import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  principal: {
    sessionId: "10000000-0000-4000-8000-000000000001",
    userId: "10000000-0000-4000-8000-000000000002",
    organizationId: "10000000-0000-4000-8000-000000000003",
    membershipId: "10000000-0000-4000-8000-000000000004",
    organizationName: "Tenant",
    roleLabel: "Owner",
    displayName: "Owner",
    initials: "OW",
    sessionMode: "real" as const,
    authMethod: "PASSWORD" as const,
    expiresAt: new Date("2026-08-27T00:00:00Z"),
    mfaVerifiedAt: null,
    stepUpExpiresAt: null,
  },
  directory: vi.fn(),
  options: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/modules/identity/session", () => ({
  currentPrincipal: vi.fn(async () => mocks.principal),
}));
vi.mock("@/modules/ledger/tenant-workspace", () => ({
  loadTenantPartyDirectory: mocks.directory,
}));
vi.mock("@/modules/parties/party-workspace", () => ({
  loadPartyAccountCreationOptions: mocks.options,
}));

import PartiesPage from "@/app/(workspace)/parties/page";

describe("shared party directory page", () => {
  it("renders one organization party with roles in multiple entities and its encrypted address", async () => {
    mocks.options.mockResolvedValue([{
      legalEntityId: "20000000-0000-4000-8000-000000000001",
      entityCode: "US01",
      ledgerId: "20000000-0000-4000-8000-000000000002",
      ledgerCode: "US01-PRIMARY",
      functionalCurrency: "USD",
      role: "SUPPLIER",
      controlAccountId: "20000000-0000-4000-8000-000000000003",
      controlAccountCode: "2000",
      controlAccountName: "Accounts payable",
    }]);
    mocks.directory.mockResolvedValue({
      demoOnly: false,
      readiness: "READY",
      canManage: true,
      parties: [{
        id: "30000000-0000-4000-8000-000000000001",
        partyNumber: "P-1001",
        displayName: "Shared Trading Partner",
        active: true,
        accounts: [{
          id: "40000000-0000-4000-8000-000000000001",
          legalEntityId: "50000000-0000-4000-8000-000000000001",
          entityCode: "CA01",
          entityName: "Canada Company",
          ledgerCode: "CA01-PRIMARY",
          role: "CUSTOMER",
          accountNumber: "C-CA-1001",
          transactionCurrency: "CAD",
          controlAccountCode: "1100",
          active: true,
        }, {
          id: "40000000-0000-4000-8000-000000000002",
          legalEntityId: "50000000-0000-4000-8000-000000000002",
          entityCode: "US01",
          entityName: "USA Company",
          ledgerCode: "US01-PRIMARY",
          role: "SUPPLIER",
          accountNumber: "V-US-1001",
          transactionCurrency: null,
          controlAccountCode: "2000",
          active: true,
        }],
        addresses: [{
          id: "60000000-0000-4000-8000-000000000001",
          kind: "BILLING",
          line1: "1 Shared Street",
          line2: null,
          city: "Toronto",
          region: "ON",
          postalCode: "M5V 2T6",
          countryCode: "CA",
          validFrom: "2026-01-01",
          validTo: null,
        }],
      }],
    });

    const page = await PartiesPage({ searchParams: Promise.resolve({}) });
    const markup = renderToStaticMarkup(page);
    expect(markup).toContain("Organization address book");
    expect(markup).toContain("Shared Trading Partner");
    expect(markup).toContain("CA01 · Canada Company · CAD · control 1100");
    expect(markup).toContain("US01 · USA Company · Any currency · control 2000");
    expect(markup).toContain("1 Shared Street · Toronto, ON M5V 2T6 · CA");
    expect(markup).toContain("Add customer / supplier accounting role");
    expect(markup).toContain("Party number or exact encrypted name");
  });
});
