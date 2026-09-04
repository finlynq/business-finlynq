import "server-only";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { StorageProvider } from "./model";
import { MAX_EVIDENCE_BYTES } from "@/modules/subledger/evidence-model";

const GOOGLE = "https://www.googleapis.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const id = z.string().min(1).max(512);
export const locationSchema = z.object({
  accountId: id, driveId: z.string().max(512), rootId: id, inboxId: id, archiveId: id,
  inboxUrl: z.string().url(), archiveUrl: z.string().url(),
});
export type StorageLocation = z.infer<typeof locationSchema>;
export const credentialSchema = z.object({ accessToken: z.string().min(1).max(20000), refreshToken: z.string().min(1).max(20000), expiresAt: z.number() });
export type StorageCredentials = z.infer<typeof credentialSchema>;
export type CloudFile = { id: string; name: string; mimeType: string; size: number; version: string; etag?: string; parentId: string; driveId?: string; folder: boolean };

export class StorageError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "StorageError"; }
}
export async function boundedResponse(response: Response, maximum: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > maximum) {
    await response.body?.cancel(); throw new StorageError("STORAGE_TOO_LARGE", "Document exceeds the supported size.");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > maximum) throw new StorageError("STORAGE_TOO_LARGE", "Document exceeds the supported size.");
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => undefined); for (const chunk of chunks) chunk.fill(0); }
}
async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    const code = response.status === 401 || response.status === 403 ? "STORAGE_RECONNECT" : response.status === 404 ? "STORAGE_MISSING" : "STORAGE_PROVIDER_FAILED";
    throw new StorageError(code, code === "STORAGE_RECONNECT" ? "Reconnect storage or check the account's folder permissions." : code === "STORAGE_MISSING" ? "The cloud file or folder is unavailable." : "The storage provider could not complete this request. Retry later.");
  }
  const bytes = await boundedResponse(response, 1024 * 1024);
  try { return JSON.parse(bytes.toString("utf8")); } finally { bytes.fill(0); }
}
function secret(name: string) {
  const file = process.env[`${name}_FILE`]?.trim();
  const inline = process.env[name]?.trim();
  if (file && inline) throw new Error(`Configure only one ${name} source`);
  if (inline && process.env.NODE_ENV === "production") throw new Error(`Production requires ${name}_FILE`);
  return file ? readFileSync(file, "utf8").trim() : inline;
}
export function providerConfiguration(provider: StorageProvider) {
  const prefix = provider === "GOOGLE_DRIVE" ? "DOCUMENT_GOOGLE" : "DOCUMENT_MICROSOFT";
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = secret(`${prefix}_CLIENT_SECRET`);
  const origin = process.env.BUSINESS_FINLYNQ_PUBLIC_URL?.trim() || process.env.APP_ORIGIN?.trim();
  if (!clientId || !clientSecret || !origin) throw new StorageError("STORAGE_NOT_CONFIGURED", "This storage provider is not configured by the operator.");
  const base = new URL(origin);
  if (base.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(base.hostname))) throw new Error("Storage OAuth requires an HTTPS application origin");
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("Storage OAuth origin must contain only scheme and host");
  return { clientId, clientSecret, redirectUri: new URL(`/api/document-storage/callback/${provider}`, base).href,
    authorizationUrl: provider === "GOOGLE_DRIVE" ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: provider === "GOOGLE_DRIVE" ? "https://oauth2.googleapis.com/token" : "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: provider === "GOOGLE_DRIVE" ? "https://www.googleapis.com/auth/drive" : "offline_access Files.ReadWrite.AppFolder",
  };
}
export function configuredProviders() {
  return (["GOOGLE_DRIVE", "ONEDRIVE"] as const).map((provider) => {
    try { providerConfiguration(provider); return { provider, configured: true }; }
    catch { return { provider, configured: false }; }
  });
}
export async function exchangeStorageToken(provider: StorageProvider, input: { code: string; verifier: string } | { refreshToken: string }): Promise<StorageCredentials> {
  const config = providerConfiguration(provider);
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret });
  if ("code" in input) {
    body.set("grant_type", "authorization_code"); body.set("code", input.code);
    body.set("code_verifier", input.verifier); body.set("redirect_uri", config.redirectUri);
  } else { body.set("grant_type", "refresh_token"); body.set("refresh_token", input.refreshToken); }
  if (provider === "ONEDRIVE") body.set("scope", config.scope);
  const response = await fetch(config.tokenUrl, {
    method: "POST", body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const bytes = await boundedResponse(response, 64 * 1024);
    let code: unknown;
    try { code = JSON.parse(bytes.toString("utf8"))?.error; } catch { /* Never render provider error text. */ }
    finally { bytes.fill(0); }
    if (["invalid_grant", "interaction_required", "consent_required"].includes(String(code))) throw new StorageError("STORAGE_RECONNECT", "Cloud authorization expired or was revoked. Reconnect the original account in Document storage.");
    if (code === "invalid_client") throw new StorageError("STORAGE_NOT_CONFIGURED", "The storage application's credentials need to be updated by the operator.");
    throw new StorageError("STORAGE_PROVIDER_FAILED", "The storage provider could not renew authorization. Retry later or reconnect the original account.");
  }
  const result = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number().positive().max(86400), scope: z.string().optional() }).parse(await jsonResponse(response));
  if (result.scope && !result.scope.split(/\s+/).some((scope) => provider === "GOOGLE_DRIVE" ? scope === config.scope : scope === "Files.ReadWrite.AppFolder" || scope.endsWith("/Files.ReadWrite.AppFolder"))) {
    throw new StorageError("STORAGE_SCOPE_MISSING", "The required storage permission was not granted.");
  }
  if (provider === "ONEDRIVE" && result.scope?.split(/\s+/).some((scope) => {
    const name = scope.replace(/^https:\/\/graph.microsoft.com\//, "");
    return /^(Files|Sites)\./.test(name) && name !== "Files.ReadWrite.AppFolder";
  })) throw new StorageError("STORAGE_SCOPE_EXCESSIVE", "Microsoft returned broader file permissions than this connection supports. Remove the previous app grant and reconnect with app-folder access only.");
  return credentialSchema.parse({ accessToken: result.access_token,
    refreshToken: result.refresh_token ?? ("refreshToken" in input ? input.refreshToken : undefined), expiresAt: Date.now() + result.expires_in * 1000 });
}

