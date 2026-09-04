import "server-only";
import { CloudDrive, StorageError, type CloudFile, type StorageLocation } from "./provider";

function outside() {
  return new StorageError("STORAGE_FOLDER_BOUNDARY", "A document or folder moved outside this connection's Inbox or Archive. Restore its location in your drive before continuing.");
}

export function assertDirectChild(file: CloudFile, folderId: string) {
  if (file.parentId !== folderId) throw outside();
}

// These checks supplement the provider grant. They do not turn broad OAuth
// scopes into folder-only grants, including for grandfathered Google accounts.
export async function assertStorageRoot(drive: CloudDrive, location: StorageLocation) {
  if (new Set([location.rootId, location.inboxId, location.archiveId]).size !== 3) throw outside();
  const root = await drive.file(location.rootId);
  if (!root.folder) throw outside();
  if (drive.provider === "ONEDRIVE") {
    const appFolder = await drive.appFolder();
    if (appFolder.driveId !== location.driveId || root.parentId !== appFolder.id) throw outside();
  }
}

export async function assertStorageFolder(drive: CloudDrive, location: StorageLocation, folderId: string, area: "inbox" | "archive" | "either") {
  await assertStorageRoot(drive, location);
  const seen = new Set<string>();
  let current = folderId;
  for (let depth = 0; depth < 16; depth += 1) {
    if (!current || current === location.rootId || seen.has(current)) throw outside();
    seen.add(current);
    const folder = await drive.file(current);
    if (!folder.folder) throw outside();
    if ((area !== "archive" && current === location.inboxId) || (area !== "inbox" && current === location.archiveId)) {
      assertDirectChild(folder, location.rootId);
      return;
    }
    // The inbox is a flat queue; only Archive has a generated subtree.
    if (area === "inbox" || current === location.inboxId || current === location.archiveId) throw outside();
    current = folder.parentId;
  }
  throw outside();
}

export async function assertStoredFile(drive: CloudDrive, location: StorageLocation, file: CloudFile) {
  if (file.folder) throw outside();
  await assertStorageFolder(drive, location, file.parentId, "either");
}
