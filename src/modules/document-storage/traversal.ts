import "server-only";

import { z } from "zod";
import { StorageError, type CloudDrive, type CloudFile, type StorageLocation } from "./provider";
import { assertDirectChild } from "./boundaries";

const CURSOR_PREFIX = "finlynq-inbox-v1:";
const MAX_CURSOR_BYTES = 64 * 1024;
const MAX_FOLDER_QUEUE = 256;
const MAX_SEEN_FOLDERS = 512;
export const INBOX_SYNC_FILE_LIMIT = 50;

const folderTaskSchema = z.object({
  id: z.string().min(1).max(512),
  parentId: z.string().min(1).max(512),
  ancestorIds: z.array(z.string().min(1).max(512)).max(15),
  path: z.string().max(1800),
  depth: z.number().int().min(0).max(16),
  cursor: z.string().max(16_384).nullable(),
}).strict().superRefine((task, context) => {
  if (task.ancestorIds.length !== task.depth
    || (task.depth > 0 && task.ancestorIds.at(-1) !== task.parentId)) {
    context.addIssue({ code: "custom", message: "Folder ancestry does not match its traversal depth." });
  }
});
const traversalStateSchema = z.object({
  version: z.literal(1),
  inboxId: z.string().min(1).max(512),
  folders: z.array(folderTaskSchema).max(MAX_FOLDER_QUEUE),
  seenFolderIds: z.array(z.string().min(1).max(512)).max(MAX_SEEN_FOLDERS),
}).strict();
type FolderTask = z.infer<typeof folderTaskSchema>;
type TraversalState = z.infer<typeof traversalStateSchema>;

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}
export function inboxTraversalPolicy() {
  const maximumDepth = boundedInteger("DOCUMENT_INBOX_MAX_DEPTH", 8, 1, 15);
  const maximumProviderCalls = boundedInteger("DOCUMENT_INBOX_MAX_PROVIDER_CALLS", 10, 2, 20);
  if (maximumProviderCalls <= maximumDepth) {
    throw new Error("DOCUMENT_INBOX_MAX_PROVIDER_CALLS must be at least DOCUMENT_INBOX_MAX_DEPTH + 1");
  }
  return {
    maximumDepth,
    maximumProviderCalls,
    maximumFiles: INBOX_SYNC_FILE_LIMIT,
  };
}

function rootState(location: StorageLocation, legacyCursor: string | null = null): TraversalState {
  return {
    version: 1,
    inboxId: location.inboxId,
    folders: [{ id: location.inboxId, parentId: location.rootId, ancestorIds: [], path: "", depth: 0, cursor: legacyCursor }],
    seenFolderIds: [location.inboxId],
  };
}
function parseState(raw: string | null, location: StorageLocation, restart: boolean): TraversalState {
  if (restart || !raw) return rootState(location);
  if (!raw.startsWith(CURSOR_PREFIX)) return rootState(location, raw);
  try {
    const encoded = raw.slice(CURSOR_PREFIX.length);
    if (!encoded || encoded.length > MAX_CURSOR_BYTES * 2) throw new Error("cursor length");
    const json = Buffer.from(encoded, "base64url");
    if (json.length > MAX_CURSOR_BYTES) throw new Error("cursor length");
    const state = traversalStateSchema.parse(JSON.parse(json.toString("utf8")));
    if (state.inboxId !== location.inboxId || !state.folders.length) throw new Error("cursor root");
    return state;
  } catch {
    throw new StorageError("STORAGE_CURSOR_INVALID", "The saved inbox traversal cursor is invalid. Restart the sync.");
  }
}
function serializeState(state: TraversalState | null) {
  if (!state) return null;
  const raw = Buffer.from(JSON.stringify(traversalStateSchema.parse(state)), "utf8");
  if (raw.length > MAX_CURSOR_BYTES) throw new StorageError("STORAGE_CURSOR_LIMIT", "The nested inbox contains too many folders for one traversal. Reduce its breadth or depth.");
  return CURSOR_PREFIX + raw.toString("base64url");
}
function safeSegment(name: string) {
  return name.normalize("NFKC").replace(/[\\/\p{Cc}\p{Cf}]+/gu, "-").replace(/^\.+|\.+$/g, "").trim().slice(0, 120) || "Folder";
}
function childPath(parent: string, name: string) {
  const path = parent ? `${parent}/${safeSegment(name)}` : safeSegment(name);
  if (path.length > 1800) throw new StorageError("STORAGE_PATH_LIMIT", "A nested inbox path exceeds the supported 1,800-character folder-path limit.");
  return path;
}
function filePath(folder: FolderTask, file: CloudFile) {
  const name = safeSegment(file.name);
  return folder.path ? `${folder.path}/${name}` : name;
}
function issue(path: string, code: string) {
  return { path: path || ".", code };
}

async function validateQueuedFolder(drive: CloudDrive, location: StorageLocation, task: FolderTask): Promise<string> {
  if (task.depth === 0) {
    if (task.id !== location.inboxId || task.parentId !== location.rootId || task.ancestorIds.length) {
      throw new StorageError("STORAGE_FOLDER_BOUNDARY", "The saved inbox traversal root is invalid. Restart the sync.");
    }
    return "";
  }
  if (task.ancestorIds[0] !== location.inboxId) {
    throw new StorageError("STORAGE_FOLDER_BOUNDARY", "A queued folder is no longer within the connected Inbox.");
  }
  const folders = [task.id, ...task.ancestorIds.slice(1).reverse()];
  const parents = task.ancestorIds.slice().reverse();
  const names: string[] = [];
  for (let index = 0; index < folders.length; index += 1) {
    const folder = await drive.file(folders[index]);
    if (folder.id !== folders[index] || !folder.folder || folder.shortcut || folder.parentId !== parents[index]) {
      throw new StorageError("STORAGE_FOLDER_BOUNDARY", "A queued inbox folder moved outside its expected path. Restart after restoring the folder.");
    }
    names.push(folder.name);
  }
  return names.reverse().reduce((path, name) => childPath(path, name), "");
}