const googleFileSchema = z.object({ id, name: z.string().max(1000), mimeType: z.string(), size: z.string().optional(),
  md5Checksum: z.string().optional(), version: z.string().optional(), parents: z.array(z.string()).optional(), trashed: z.boolean().optional() });
const graphFileSchema = z.object({ id, name: z.string().max(1000), size: z.number().nonnegative().safe(), eTag: z.string().optional(), cTag: z.string().optional(),
  file: z.object({ mimeType: z.string() }).optional(), folder: z.object({}).passthrough().optional(),
  parentReference: z.object({ id: z.string().optional(), driveId: z.string().optional() }).optional(), deleted: z.unknown().optional(), remoteItem: z.unknown().optional() });
const googleFields = "id,name,mimeType,size,md5Checksum,version,parents,trashed";
const graphFields = "id,name,size,eTag,cTag,file,folder,parentReference,deleted,remoteItem";
function googleFile(raw: unknown): CloudFile {
  const f = googleFileSchema.parse(raw);
  if (f.trashed) throw new StorageError("STORAGE_MISSING", "The file is in the trash.");
  return { id: f.id, name: f.name, mimeType: f.mimeType, size: z.number().safe().nonnegative().parse(Number(f.size ?? 0)),
    version: f.md5Checksum ?? f.version ?? "folder", parentId: f.parents?.[0] ?? "", folder: f.mimeType === "application/vnd.google-apps.folder" };
}
function graphFile(raw: unknown): CloudFile {
  const f = graphFileSchema.parse(raw);
  if (f.deleted) throw new StorageError("STORAGE_MISSING", "The file was deleted.");
  if (f.remoteItem) throw new StorageError("STORAGE_FOLDER_BOUNDARY", "Shared shortcuts and remote drive items cannot be used as connected folders or documents.");
  return { id: f.id, name: f.name, mimeType: f.file?.mimeType ?? "folder", size: f.size, version: f.cTag ?? f.eTag ?? "folder",
    etag: f.eTag, parentId: f.parentReference?.id ?? "", driveId: f.parentReference?.driveId, folder: Boolean(f.folder) };
}
function escapedQuery(value: string) { return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
export class CloudDrive {
  constructor(readonly provider: StorageProvider, private readonly token: string, readonly driveId = "") {}
  private async request(path: string, init: RequestInit = {}) {
    const base = this.provider === "GOOGLE_DRIVE" ? GOOGLE : GRAPH;
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid storage path");
    return fetch(base + path, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...init.headers },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000) });
  }
  private graphPath() { return this.driveId ? `/drives/${encodeURIComponent(this.driveId)}` : "/me/drive"; }
  private parseFile(raw: unknown): CloudFile {
    const file = this.provider === "GOOGLE_DRIVE" ? googleFile(raw) : graphFile(raw);
    if (this.provider === "ONEDRIVE" && this.driveId && file.driveId !== this.driveId) throw new StorageError("STORAGE_FOLDER_BOUNDARY", "The provider returned an item from a different or unidentified drive.");
    return file;
  }
  async appFolder() {
    if (this.provider !== "ONEDRIVE") throw new Error("App-folder access is only available for OneDrive");
    const file = graphFile(await jsonResponse(await this.request("/me/drive/special/approot")));
    if (!file.folder || !file.driveId) throw new StorageError("STORAGE_FOLDER_BOUNDARY", "The OneDrive application folder is unavailable.");
    return file;
  }
  async file(fileId: string): Promise<CloudFile> {
    const path = this.provider === "GOOGLE_DRIVE" ? `/drive/v3/files/${encodeURIComponent(fileId)}?fields=${googleFields}` : `${this.graphPath()}/items/${encodeURIComponent(fileId)}?$select=${graphFields}`;
    const raw = await jsonResponse(await this.request(path));
    const file = this.parseFile(raw);
    if (file.id !== fileId) throw new StorageError("STORAGE_FOLDER_BOUNDARY", "The provider returned a different document or folder.");
    return file;
  }
  async children(folderId: string, cursor?: string | null): Promise<{ files: CloudFile[]; cursor: string | null }> {
    if (this.provider === "GOOGLE_DRIVE") {
      const query = new URLSearchParams({ q: `'${escapedQuery(folderId)}' in parents and trashed = false`, pageSize: "50", fields: `nextPageToken,files(${googleFields})`, orderBy: "createdTime" });
      if (cursor) query.set("pageToken", cursor);
      const raw = z.object({ files: z.array(z.unknown()), nextPageToken: z.string().optional() }).parse(await jsonResponse(await this.request(`/drive/v3/files?${query}`)));
      return { files: raw.files.map(googleFile), cursor: raw.nextPageToken ?? null };
    }
    const path = `${this.graphPath()}/items/${encodeURIComponent(folderId)}/children`;
    let next = `${path}?$top=50&$select=${graphFields}`;
    if (cursor) {
      const url = new URL(cursor);
      if (url.origin !== "https://graph.microsoft.com" || url.pathname !== `/v1.0${path}` || url.username || url.password || url.hash) throw new StorageError("STORAGE_CURSOR_INVALID", "Restart inbox sync after reconnecting storage.");
      next = path + url.search;
    }
    const raw = z.object({ value: z.array(z.unknown()), "@odata.nextLink": z.string().optional() }).parse(await jsonResponse(await this.request(next)));
    return { files: raw.value.map((file) => this.parseFile(file)), cursor: raw["@odata.nextLink"] ?? null };
  }
  async folder(parentId: string, name: string): Promise<string> {
    if (this.provider === "GOOGLE_DRIVE") {
      const query = new URLSearchParams({ q: `'${escapedQuery(parentId)}' in parents and name = '${escapedQuery(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: "files(id)", pageSize: "2" });
      const listed = z.object({ files: z.array(z.object({ id })) }).parse(await jsonResponse(await this.request(`/drive/v3/files?${query}`)));
      if (listed.files.length > 1) throw new StorageError("STORAGE_FOLDER_AMBIGUOUS", "Multiple matching archive folders exist. Resolve them in Drive.");
      if (listed.files[0]) return listed.files[0].id;
      const created = await jsonResponse(await this.request("/drive/v3/files?fields=id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }) }));
      return z.object({ id }).parse(created).id;
    }
    const lookup = `${this.graphPath()}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}`;
    const found = await this.request(lookup);
    if (found.ok) {
      const folder = this.parseFile(await jsonResponse(found));
      if (!folder.folder) throw new StorageError("STORAGE_FOLDER_CONFLICT", "An archive folder name is already used by a file.");
      if (folder.parentId !== parentId) throw new StorageError("STORAGE_FOLDER_BOUNDARY", "The archive folder moved outside its expected parent.");
      return folder.id;
    }
    if (found.status !== 404) await jsonResponse(found);
    await found.body?.cancel();
    const created = await this.request(`${this.graphPath()}/items/${encodeURIComponent(parentId)}/children`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }) });
    let folder: CloudFile;
    if (created.status === 409) { await created.body?.cancel(); folder = this.parseFile(await jsonResponse(await this.request(lookup))); }
    else { folder = this.parseFile(await jsonResponse(created)); }
    if (!folder.folder || folder.parentId !== parentId) throw new StorageError("STORAGE_FOLDER_BOUNDARY", "The provider returned a folder outside its expected parent.");
    return folder.id;
  }
  async provision(companyName: string, existing?: StorageLocation): Promise<StorageLocation> {
    let accountId: string; let driveId = ""; let baseId = "root";
    if (this.provider === "GOOGLE_DRIVE") {
      accountId = z.object({ user: z.object({ permissionId: id }) }).parse(await jsonResponse(await this.request("/drive/v3/about?fields=user(permissionId)"))).user.permissionId;
    } else {
      const root = await this.appFolder();
      baseId = root.id; driveId = id.parse(root.driveId); accountId = driveId;
    }
    if (existing) {
      if (existing.accountId !== accountId) throw new StorageError("STORAGE_ACCOUNT_MISMATCH", "Reconnect the original cloud account to keep existing attachments accessible.");
      return existing;
    }
    const drive = new CloudDrive(this.provider, this.token, driveId);
    const rootId = await drive.folder(baseId, companyName);
    const inboxId = await drive.folder(rootId, "Inbox");
    const archiveId = await drive.folder(rootId, "Archive");
    const link = (fileId: string) => this.provider === "GOOGLE_DRIVE" ? `https://drive.google.com/drive/folders/${encodeURIComponent(fileId)}` : `https://onedrive.live.com/?id=${encodeURIComponent(fileId)}&cid=${encodeURIComponent(driveId)}`;
    // Graph web URLs support both personal and work/school accounts.
    const webUrl = async (fileId: string) => {
      if (this.provider === "GOOGLE_DRIVE") return link(fileId);
      const raw = z.object({ webUrl: z.string().url() }).parse(await jsonResponse(await drive.request(`${drive.graphPath()}/items/${encodeURIComponent(fileId)}?$select=webUrl`)));
      const url = new URL(raw.webUrl);
      if (url.protocol !== "https:" || !(url.hostname === "onedrive.live.com" || url.hostname.endsWith(".sharepoint.com"))) throw new Error("Unexpected provider web URL");
      return url.href;
    };
    return { accountId, driveId, rootId, inboxId, archiveId, inboxUrl: await webUrl(inboxId), archiveUrl: await webUrl(archiveId) };
  }
  async download(fileId: string): Promise<Buffer> {
    if (this.provider === "GOOGLE_DRIVE") {
      const response = await this.request(`/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
      if (!response.ok) await jsonResponse(response);
      return boundedResponse(response, MAX_EVIDENCE_BYTES);
    }
    // Do not forward the Graph bearer token to the preauthenticated download host.
    const response = await fetch(`${GRAPH}${this.graphPath()}/items/${encodeURIComponent(fileId)}/content`, { headers: { Authorization: `Bearer ${this.token}` }, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (response.status !== 302) {
      if (!response.ok) await jsonResponse(response);
      return boundedResponse(response, MAX_EVIDENCE_BYTES);
    }
    const url = new URL(response.headers.get("location") ?? "");
    await response.body?.cancel();
    if (url.protocol !== "https:" || url.port || url.username || url.password || ![".sharepoint.com", ".1drv.com", ".storage.live.com", ".onedrive.com"].some((suffix) => url.hostname.endsWith(suffix))) throw new StorageError("STORAGE_DOWNLOAD_HOST", "The provider returned an unsupported download location.");
    const download = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!download.ok) await jsonResponse(download);
    return boundedResponse(download, MAX_EVIDENCE_BYTES);
  }
  async findUpload(folderId: string, stem: string): Promise<CloudFile | null> {
    if (!/^Upload-[a-f0-9]{64}$/.test(stem)) throw new Error("Invalid upload identifier");
    if (this.provider === "GOOGLE_DRIVE") {
      const names = ["pdf", "png", "jpg"].map((ext) => `name = '${stem}.${ext}'`).join(" or ");
      const q = new URLSearchParams({ q: `'${escapedQuery(folderId)}' in parents and trashed=false and (${names})`, fields: `files(${googleFields})`, pageSize: "2" });
      const raw = z.object({ files: z.array(z.unknown()) }).parse(await jsonResponse(await this.request(`/drive/v3/files?${q}`)));
      if (raw.files.length > 1) throw new StorageError("STORAGE_UPLOAD_CONFLICT", "Multiple files match this upload. Review the cloud inbox.");
      return raw.files[0] ? googleFile(raw.files[0]) : null;
    }
    for (const extension of ["pdf", "png", "jpg"]) {
      const response = await this.request(`${this.graphPath()}/items/${encodeURIComponent(folderId)}:/${stem}.${extension}`);
      if (response.status === 404) { await response.body?.cancel(); continue; }
      return this.parseFile(await jsonResponse(response));
    }
    return null;
  }
  async upload(folderId: string, name: string, mimeType: string, bytes: Buffer): Promise<CloudFile> {
    if (bytes.length > MAX_EVIDENCE_BYTES) throw new StorageError("STORAGE_TOO_LARGE", "Document exceeds the supported size.");
    if (this.provider === "ONEDRIVE") {
      const query = new URLSearchParams({ "@microsoft.graph.conflictBehavior": "fail" });
      return this.parseFile(await jsonResponse(await this.request(`${this.graphPath()}/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(name)}:/content?${query}`, {
        method: "PUT", headers: { "Content-Type": mimeType }, body: new Uint8Array(bytes),
      })));
    }
    const boundary = `finlynq_${crypto.randomUUID()}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--`)]);
    try { return googleFile(await jsonResponse(await this.request(`/upload/drive/v3/files?uploadType=multipart&fields=${googleFields}`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body) }))); }
    finally { body.fill(0); }
  }
  async move(file: CloudFile, folderId: string, name: string) {
    if (!name || /[\\/\x00-\x1f]/.test(name)) throw new Error("Invalid archive name");
    if (this.provider === "GOOGLE_DRIVE") {
      const query = new URLSearchParams({ fields: googleFields });
      if (file.parentId !== folderId) { query.set("addParents", folderId); query.set("removeParents", file.parentId); }
      return googleFile(await jsonResponse(await this.request(`/drive/v3/files/${encodeURIComponent(file.id)}?${query}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })));
    }
    return this.parseFile(await jsonResponse(await this.request(`${this.graphPath()}/items/${encodeURIComponent(file.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...(file.etag ? { "If-Match": file.etag } : {}) }, body: JSON.stringify({ name, parentReference: { id: folderId }, "@microsoft.graph.conflictBehavior": "fail" }) })));
  }
}
