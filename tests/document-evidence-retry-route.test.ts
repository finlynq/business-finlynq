import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { StorageError } from "@/modules/document-storage/provider";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  principal: vi.fn(),
}));

vi.mock("@/modules/identity/session", () => ({
  requestPrincipal: mocks.principal,
}));
vi.mock("@/modules/workspace/write-policy", () => ({
  mutationContext: (_principal: unknown, requestId: string) => ({
    organizationId: "11111111-1111-4111-8111-111111111111",
    actorId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    sessionMode: "real",
    requestId,
    authMethod: "password",
    sourceSurface: "API",
  }),
}));
vi.mock("@/modules/subledger/evidence-service", () => ({
  downloadDocumentEvidence: mocks.download,
}));
vi.mock("@/app/api/_shared/demo-session-error-response", () => ({
  demoSessionLeaseLostResponse: () => null,
}));

import { GET } from "@/app/api/document-evidence/[assetId]/route";

const assetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceDocumentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function request() {
  return new NextRequest(`https://finlynq.test/api/document-evidence/${assetId}?sourceDocumentId=${sourceDocumentId}`, {
    headers: { "x-request-id": randomUUID() },
  });
}

describe("document evidence retry response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.principal.mockResolvedValue({ organizationId: "org", userId: "user", sessionId: "session", sessionMode: "real" });
  });

  it("returns an explicit bounded 503 for credential-refresh contention", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.download.mockRejectedValue(new StorageError(
      "STORAGE_RETRYABLE",
      "sensitive provider detail https://signed.example/secret",
      3,
    ));

    const response = await GET(request(), { params: Promise.resolve({ assetId }) });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toEqual({
      error: "Evidence is temporarily busy. Retry after 3 seconds.",
      code: "EVIDENCE_RETRYABLE",
      retryAfterSeconds: 3,
    });
    const logged = warning.mock.calls.flat().join(" ");
    expect(logged).toContain("EVIDENCE_RETRYABLE");
    expect(logged).not.toMatch(/signed\.example|provider detail|secret/);
    warning.mockRestore();
  });

  it("returns the same bounded retry contract for a transient database timeout", async () => {
    mocks.download.mockRejectedValue(Object.assign(new Error("query detail"), { code: "57014" }));
    const response = await GET(request(), { params: Promise.resolve({ assetId }) });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({ code: "EVIDENCE_RETRYABLE", retryAfterSeconds: 1 });
  });

  it("keeps non-retryable authorization and integrity failures indistinguishable", async () => {
    mocks.download.mockRejectedValue(Object.assign(new Error("integrity detail"), { code: "23505" }));
    const response = await GET(request(), { params: Promise.resolve({ assetId }) });
    expect(response.status).toBe(404);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toEqual({ error: "Evidence not found or access is no longer available." });
  });
});
