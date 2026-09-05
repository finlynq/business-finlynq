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
  downloadBankStatementEvidence: mocks.download,
}));
vi.mock("@/app/api/_shared/demo-session-error-response", () => ({
  demoSessionLeaseLostResponse: () => null,
}));

import { GET } from "@/app/api/banking/statement-imports/[statementImportId]/evidence/[assetId]/route";

const statementImportId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const assetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function request() {
  return new NextRequest(
    `https://finlynq.test/api/banking/statement-imports/${statementImportId}/evidence/${assetId}`,
    { headers: { "x-request-id": randomUUID() } },
  );
}

describe("bank-statement evidence browser route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.principal.mockResolvedValue({
      organizationId: "org",
      userId: "user",
      sessionId: "session",
      sessionMode: "real",
    });
  });

  it("passes both exact identifiers and clears the service buffer", async () => {
    const bytes = Buffer.from("invoice");
    mocks.download.mockResolvedValue({
      metadata: {
        filename: "Bank statement.pdf",
        mimeType: "application/pdf",
      },
      bytes,
    });
    const response = await GET(request(), {
      params: Promise.resolve({ statementImportId, assetId }),
    });

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("invoice");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({
      statementImportId,
      assetId,
      context: expect.objectContaining({ sourceSurface: "API" }),
    }));
    expect(bytes).toEqual(Buffer.alloc(bytes.length));
  });

  it("rejects malformed identifiers without calling the service", async () => {
    const response = await GET(request(), {
      params: Promise.resolve({ statementImportId, assetId: "not-an-asset" }),
    });
    expect(response.status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("keeps authorization and association failures indistinguishable", async () => {
    mocks.download.mockRejectedValue(new Error("another tenant or wrong asset"));
    const response = await GET(request(), {
      params: Promise.resolve({ statementImportId, assetId }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Evidence not found or access is no longer available.",
    });
  });

  it("returns bounded retry guidance without provider details", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.download.mockRejectedValue(new StorageError(
      "STORAGE_RETRYABLE",
      "secret provider URL",
      2,
    ));
    const response = await GET(request(), {
      params: Promise.resolve({ statementImportId, assetId }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.json()).toMatchObject({
      code: "EVIDENCE_RETRYABLE",
      retryAfterSeconds: 2,
    });
    expect(warning.mock.calls.flat().join(" ")).not.toContain("secret provider URL");
    warning.mockRestore();
  });
});
