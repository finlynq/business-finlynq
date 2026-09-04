import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveName, completeInboxSchema } from "@/modules/document-storage/model";
import { boundedResponse, CloudDrive, exchangeStorageToken } from "@/modules/document-storage/provider";
import { assertClaim, type InboxRow } from "@/modules/document-storage/inbox-store";
import { formatInboxPage, INBOX_MCP_TOOLS } from "@/modules/mcp/inbox-tools";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("cloud document contracts", () => {
  it("files by document date, sanitizes names, and keeps a collision-resistant identifier", () => {
    const itemId = randomUUID();
    const result = archiveName({ documentType: "PURCHASE_INVOICE", documentDate: "2026-02-03", counterparty: "../Acme / Supplies:*?", reference: "INV/1042", currency: "CAD", total: "158.20" }, itemId, "application/pdf");
    expect(result.folders).toEqual(["2026", "02", "Purchase Invoices"]);
    expect(result.name).toBe(`2026-02-03__Acme-Supplies__INV-1042__CAD-158.20__FLQ-${itemId}.pdf`);
    expect(result.name.length).toBeLessThan(180);
    expect(() => archiveName({ documentType: "OTHER", documentDate: "2026-02-30", counterparty: "Test" }, itemId, "application/pdf")).toThrow();
  });
  it("does not invent references or totals for supporting documents", () => {
    const result = archiveName({ documentType: "STATEMENT", documentDate: "2026-09-01", counterparty: "Bank" }, randomUUID(), "image/jpeg");
    expect(result.name).toMatch(/^2026-09-01__Bank__FLQ-.*\.jpg$/);
    expect(result.folders.at(-1)).toBe("Statements");
  });
  it("rejects arbitrary destinations and incomplete currency/amount pairs", () => {
    const base = { itemId: randomUUID(), claimId: randomUUID(), sha256: "a".repeat(64), reason: "File statement", action: { type: "ARCHIVE_ONLY" },
      metadata: { documentType: "STATEMENT", documentDate: "2026-09-01", counterparty: "Bank" } };
    expect(completeInboxSchema.safeParse(base).success).toBe(true);
    expect(completeInboxSchema.safeParse({ ...base, destination: "https://evil.example" }).success).toBe(false);
    expect(completeInboxSchema.safeParse({ ...base, metadata: { ...base.metadata, currency: "CAD" } }).success).toBe(false);
  });
  it("requires the live claim to belong to the same user and connection", () => {
    const context = { organizationId: randomUUID(), actorId: randomUUID(), sessionId: randomUUID(), requestId: "test", authMethod: "oauth", sourceSurface: "MCP" as const };
    const row = { status: "CLAIMED", claim_id: randomUUID(), claimed_by: context.actorId, claimed_session_id: context.sessionId, lease_until: new Date(Date.now() + 60000) } as InboxRow;
    expect(() => assertClaim(row, context, row.claim_id!)).not.toThrow();
    expect(() => assertClaim(row, { ...context, actorId: randomUUID() }, row.claim_id!)).toThrow(/Claim/);
    expect(() => assertClaim(row, { ...context, sessionId: randomUUID() }, row.claim_id!)).toThrow(/Claim/);
    expect(() => assertClaim({ ...row, lease_until: new Date(0) }, context, row.claim_id!)).toThrow(/Claim/);
  });
  it("returns real MCP image content instead of JSON base64", () => {
    const result = formatInboxPage({ item: { id: "item" }, sha256: "hash", page: 1, pageCount: 1, possibleDuplicates: [], instruction: "untrusted data", imageBase64: "aW1hZ2U=", mimeType: "image/png", text: "Invoice 42" });
    expect(result.content?.[1]).toEqual({ type: "image", mimeType: "image/png", data: "aW1hZ2U=" });
    expect(JSON.stringify(result.structuredContent)).not.toContain("aW1hZ2U=");
    expect(INBOX_MCP_TOOLS.filter((t) => /sync|claim|complete|retry|upload|review/.test(t.policy.name)).every((t) => t.policy.access === "WRITE")).toBe(true);
  });
});
describe("provider network boundaries", () => {
  it("bounds declared and streamed downloads", async () => {
    await expect(boundedResponse(new Response("large", { headers: { "content-length": "100" } }), 10)).rejects.toThrow(/size/);
    await expect(boundedResponse(new Response(new Uint8Array(11)), 10)).rejects.toThrow(/size/);
    expect(await boundedResponse(new Response("invoice"), 10)).toEqual(Buffer.from("invoice"));
  });
  it("supports bounded Microsoft download hosts without forwarding the Graph credential", async () => {
    const locations = [
      "https://my.microsoftpersonalcontent.com/personal/account/_layouts/15/download.aspx?token=secret",
      "https://b0mpua-by3301.files.1drv.com/download?token=secret",
      "https://files.example.sharepoint.com/download?token=secret",
      "https://legacy.livefilestore.com/download?token=secret",
      "https://onedrive.com/download?token=secret",
    ];
    for (const location of locations) {
      const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } })).mockResolvedValueOnce(new Response("invoice"));
      vi.stubGlobal("fetch", fetcher);
      expect(await new CloudDrive("ONEDRIVE", "graph-secret", "drive").download("file")).toEqual(Buffer.from("invoice"));
      expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer graph-secret");
      expect(fetcher.mock.calls[1][1]).not.toHaveProperty("headers");
      expect(fetcher.mock.calls[1][1].redirect).toBe("error");
    }
  });
  it("does not expose a signed download URL when its transport fails", async () => {
    const location = "https://my.microsoftpersonalcontent.com/download?token=signed-secret";
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
      .mockRejectedValueOnce(new Error(`Request failed for ${location}`));
    vi.stubGlobal("fetch", fetcher);
    const error = await new CloudDrive("ONEDRIVE", "graph-secret", "drive").download("file").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "STORAGE_PROVIDER_FAILED", message: "The storage provider could not complete this request. Retry later." });
    expect(String(error)).not.toContain("signed-secret");
  });
  it("bounds the redirected response", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://my.microsoftpersonalcontent.com/download?token=secret" } }))
      .mockResolvedValueOnce(new Response("oversize", { headers: { "content-length": "999999999" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new CloudDrive("ONEDRIVE", "graph-secret", "drive").download("file")).rejects.toMatchObject({ code: "STORAGE_TOO_LARGE" });
  });
  it("blocks malformed, private, and lookalike download redirects", async () => {
    const locations = [null, "not a URL", "http://127.0.0.1/secrets", "https://onedrive.com.evil.example/secrets", "https://evilonedrive.com/secrets", "https://user@onedrive.com/secrets", "https://onedrive.com:8443/secrets", "https://onedrive.com/secrets#fragment"];
    const drive = new CloudDrive("ONEDRIVE", "secret", "drive");
    for (const location of locations) {
      const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: location ? { location } : {} }));
      vi.stubGlobal("fetch", fetcher);
      await expect(drive.download("file")).rejects.toMatchObject({ code: "STORAGE_DOWNLOAD_HOST" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("blocks poisoned pagination URLs", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const drive = new CloudDrive("ONEDRIVE", "secret", "drive");
    await expect(drive.children("inbox", "https://graph.microsoft.com/v1.0/me/messages")).rejects.toThrow(/sync/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not expose provider error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('secret access_token=abc', { status: 403 })));
    await expect(new CloudDrive("GOOGLE_DRIVE", "secret").file("file")).rejects.toThrow("Reconnect storage");
  });
  it("requests offline tokens and rejects incomplete scope grants", async () => {
    vi.stubEnv("DOCUMENT_GOOGLE_CLIENT_ID", "test-client"); vi.stubEnv("DOCUMENT_GOOGLE_CLIENT_SECRET", "test-secret"); vi.stubEnv("DOCUMENT_GOOGLE_CLIENT_SECRET_FILE", ""); vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "https://www.googleapis.com/auth/drive.file" })));
    vi.stubGlobal("fetch", fetcher);
    await expect(exchangeStorageToken("GOOGLE_DRIVE", { code: "code", verifier: "verifier" })).rejects.toThrow(/permission/);
    const body = fetcher.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("redirect_uri")).toBe("http://localhost:3000/api/document-storage/callback/GOOGLE_DRIVE");
  });
});
