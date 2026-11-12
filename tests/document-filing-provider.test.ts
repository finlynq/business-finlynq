import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudDrive } from "@/modules/document-storage/provider";
import { assertFilingWorkerScope, documentFilingWorkerContext } from "@/modules/document-storage/filing-worker-context";
import { realStorageContext } from "@/modules/document-storage/store";
afterEach(() => vi.unstubAllGlobals());
describe("filing provider deadline and diagnostic boundaries", () => {
  it("keeps an attempt's cancellation separate from other drive users", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const signal = init!.signal!;
      if (signal.aborted) throw signal.reason;
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    vi.stubGlobal("fetch", fetcher);
    const base = new CloudDrive("ONEDRIVE", "synthetic-token", "drive");
    const controller = new AbortController();
    const request = base.withSignal(controller.signal).file("item");
    controller.abort(new Error("Synthetic attempt deadline"));
    await expect(request).rejects.toThrow("Synthetic attempt deadline");
    const file = { id: "item", name: "synthetic.pdf", size: 10, eTag: "v1", file: { mimeType: "application/pdf" }, parentReference: { id: "inbox", driveId: "drive" } };
    fetcher.mockImplementationOnce(async () => Response.json(file));
    await expect(base.file("item")).resolves.toMatchObject({ id: "item" });
  });
  it("honors a throttling delay and excludes provider text/unsafe correlation IDs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private provider body", { status: 429, headers: { "retry-after": "120", "request-id": "https://private.test/?token=secret" } })));
    const response = vi.fn();
    const drive = new CloudDrive("ONEDRIVE", "synthetic-token", "drive").withSignal(new AbortController().signal, response);
    await expect(drive.file("item")).rejects.toMatchObject({ code: "STORAGE_THROTTLED", retryAfterSeconds: 120 });
    expect(response).toHaveBeenCalledWith(429, null);
  });
  it("requires a server-minted worker context bound to one saved item", () => {
    const context = documentFilingWorkerContext({ organizationId: "org", actorId: "actor", itemId: "item", requestId: "synthetic" });
    expect(() => realStorageContext(context)).not.toThrow();
    expect(() => realStorageContext({ ...context })).toThrow(/signed-in real account/);
    expect(() => assertFilingWorkerScope(context, "other-item")).toThrow(/scope/);
  });
});