export type TraversedInboxFile = { file: CloudFile; sourcePath: string; sourceFolderId: string; sourceDepth: number };
export type InboxTraversalResult = {
  files: TraversedInboxFile[];
  nextCursor: string | null;
  skipped: number;
  failed: number;
  issues: Array<{ path: string; code: string }>;
  providerCalls: number;
};

export async function traverseDocumentInbox(drive: CloudDrive, location: StorageLocation, rawCursor: string | null, restart = false): Promise<InboxTraversalResult> {
  const policy = inboxTraversalPolicy();
  const state = parseState(rawCursor, location, restart);
  const seen = new Set(state.seenFolderIds);
  const files: TraversedInboxFile[] = [];
  const issues: Array<{ path: string; code: string }> = [];
  let skipped = 0;
  let failed = 0;
  let providerCalls = 0;

  while (state.folders.length && providerCalls < policy.maximumProviderCalls && files.length < policy.maximumFiles) {
    const current = state.folders[0];
    if (current.depth > 0) {
      // Revalidate the complete saved path (excluding the Inbox, which the
      // caller validates immediately before traversal) on every resumed
      // folder. This detects moved ancestors without exceeding the request's
      // configured provider-call budget.
      if (providerCalls + current.depth + 1 > policy.maximumProviderCalls) break;
      try {
        current.path = await validateQueuedFolder(drive, location, current);
        providerCalls += current.depth;
      } catch (error) {
        providerCalls += current.depth;
        if (!(error instanceof StorageError)) throw error;
        if (error.code === "STORAGE_MISSING") {
          failed += 1;
          if (issues.length < 10) issues.push(issue(current.path, error.code));
          state.folders.shift();
          continue;
        }
        if (error.code === "STORAGE_THROTTLED" || error.code === "STORAGE_PROVIDER_FAILED") {
          failed += 1;
          if (issues.length < 10) issues.push(issue(current.path, error.code));
          break;
        }
        throw error;
      }
    }

    let page: Awaited<ReturnType<CloudDrive["children"]>>;
    try {
      page = await drive.children(current.id, current.cursor);
      providerCalls += 1;
    } catch (error) {
      providerCalls += 1;
      if (!(error instanceof StorageError) || current.depth === 0 && !["STORAGE_CURSOR_INVALID", "STORAGE_THROTTLED", "STORAGE_PROVIDER_FAILED"].includes(error.code)) throw error;
      if (error.code === "STORAGE_CURSOR_INVALID") current.cursor = null;
      else if (error.code === "STORAGE_MISSING" && current.depth > 0) state.folders.shift();
      else if (!["STORAGE_THROTTLED", "STORAGE_PROVIDER_FAILED"].includes(error.code)) throw error;
      failed += 1;
      if (issues.length < 10) issues.push(issue(current.path, error.code));
      break;
    }
    if (page.files.length > 50) throw new StorageError("STORAGE_PROVIDER_FAILED", "The storage provider returned more than 50 children in one bounded page.");

    let pageFiles = 0;
    for (const file of page.files) {
      assertDirectChild(file, current.id);
      if (file.shortcut || file.mimeType === "application/vnd.google-apps.shortcut") {
        skipped += 1;
        if (issues.length < 10) issues.push(issue(filePath(current, file), "STORAGE_SHORTCUT_SKIPPED"));
        continue;
      }
      if (file.folder) {
        if ([location.rootId, location.inboxId, location.archiveId].includes(file.id) || seen.has(file.id)) {
          skipped += 1;
          if (issues.length < 10) issues.push(issue(childPath(current.path, file.name), "STORAGE_FOLDER_CYCLE_SKIPPED"));
          continue;
        }
        if (current.depth >= policy.maximumDepth) {
          skipped += 1;
          if (issues.length < 10) issues.push(issue(childPath(current.path, file.name), "STORAGE_DEPTH_LIMIT"));
          continue;
        }
        if (state.folders.length >= MAX_FOLDER_QUEUE || seen.size >= MAX_SEEN_FOLDERS) {
          throw new StorageError(
            "STORAGE_FOLDER_LIMIT",
            "The nested inbox contains too many folders for a safe resumable scan. Reduce its breadth or depth and restart the sync.",
          );
        }
        seen.add(file.id);
        state.seenFolderIds.push(file.id);
        state.folders.push({
          id: file.id,
          parentId: current.id,
          ancestorIds: [...current.ancestorIds, current.id],
          path: childPath(current.path, file.name),
          depth: current.depth + 1,
          cursor: null,
        });
        continue;
      }
      if (files.length >= policy.maximumFiles) break;
      files.push({ file, sourcePath: filePath(current, file), sourceFolderId: current.id, sourceDepth: current.depth });
      pageFiles += 1;
    }

    if (page.cursor) current.cursor = page.cursor;
    else state.folders.shift();
    // A provider page contains at most 50 leaf files. Stop after the first page
    // containing files so a response never exceeds the documented file limit.
    if (pageFiles > 0) break;
  }

  const nextState = state.folders.length ? state : null;
  return { files, nextCursor: serializeState(nextState), skipped, failed, issues, providerCalls };
}
