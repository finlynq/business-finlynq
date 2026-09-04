import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudDrive, exchangeStorageToken, type CloudFile, type StorageLocation } from "@/modules/document-storage/provider";
import { assertDirectChild, assertStorageFolder, assertStoredFile } from "@/modules/document-storage/boundaries";
import { storageAccessPolicy } from "@/modules/document-storage/access-policy";
import { connectStorageSchema } from "@/modules/document-storage/model";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const location: StorageLocation = { accountId: "account", driveId: "drive", rootId: "connection", inboxId: "inbox", archiveId: "archive", inboxUrl: "https://onedrive.live.com/inbox", archiveUrl: "https://onedrive.live.com/archive" };
function folder(id: string, parentId: string): CloudFile { return { id, parentId, name: id, mimeType: "folder", size: 0, version: "v1", folder: true }; }
function fixture() {
  const items = new Map([folder("connection", "app-root"), folder("inbox", "connection"), folder("archive", "connection"), folder("year", "archive"), folder("other-connection", "app-root"), folder("other-inbox", "other-connection")].map((f) => [f.id, f]));
  const drive = { provider: "ONEDRIVE", file: vi.fn(async (id: string) => { if (!items.has(id)) throw new Error("Missing folder"); return items.get(id)!; }), appFolder: vi.fn(async () => ({ id: "app-root", driveId: "drive" })) } as unknown as CloudDrive;
  return { items, drive };
}

describe("folder boundaries (mocked provider metadata, not live provider validation)", () => {
  it("accepts external drops in Inbox and historical files inside Archive", async () => {
    const { drive } = fixture();
    const external = { ...folder("external-file", "inbox"), folder: false };
    expect(() => assertDirectChild(external, "inbox")).not.toThrow();
    await expect(assertStoredFile(drive, location, external)).resolves.toBeUndefined();
    await expect(assertStoredFile(drive, location, { ...external, parentId: "year" })).resolves.toBeUndefined();
  });
  it("rejects another connection inside the same provider app-folder grant", async () => {
    const { drive } = fixture();
    await expect(assertStoredFile(drive, location, { ...folder("invoice", "other-inbox"), folder: false })).rejects.toThrow();
    expect(() => assertDirectChild(folder("unexpected-child", "other-inbox"), "inbox")).toThrow(/outside/);
  });
  it("stops after folder moves, deletion, ancestor cycles, and app-root changes", async () => {
    const { items, drive } = fixture();
    items.set("inbox", folder("inbox", "other-connection"));
    await expect(assertStorageFolder(drive, location, "inbox", "inbox")).rejects.toThrow(/outside/);
    items.delete("inbox");
    await expect(assertStorageFolder(drive, location, "inbox", "inbox")).rejects.toThrow(/Missing/);
    items.set("cycle", folder("cycle", "cycle"));
    await expect(assertStorageFolder(drive, location, "cycle", "archive")).rejects.toThrow(/outside/);
    items.set("connection", folder("connection", "outside-app-root"));
    await expect(assertStorageFolder(drive, location, "archive", "archive")).rejects.toThrow(/outside/);
  });
  it("keeps archive evidence readable when only the inbox is missing", async () => {
    const { drive, items } = fixture(); items.delete("inbox");
    await expect(assertStoredFile(drive, location, { ...folder("historic", "year"), folder: false })).resolves.toBeUndefined();
  });
  it("does not offer folder-only Google access or accept a share URL as consent", () => {
    expect(storageAccessPolicy("GOOGLE_DRIVE").newConnections).toBe(false);
    expect(storageAccessPolicy("ONEDRIVE").arbitraryFolderSelection).toBe(false);
    const input = { provider: "ONEDRIVE", legalEntityId: randomUUID(), module: "payables", label: "Purchases", sharedWithOrganization: true };
    expect(connectStorageSchema.safeParse(input).success).toBe(false);
    expect(connectStorageSchema.safeParse({ ...input, accessAcknowledged: true }).success).toBe(true);
    expect(connectStorageSchema.safeParse({ ...input, accessAcknowledged: true, folderUrl: "https://onedrive.live.com/share" }).success).toBe(false);
  });
});

