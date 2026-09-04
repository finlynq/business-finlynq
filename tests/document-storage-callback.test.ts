import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ principal: vi.fn(), finish: vi.fn() }));
vi.mock("@/modules/identity/session", () => ({ requestPrincipal: mocks.principal }));
vi.mock("@/modules/document-storage/connections", () => ({ finishStorageConnection: mocks.finish }));
vi.mock("@/modules/document-storage/provider", async (original) => ({
  ...await original<object>(),
  providerConfiguration: () => ({ redirectUri: "https://dev.business.finlynq.com/api/document-storage/callback/ONEDRIVE" }),
}));
import { GET } from "@/app/api/document-storage/callback/[provider]/route";
import { StorageError } from "@/modules/document-storage/provider";

const principal = { sessionMode: "real", organizationId: "tenant", userId: "actor" };
function callback(query = "state=private-state&code=private-code") {
  return GET(new NextRequest(`https://untrusted-host.test/api/document-storage/callback/ONEDRIVE?${query}`), { params: Promise.resolve({ provider: "ONEDRIVE" }) });
}
beforeEach(() => { vi.clearAllMocks(); mocks.principal.mockResolvedValue(principal); mocks.finish.mockResolvedValue({ connectionId: "connection" }); });

describe("storage callback feedback (mocked OAuth)", () => {
  it("returns only a fixed outcome to the configured origin after successful authorization", async () => {
    const response = await callback();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://dev.business.finlynq.com/app/settings/documents?storage=connected");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.finish).toHaveBeenCalledWith(principal, "ONEDRIVE", "private-state", "private-code");
  });
  it("maps recoverable failures without exposing provider details, credentials, or arbitrary error codes", async () => {
    for (const [code, outcome] of [
      ["STORAGE_ACCOUNT_MISMATCH", "original-account"], ["STORAGE_MISSING", "folder-unavailable"],
      ["STORAGE_FOLDER_BOUNDARY", "folder-unavailable"], ["STORAGE_OAUTH_EXPIRED", "authorization-expired"],
      ["STORAGE_RECONNECT", "authorization-expired"], ["STORAGE_AUTHORIZATION_UNSUPPORTED", "unsupported-access"],
      ["STORAGE_SCOPE_EXCESSIVE", "excessive-access"], ["private-provider-code", "failed"], ["__proto__", "failed"],
    ]) {
      mocks.finish.mockRejectedValueOnce(new StorageError(code, "private-provider-detail"));
      expect((await callback()).headers.get("location")).toBe(`https://dev.business.finlynq.com/app/settings/documents?storage=${outcome}`);
    }
  });
  it("does not exchange a code after denied consent or without a real session", async () => {
    const denied = await callback("error=access_denied&error_description=private-provider-detail&code=private-code");
    expect(denied.headers.get("location")).toBe("https://dev.business.finlynq.com/app/settings/documents?storage=failed");
    mocks.principal.mockResolvedValue(null); await callback();
    mocks.principal.mockResolvedValue({ sessionMode: "demo" }); await callback();
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});
