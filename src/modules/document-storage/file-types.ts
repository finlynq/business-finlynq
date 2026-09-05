import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { read } from "xlsx";
import { MAX_EVIDENCE_BYTES } from "@/modules/subledger/evidence-model";
import { StorageError, type CloudFile } from "./provider";

export const inboxUploadMimeTypeSchema = z.enum([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
  "text/tsv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/msexcel",
  "application/x-msexcel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
  "application/octet-stream",
]);

export type InboxDocumentFormat = "PDF" | "PNG" | "JPEG" | "CSV" | "TSV" | "TEXT" | "XLS" | "XLSX";
export type InboxFileSupport =
  | { supported: true; format: InboxDocumentFormat; canonicalMimeType: string }
  | { supported: false; code: string; reason: string };

const FORMAT_BY_EXTENSION: Record<string, {
  format: InboxDocumentFormat;
  canonicalMimeType: string;
  mimeTypes: ReadonlySet<string>;
}> = {
  pdf: { format: "PDF", canonicalMimeType: "application/pdf", mimeTypes: new Set(["application/pdf"]) },
  png: { format: "PNG", canonicalMimeType: "image/png", mimeTypes: new Set(["image/png"]) },
  jpg: { format: "JPEG", canonicalMimeType: "image/jpeg", mimeTypes: new Set(["image/jpeg", "image/jpg"]) },
  jpeg: { format: "JPEG", canonicalMimeType: "image/jpeg", mimeTypes: new Set(["image/jpeg", "image/jpg"]) },
  csv: { format: "CSV", canonicalMimeType: "text/csv", mimeTypes: new Set(["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"]) },
  tsv: { format: "TSV", canonicalMimeType: "text/tab-separated-values", mimeTypes: new Set(["text/tab-separated-values", "text/tsv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"]) },
  txt: { format: "TEXT", canonicalMimeType: "text/plain", mimeTypes: new Set(["text/plain", "application/octet-stream"]) },
  xls: { format: "XLS", canonicalMimeType: "application/vnd.ms-excel", mimeTypes: new Set(["application/vnd.ms-excel", "application/msexcel", "application/x-msexcel", "application/octet-stream"]) },
  xlsx: { format: "XLSX", canonicalMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", mimeTypes: new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "application/zip", "application/octet-stream"]) },
};

function extension(filename: string) {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename);
  return match?.[1].toLowerCase() ?? "";
}

function normalizedMimeType(mimeType: string) {
  return mimeType.split(";", 1)[0].trim().toLowerCase();
}

export function classifyInboxFile(file: Pick<CloudFile, "folder" | "shortcut" | "name" | "mimeType" | "size">): InboxFileSupport {
  if (file.folder || file.shortcut || file.mimeType === "application/vnd.google-apps.shortcut") {
    return { supported: false, code: "STORAGE_SHORTCUT_SKIPPED", reason: "Provider shortcuts and folders are not documents and are not ingested." };
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    return { supported: false, code: "STORAGE_EMPTY_FILE", reason: "The document is empty. Add a non-empty file and sync again." };
  }
  if (file.size > MAX_EVIDENCE_BYTES) {
    return { supported: false, code: "STORAGE_TOO_LARGE", reason: `The document exceeds the ${MAX_EVIDENCE_BYTES} byte (2 MiB) inbox limit.` };
  }
  if (file.name.length < 1 || file.name.length > 180 || /[\\/\p{Cc}\p{Cf}]/u.test(file.name) || file.name === "." || file.name === "..") {
    return { supported: false, code: "STORAGE_FILENAME_INVALID", reason: "The filename must contain 1 to 180 safe characters." };
  }
  const definition = FORMAT_BY_EXTENSION[extension(file.name)];
  if (!definition) {
    return { supported: false, code: "STORAGE_EXTENSION_UNSUPPORTED", reason: "Use PDF, PNG, JPEG, CSV, TSV, TXT, XLS, or XLSX files of up to 2 MiB." };
  }
  const mimeType = normalizedMimeType(file.mimeType);
  if (!definition.mimeTypes.has(mimeType)) {
    return { supported: false, code: "STORAGE_MIME_MISMATCH", reason: `The .${extension(file.name)} filename does not match the provider MIME type. Correct the filename or export the file again.` };
  }
  return { supported: true, format: definition.format, canonicalMimeType: definition.canonicalMimeType };
}

export function decodeStructuredText(bytes: Buffer): { text: string; encoding: "UTF-8" | "UTF-8-BOM" | "UTF-16LE" | "UTF-16BE" } {
  let encoding: "UTF-8" | "UTF-8-BOM" | "UTF-16LE" | "UTF-16BE" = "UTF-8";
  let label = "utf-8";
  let content = bytes;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    encoding = "UTF-8-BOM";
    content = bytes.subarray(3);
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    encoding = "UTF-16LE";
    label = "utf-16le";
    content = bytes.subarray(2);
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    encoding = "UTF-16BE";
    label = "utf-16be";
    content = bytes.subarray(2);
  }
  let text: string;
  try {
    text = new TextDecoder(label, { fatal: true }).decode(content);
  } catch {
    throw new StorageError("STORAGE_TEXT_ENCODING", "Text files must use valid UTF-8, UTF-8 with BOM, UTF-16LE with BOM, or UTF-16BE with BOM encoding.");
  }
  if (!text || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw new StorageError("STORAGE_TEXT_BINARY", "The text file contains binary or unsupported control characters.");
  }
  if (/^\s*(?:MZ|\x7fELF|%PDF-|<!doctype\s+html|<html\b|<script\b|<\?xml\b)/iu.test(text)) {
    throw new StorageError("STORAGE_TYPE_MISMATCH", "The file content does not match a safe CSV, TSV, or plain-text document.");
  }
  return { text, encoding };
}

