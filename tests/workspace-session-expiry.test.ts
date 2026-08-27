import { beforeEach, describe, expect, it, vi } from "vitest";
import { DemoSessionLeaseLostError } from "@/db/errors";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  redirectSignal: new Error("NEXT_REDIRECT"),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

import { withWorkspaceSessionExpiryRedirect } from "@/modules/workspace/tenant-read";

describe("workspace session-expiry boundary", () => {
  beforeEach(() => {
    mocks.redirect.mockReset();
    mocks.redirect.mockImplementation(() => {
      throw mocks.redirectSignal;
    });
  });

  it("turns only a typed lost demo lease into the normal signed-out redirect", async () => {
    await expect(withWorkspaceSessionExpiryRedirect(
      "/app/reports/trial-balance",
      async () => { throw new DemoSessionLeaseLostError(); },
    )).rejects.toBe(mocks.redirectSignal);

    expect(mocks.redirect).toHaveBeenCalledWith(
      "/login?next=%2Fapp%2Freports%2Ftrial-balance&reason=expired",
    );
  });

  it("does not hide unrelated workspace failures", async () => {
    const failure = new Error("Ledger read permission is required");
    await expect(withWorkspaceSessionExpiryRedirect(
      "/app",
      async () => { throw failure; },
    )).rejects.toBe(failure);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