describe("provider authorization boundaries", () => {
  it("preserves a legacy Google account and folder IDs on reconnect without creating folders", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ user: { permissionId: "account" } })); vi.stubGlobal("fetch", fetcher);
    const drive = new CloudDrive("GOOGLE_DRIVE", "test-token");
    expect(await drive.provision("new-label", location)).toEqual(location);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => Response.json({ user: { permissionId: "different-account" } }));
    await expect(drive.provision("new-label", location)).rejects.toThrow(/original cloud account/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects remote shortcuts, a different drive, and a substituted item ID", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const drive = new CloudDrive("ONEDRIVE", "test-token", "drive");
    const raw = { id: "file", name: "Invoice.png", size: 100, file: { mimeType: "image/png" }, parentReference: { id: "inbox", driveId: "drive" } };
    for (const value of [{ ...raw, remoteItem: { id: "outside" } }, { ...raw, parentReference: { id: "inbox", driveId: "other" } }, { ...raw, id: "substituted" }]) {
      fetcher.mockResolvedValueOnce(Response.json(value));
      await expect(drive.file("file")).rejects.toMatchObject({ code: "STORAGE_FOLDER_BOUNDARY" });
    }
  });
  it("validates upload, move, and archive-folder responses against the connected drive", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const drive = new CloudDrive("ONEDRIVE", "test-token", "drive");
    const raw = { id: "file", name: "Invoice.png", size: 100, file: { mimeType: "image/png" }, parentReference: { id: "inbox", driveId: "other-drive" } };
    fetcher.mockResolvedValueOnce(Response.json(raw));
    await expect(drive.upload("inbox", "Invoice.png", "image/png", Buffer.from("test"))).rejects.toMatchObject({ code: "STORAGE_FOLDER_BOUNDARY" });
    fetcher.mockResolvedValueOnce(Response.json(raw));
    await expect(drive.move({ ...folder("file", "inbox"), folder: false }, "archive", "Invoice.png")).rejects.toMatchObject({ code: "STORAGE_FOLDER_BOUNDARY" });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(Response.json({ ...raw, folder: {} }));
    await expect(drive.folder("archive", "2026")).rejects.toMatchObject({ code: "STORAGE_FOLDER_BOUNDARY" });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ...raw, folder: {}, parentReference: { id: "outside", driveId: "drive" } }));
    await expect(drive.folder("archive", "2026")).rejects.toMatchObject({ code: "STORAGE_FOLDER_BOUNDARY" });
  });
  function microsoftConfig() {
    vi.stubEnv("DOCUMENT_MICROSOFT_CLIENT_ID", "test-client"); vi.stubEnv("DOCUMENT_MICROSOFT_CLIENT_SECRET", "test-secret"); vi.stubEnv("DOCUMENT_MICROSOFT_CLIENT_SECRET_FILE", ""); vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  }
  it("requests only app-folder access and rejects a broader returned file grant", async () => {
    microsoftConfig();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "Files.ReadWrite.AppFolder Files.ReadWrite" })); vi.stubGlobal("fetch", fetcher);
    await expect(exchangeStorageToken("ONEDRIVE", { code: "code", verifier: "verifier" })).rejects.toMatchObject({ code: "STORAGE_SCOPE_EXCESSIVE" });
    expect((fetcher.mock.calls[0][1].body as URLSearchParams).get("scope")).toBe("offline_access Files.ReadWrite.AppFolder");
  });
  it("reports expired/revoked refresh tokens without exposing the provider body", async () => {
    microsoftConfig(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "invalid_grant", error_description: "secret-provider-detail" }, { status: 400 })));
    await expect(exchangeStorageToken("ONEDRIVE", { refreshToken: "test-refresh" })).rejects.toMatchObject({ code: "STORAGE_RECONNECT", message: expect.stringContaining("expired or was revoked") });
  });
});