function preflightXlsx(bytes: Buffer) {
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new StorageError("STORAGE_TYPE_MISMATCH", "The XLSX filename and MIME type do not match an Office Open XML workbook.");
  }
  const minimum = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) throw new StorageError("STORAGE_WORKBOOK_MALFORMED", "The XLSX central directory is missing or malformed.");
  const entries = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (entries < 2 || entries > 512 || directoryOffset + directorySize > eocd || directorySize > 2 * 1024 * 1024) {
    throw new StorageError("STORAGE_WORKBOOK_LIMIT", "The XLSX archive exceeds the 512-entry or 16 MiB expanded-content limit.");
  }
  let offset = directoryOffset;
  let expanded = 0;
  let contentTypes = false;
  let workbook = false;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new StorageError("STORAGE_WORKBOOK_MALFORMED", "The XLSX central directory is malformed.");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || compressed === 0xffffffff || uncompressed === 0xffffffff || (flags & 1) !== 0 || ![0, 8].includes(method)) {
      throw new StorageError("STORAGE_WORKBOOK_UNSAFE", "Encrypted, ZIP64, or unsupported XLSX archive entries are not accepted.");
    }
    expanded += uncompressed;
    if (uncompressed > 8 * 1024 * 1024 || expanded > 16 * 1024 * 1024) {
      throw new StorageError("STORAGE_WORKBOOK_LIMIT", "The XLSX archive exceeds the 512-entry or 16 MiB expanded-content limit.");
    }
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
      throw new StorageError("STORAGE_WORKBOOK_UNSAFE", "The XLSX archive contains an unsafe entry path.");
    }
    const lower = name.toLowerCase();
    if (lower === "[content_types].xml") contentTypes = true;
    if (lower === "xl/workbook.xml") workbook = true;
    if (lower.includes("vbaproject") || lower.startsWith("xl/externallinks/")) {
      throw new StorageError("STORAGE_WORKBOOK_UNSAFE", "Macro-enabled workbooks and workbook-level external links are not accepted. Save a values-only XLSX file.");
    }
    offset = next;
  }
  if (!contentTypes || !workbook || offset !== directoryOffset + directorySize) {
    throw new StorageError("STORAGE_WORKBOOK_MALFORMED", "The archive is not a complete XLSX workbook.");
  }
}

function preflightWorkbook(bytes: Buffer) {
  try {
    const workbook = read(bytes, {
      type: "buffer",
      bookSheets: true,
      bookProps: true,
      bookDeps: false,
      bookFiles: false,
      bookVBA: true,
      WTF: false,
    });
    if (!workbook.SheetNames.length) {
      throw new StorageError("STORAGE_WORKBOOK_MALFORMED", "The workbook contains no worksheets.");
    }
    if (workbook.SheetNames.length > 100) {
      throw new StorageError("STORAGE_WORKBOOK_LIMIT", "Workbooks may contain at most 100 worksheets.");
    }
    if (workbook.vbaraw) {
      throw new StorageError("STORAGE_WORKBOOK_UNSAFE", "Macro-enabled workbooks are not accepted. Save a values-only workbook.");
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("STORAGE_WORKBOOK_MALFORMED", "The workbook is malformed, encrypted, or uses an unsupported Excel feature.");
  }
}

export function validateInboxDocumentBytes(filename: string, mimeType: string, bytes: Buffer) {
  const support = classifyInboxFile({ folder: false, name: filename, mimeType, size: bytes.length });
  if (!support.supported) throw new StorageError(support.code, support.reason);
  const signatures: Partial<Record<InboxDocumentFormat, boolean>> = {
    PDF: /^%PDF-(?:1\.[0-9]|2\.0)/.test(bytes.subarray(0, 8).toString("ascii")),
    PNG: bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
    JPEG: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    XLS: bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")),
  };
  if (support.format === "XLSX") {
    preflightXlsx(bytes);
    preflightWorkbook(bytes);
  }
  else if (["CSV", "TSV", "TEXT"].includes(support.format)) decodeStructuredText(bytes);
  else {
    if (!signatures[support.format]) throw new StorageError("STORAGE_TYPE_MISMATCH", "The filename, MIME type, and file signature do not agree.");
    if (support.format === "XLS") preflightWorkbook(bytes);
  }
  return support;
}

export function decodeInboxUpload(input: {
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  contentBase64: string;
}) {
  const bytes = Buffer.from(input.contentBase64, "base64");
  if (bytes.length !== input.byteSize || bytes.toString("base64") !== input.contentBase64) {
    bytes.fill(0);
    throw new StorageError("STORAGE_UPLOAD_ENCODING", "The upload byte size or base64 encoding is invalid.");
  }
  const actual = createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(input.sha256, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
    bytes.fill(0);
    throw new StorageError("STORAGE_UPLOAD_CHECKSUM", "The upload checksum does not match.");
  }
  try {
    return { bytes, ...validateInboxDocumentBytes(input.filename, input.mimeType, bytes) };
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}
