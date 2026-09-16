import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { JournalAdminAction } from "@/app/_components/journal-admin-action.client";

const journalId = "30000000-0000-4000-8000-000000000001";

describe("journal administrative action", () => {
  it("requires an explicit confirmation and audit reason without redundant local MFA for assured SSO", () => {
    const markup = renderToStaticMarkup(
      <JournalAdminAction
        journalId={journalId}
        journalNumber="41"
        kind="unpost"
        requiresMfaStepUp={false}
      />,
    );

    expect(markup).toContain("Audit reason");
    expect(markup).toContain("I understand this is an owner accounting control");
    expect(markup).toContain("Confirm unpost");
    expect(markup).not.toContain("FinLynQ authenticator code");
  });

  it("shows the local authenticator only when the server-derived session state requires step-up", () => {
    const markup = renderToStaticMarkup(
      <JournalAdminAction
        journalId={journalId}
        journalNumber="Draft"
        kind="delete"
        requiresMfaStepUp
      />,
    );

    expect(markup).toContain("FinLynQ authenticator code");
    expect(markup).toContain("Verify and continue");
    expect(markup).toContain("immutable deletion tombstone");
  });
});
