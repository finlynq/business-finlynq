import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageError, type CloudDrive, type CloudFile, type StorageLocation } from "@/modules/document-storage/provider";
import { traverseDocumentInbox } from "@/modules/document-storage/traversal";

afterEach(() => vi.unstubAllEnvs());

const location: StorageLocation = {
  accountId: "account", driveId: "drive", rootId: "root", inboxId: "inbox", archiveId: "archive",
  inboxUrl: "https://onedrive.live.com/inbox", archiveUrl: "https://onedrive.live.com/archive",
};
const folder = (id: string, parentId: string, name = id): CloudFile => ({ id, parentId, name, mimeType: "folder", size: 0, version: "v1", folder: true });
const file = (id: string, parentId: string, name = `${id}.pdf`): CloudFile => ({ id, parentId, name, mimeType: "application/pdf", size: 20, version: "v1", folder: false });

function driveFixture(items: CloudFile[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = vi.fn(async (parentId: string, cursor?: string | null) => {
    const values = items.filter((item) => item.parentId === parentId);
    const start = cursor ? Number(cursor.split(":").at(-1)) : 0;
    const page = values.slice(start, start + 50);
    return { files: page, cursor: start + 50 < values.length ? `${parentId}:${start + 50}` : null };
  });
  return {
    children,
    drive: {
      file: vi.fn(async (id: string) => {
        const value = byId.get(id);
        if (!value) throw new StorageError("STORAGE_MISSING", "missing");
        return { ...value };
      }),
      children,
    } as unknown as CloudDrive,
  };
}

describe("bounded recursive inbox traversal (mocked providers)", () => {
  it("discovers a file through three nested folders and retains a safe relative path", async () => {
    const { drive } = driveFixture([
      folder("year", "inbox", "2026"), folder("month", "year", "September"),
      folder("supplier", "month", "Acme"), file("invoice", "supplier", "Invoice 42.pdf"),
    ]);
    const result = await traverseDocumentInbox(drive, location, null);
    expect(result.nextCursor).toBeNull();
    expect(result.files).toEqual([expect.objectContaining({
      sourcePath: "2026/September/Acme/Invoice 42.pdf",
      sourceFolderId: "supplier",
      sourceDepth: 3,
    })]);
    expect(result.providerCalls).toBeLessThanOrEqual(10);
  });

  it("paginates more than 50 files without repeating provider items", async () => {
    const values = Array.from({ length: 60 }, (_, index) => file(`f${index}`, "inbox"));
    const { drive } = driveFixture(values);
    const first = await traverseDocumentInbox(drive, location, null);
    expect(first.files).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await traverseDocumentInbox(drive, location, first.nextCursor);
    expect(second.files).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.files, ...second.files].map((candidate) => candidate.file.id))).toHaveLength(60);
  });

  it("skips shortcuts, configured archive IDs, folder cycles, and folders beyond configured depth", async () => {
    vi.stubEnv("DOCUMENT_INBOX_MAX_DEPTH", "2");
    const shortcut = { ...file("shortcut", "inbox", "Shared invoice.pdf"), shortcut: true };
    const archive = folder("archive", "inbox", "Archive");
    const repeated = folder("inbox", "inbox", "Cycle");
    const first = folder("first", "inbox");
    const second = folder("second", "first");
    const tooDeep = folder("third", "second");
    const { drive } = driveFixture([shortcut, archive, repeated, first, second, tooDeep]);
    const result = await traverseDocumentInbox(drive, location, null);
    expect(result.files).toEqual([]);
    expect(result.skipped).toBe(4);
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "STORAGE_SHORTCUT_SKIPPED", "STORAGE_FOLDER_CYCLE_SKIPPED", "STORAGE_DEPTH_LIMIT",
    ]));
  });

  it("fails closed when a queued folder moves to another parent", async () => {
    const child = folder("child", "inbox");
    const fixture = driveFixture([child, file("invoice", "child")]);
    const first = await traverseDocumentInbox(fixture.drive, location, null);
    // The first call can finish this small tree. Force a resumable queue with a
    // one-call policy, then move the queued folder before resuming it.
    vi.stubEnv("DOCUMENT_INBOX_MAX_DEPTH", "1");
    vi.stubEnv("DOCUMENT_INBOX_MAX_PROVIDER_CALLS", "2");
    const queued = await traverseDocumentInbox(fixture.drive, location, null);
    expect(queued.nextCursor).not.toBeNull();
    vi.mocked(fixture.drive.file).mockResolvedValueOnce({ ...child, parentId: "outside" });
    await expect(traverseDocumentInbox(fixture.drive, location, queued.nextCursor)).rejects.toMatchObject({ code: "STORAGE_FOLDER_BOUNDARY" });
    expect(first.files[0].file.id).toBe("invoice");
  });

  it("revalidates every saved ancestor before scanning a queued descendant", async () => {
    const year = folder("year", "inbox");
    const month = folder("month", "year");
    const supplier = folder("supplier", "month");
    const fixture = driveFixture([year, month, supplier, file("invoice", "supplier")]);

    vi.stubEnv("DOCUMENT_INBOX_MAX_DEPTH", "3");
    vi.stubEnv("DOCUMENT_INBOX_MAX_PROVIDER_CALLS", "4");
    const first = await traverseDocumentInbox(fixture.drive, location, null);
    expect(first.nextCursor).not.toBeNull();
    const second = await traverseDocumentInbox(fixture.drive, location, first.nextCursor);
    expect(second.nextCursor).not.toBeNull();

    vi.mocked(fixture.drive.file).mockImplementation(async (id: string) => {
      if (id === "year") return { ...year, parentId: "outside" };
      const item = [month, supplier].find((candidate) => candidate.id === id);
      if (!item) throw new StorageError("STORAGE_MISSING", "missing");
      return { ...item };
    });
    await expect(traverseDocumentInbox(fixture.drive, location, second.nextCursor)).rejects.toMatchObject({
      code: "STORAGE_FOLDER_BOUNDARY",
    });
  });

  it("fails explicitly instead of silently starving folders beyond the resumable queue", async () => {
    const values = Array.from({ length: 300 }, (_, index) => folder(`folder-${index}`, "inbox"));
    const fixture = driveFixture(values);
    await expect(traverseDocumentInbox(fixture.drive, location, null)).rejects.toMatchObject({
      code: "STORAGE_FOLDER_LIMIT",
    });
  });

  it("refreshes renamed folder segments before emitting a resumed source path", async () => {
    vi.stubEnv("DOCUMENT_INBOX_MAX_DEPTH", "1");
    vi.stubEnv("DOCUMENT_INBOX_MAX_PROVIDER_CALLS", "2");
    const child = folder("child", "inbox", "Original");
    const fixture = driveFixture([child, file("invoice", "child", "Invoice.pdf")]);
    const queued = await traverseDocumentInbox(fixture.drive, location, null);
    expect(queued.nextCursor).not.toBeNull();

    vi.mocked(fixture.drive.file).mockResolvedValueOnce({ ...child, name: "Renamed" });
    const resumed = await traverseDocumentInbox(fixture.drive, location, queued.nextCursor);
    expect(resumed.files[0]?.sourcePath).toBe("Renamed/Invoice.pdf");
  });

  it("retains transiently throttled cursors and records missing nested folders", async () => {
    const child = folder("child", "inbox");
    const fixture = driveFixture([child]);
    vi.stubEnv("DOCUMENT_INBOX_MAX_DEPTH", "1");
    vi.stubEnv("DOCUMENT_INBOX_MAX_PROVIDER_CALLS", "2");
    const queued = await traverseDocumentInbox(fixture.drive, location, null);
    expect(queued.nextCursor).not.toBeNull();

    vi.mocked(fixture.drive.file).mockRejectedValueOnce(new StorageError("STORAGE_MISSING", "missing"));
    const missing = await traverseDocumentInbox(fixture.drive, location, queued.nextCursor);
    expect(missing).toMatchObject({ failed: 1, nextCursor: null });
    expect(missing.issues[0]).toMatchObject({ path: "child", code: "STORAGE_MISSING" });

    const throttledDrive = {
      file: vi.fn(),
      children: vi.fn().mockRejectedValue(new StorageError("STORAGE_THROTTLED", "retry")),
    } as unknown as CloudDrive;
    const throttled = await traverseDocumentInbox(throttledDrive, location, null);
    expect(throttled.failed).toBe(1);
    expect(throttled.nextCursor).not.toBeNull();
    expect(throttled.issues[0].code).toBe("STORAGE_THROTTLED");
  });

  it("can explicitly restart a saved traversal cursor", async () => {
    const values = Array.from({ length: 60 }, (_, index) => file(`f${index}`, "inbox"));
    const fixture = driveFixture(values);
    const first = await traverseDocumentInbox(fixture.drive, location, null);
    const restarted = await traverseDocumentInbox(fixture.drive, location, first.nextCursor, true);
    expect(restarted.files[0].file.id).toBe("f0");
  });

  it("rejects a provider-call budget that would strand reachable folders", async () => {
    vi.stubEnv("DOCUMENT_INBOX_MAX_DEPTH", "8");
    vi.stubEnv("DOCUMENT_INBOX_MAX_PROVIDER_CALLS", "8");
    const fixture = driveFixture([]);
    await expect(traverseDocumentInbox(fixture.drive, location, null)).rejects.toThrow(/MAX_DEPTH \+ 1/);
    expect(fixture.children).not.toHaveBeenCalled();
  });
});
