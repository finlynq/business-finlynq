import "server-only";

import { createHash } from "node:crypto";
import { MAX_EVIDENCE_BYTES } from "@/modules/subledger/evidence-model";
import { inboxUploadMimeTypeSchema, validateInboxDocumentBytes, type InboxUploadMimeType } from "./file-types";
import { StorageError } from "./provider";

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_LINE_BYTES = 8 * 1024;
const MAX_MIME_DEPTH = 8;
const MAX_MIME_PARTS = 64;
const MAX_ATTACHMENTS = 20;
const MAX_DECODED_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_CHARACTERS = 100_000;

export type EmlAttachmentStatus =
  | "READY_TO_EXTRACT"
  | "INLINE_SKIPPED"
  | "DUPLICATE_SKIPPED"
  | "QUARANTINED";

export type EmlAttachmentPreview = Readonly<{
  index: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256?: string;
  disposition: "attachment" | "inline";
  status: EmlAttachmentStatus;
  errorCode?: string;
  reason?: string;
}>;

export type ExtractableEmlAttachment = Readonly<{
  index: number;
  filename: string;
  mimeType: InboxUploadMimeType;
  byteSize: number;
  sha256: string;
  bytes: Buffer;
}>;

export type ParsedEmlDocument = Readonly<{
  text: string;
  preview: Readonly<{
    from: string | null;
    subject: string | null;
    date: string | null;
    messageSha256: string;
    bodySha256: string;
    htmlConverted: boolean;
    bodyTruncated: boolean;
    attachments: readonly EmlAttachmentPreview[];
  }>;
  attachments: readonly ExtractableEmlAttachment[];
}>;

type Headers = Map<string, string[]>;
type ParserState = {
  parts: number;
  decodedBytes: number;
  attachmentIndex: number;
  attachmentHashes: Set<string>;
  plainBodies: string[];
  htmlBodies: string[];
  previews: EmlAttachmentPreview[];
  attachments: ExtractableEmlAttachment[];
};

function emlError(code: string, message: string): StorageError {
  return new StorageError(code, message);
}

function splitHeaderAndBody(bytes: Buffer): { header: Buffer; body: Buffer } {
  let separator = bytes.indexOf(Buffer.from("\r\n\r\n"));
  let length = 4;
  if (separator < 0) {
    separator = bytes.indexOf(Buffer.from("\n\n"));
    length = 2;
  }
  if (separator < 1) {
    throw emlError("STORAGE_EML_MALFORMED", "The email does not contain a complete RFC 5322 header block.");
  }
  if (separator > MAX_HEADER_BYTES) {
    throw emlError("STORAGE_EML_HEADER_LIMIT", "The email header block exceeds the 64 KiB safety limit.");
  }
  return { header: bytes.subarray(0, separator), body: bytes.subarray(separator + length) };
}

function parseHeaders(bytes: Buffer): Headers {
  if (bytes.includes(0) || /\r(?!\n)/u.test(bytes.toString("latin1"))) {
    throw emlError("STORAGE_EML_MALFORMED", "The email headers contain invalid control characters or line endings.");
  }
  const lines = bytes.toString("latin1").replace(/\r\n/g, "\n").split("\n");
  const unfolded: string[] = [];
  for (const line of lines) {
    if (Buffer.byteLength(line, "latin1") > MAX_HEADER_LINE_BYTES) {
      throw emlError("STORAGE_EML_HEADER_LIMIT", "An email header line exceeds the 8 KiB safety limit.");
    }
    if (/^[ \t]/u.test(line)) {
      if (!unfolded.length) throw emlError("STORAGE_EML_MALFORMED", "The email contains an invalid folded header.");
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  const result: Headers = new Map();
  for (const line of unfolded) {
    const match = /^([!-9;-~]+):[ \t]*(.*)$/u.exec(line);
    if (!match || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(match[2])) {
      throw emlError("STORAGE_EML_MALFORMED", "The email contains a malformed or unsafe header.");
    }
    const name = match[1].toLowerCase();
    const values = result.get(name) ?? [];
    values.push(match[2]);
    result.set(name, values);
  }
  return result;
}

function oneHeader(headers: Headers, name: string, rejectDuplicates = false): string | undefined {
  const values = headers.get(name) ?? [];
  if (rejectDuplicates && values.length > 1) {
    throw emlError("STORAGE_EML_MALFORMED", `The email contains ambiguous ${name} headers.`);
  }
  return values[0];
}

function decodeBytes(bytes: Buffer, charset: string): string {
  const normalized = charset.trim().toLowerCase().replace(/^"|"$/g, "");
  const label = normalized === "us-ascii" ? "utf-8" : normalized;
  if (!["utf-8", "iso-8859-1", "windows-1252"].includes(label)) {
    throw emlError("STORAGE_EML_CHARSET_UNSUPPORTED", "The email uses an unsupported text character set.");
  }
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    throw emlError("STORAGE_EML_TEXT_INVALID", "The email contains invalid text for its declared character set.");
  }
}

function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?\s]+)\?([bqBQ])\?([^?]*)\?=/g, (_all, charset: string, encoding: string, encoded: string) => {
    let bytes: Buffer;
    if (encoding.toUpperCase() === "B") {
      const compact = encoded.replace(/\s/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 !== 0) {
        throw emlError("STORAGE_EML_MALFORMED", "The email contains a malformed encoded header.");
      }
      bytes = Buffer.from(compact, "base64");
    } else {
      const q = encoded.replace(/_/g, " ");
      if (/=(?![A-Fa-f0-9]{2})/u.test(q)) {
        throw emlError("STORAGE_EML_MALFORMED", "The email contains a malformed encoded header.");
      }
      bytes = Buffer.from(q.replace(/=([A-Fa-f0-9]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
    }
    return decodeBytes(bytes, charset);
  });
}

function safeHeader(value: string | undefined, maximum: number): string | null {
  if (!value) return null;
  const decoded = decodeEncodedWords(value).normalize("NFKC").replace(/[ \t]+/g, " ").trim();
  if (!decoded || decoded.length > maximum || /[\p{Cc}\p{Cf}]/u.test(decoded)) {
    throw emlError("STORAGE_EML_HEADER_UNSAFE", "The email contains an unsafe or excessively long display header.");
  }
  return decoded;
}

function splitHeaderParameters(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (character === "\\" && quoted) escaped = true;
    else if (character === "\"") quoted = !quoted;
    else if (character === ";" && !quoted) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted) throw emlError("STORAGE_EML_MALFORMED", "The email contains an unterminated MIME parameter.");
  parts.push(value.slice(start));
  return parts;
}

function unquoteParameter(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("\"")) return trimmed;
  if (!trimmed.endsWith("\"") || trimmed.length < 2) {
    throw emlError("STORAGE_EML_MALFORMED", "The email contains a malformed MIME parameter.");
  }
  return trimmed.slice(1, -1).replace(/\\([\\"])/g, "$1");
}

function decodeExtendedParameter(value: string): string {
  const match = /^([^']*)'[^']*'(.*)$/u.exec(value);
  const charset = match?.[1] || "utf-8";
  const encoded = match?.[2] ?? value;
  try {
    const octets: number[] = [];
    for (let index = 0; index < encoded.length; index += 1) {
      if (encoded[index] === "%") {
        const hex = encoded.slice(index + 1, index + 3);
        if (!/^[A-Fa-f0-9]{2}$/u.test(hex)) throw new Error("bad escape");
        octets.push(Number.parseInt(hex, 16));
        index += 2;
      } else {
        const code = encoded.charCodeAt(index);
        if (code > 0x7f) throw new Error("non-ascii extended parameter");
        octets.push(code);
      }
    }
    return decodeBytes(Buffer.from(octets), charset);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw emlError("STORAGE_EML_MALFORMED", "The email contains a malformed encoded MIME parameter.");
  }
}

function parameterizedHeader(value: string | undefined, fallback: string, requireMimeType = true): { value: string; parameters: Map<string, string> } {
  const pieces = splitHeaderParameters(value ?? fallback);
  const mediaValue = pieces.shift()?.trim().toLowerCase() || fallback;
  if (requireMimeType && mediaValue && (mediaValue.length > 200 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaValue))) {
    throw emlError("STORAGE_EML_MALFORMED", "The email contains an invalid MIME content type.");
  }
  const raw = new Map<string, string>();
  for (const piece of pieces) {
    const equals = piece.indexOf("=");
    if (equals < 1) throw emlError("STORAGE_EML_MALFORMED", "The email contains a malformed MIME parameter.");
    const name = piece.slice(0, equals).trim().toLowerCase();
    if (!/^[a-z0-9!#$&+.^_`|~-]+(?:\*\d+\*?|\*)?$/u.test(name) || raw.has(name)) {
      throw emlError("STORAGE_EML_MALFORMED", "The email contains an ambiguous MIME parameter.");
    }
    raw.set(name, unquoteParameter(piece.slice(equals + 1)));
  }
  const parameters = new Map<string, string>();
  for (const [name, parameter] of raw) {
    if (name.endsWith("*") && !/\*\d+\*$/u.test(name)) {
      parameters.set(name.slice(0, -1), decodeExtendedParameter(parameter));
    } else if (!/\*\d+\*?$/u.test(name)) {
      parameters.set(name, decodeEncodedWords(parameter));
    }
  }
  for (const base of ["filename", "name"]) {
    const segments = [...raw.entries()]
      .map(([name, parameter]) => {
        const match = new RegExp(`^${base}\\*(\\d+)(\\*)?$`, "u").exec(name);
        return match ? { index: Number(match[1]), encoded: Boolean(match[2]), parameter } : null;
      })
      .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment))
      .sort((left, right) => left.index - right.index);
    if (segments.length) {
      if (segments.some((segment, index) => segment.index !== index)) {
        throw emlError("STORAGE_EML_MALFORMED", "The email contains incomplete MIME parameter segments.");
      }
      const joined = segments.map((segment) => segment.parameter).join("");
      parameters.set(base, segments.some((segment) => segment.encoded) ? decodeExtendedParameter(joined) : decodeEncodedWords(joined));
    }
  }
  return { value: mediaValue, parameters };
}

function decodeTransfer(body: Buffer, encoding: string): Buffer {
  const normalized = encoding.trim().toLowerCase();
  if (!normalized || normalized === "7bit" || normalized === "8bit" || normalized === "binary") {
    return Buffer.from(body);
  }
  if (normalized === "base64") {
    const compact = body.toString("ascii").replace(/[\r\n\t ]/g, "");
    if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 !== 0) {
      throw emlError("STORAGE_EML_TRANSFER_INVALID", "A MIME part contains malformed base64 content.");
    }
    return Buffer.from(compact, "base64");
  }
  if (normalized === "quoted-printable") {
    const source = body.toString("latin1").replace(/=\r?\n/g, "");
    if (/=(?![A-Fa-f0-9]{2})/u.test(source)) {
      throw emlError("STORAGE_EML_TRANSFER_INVALID", "A MIME part contains malformed quoted-printable content.");
    }
    return Buffer.from(source.replace(/=([A-Fa-f0-9]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
  }
  throw emlError("STORAGE_EML_TRANSFER_UNSUPPORTED", "A MIME part uses an unsupported content-transfer encoding.");
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  if (!boundary || boundary.length > 70 || /[^\x21-\x7e]/u.test(boundary)) {
    throw emlError("STORAGE_EML_BOUNDARY_INVALID", "The email contains an invalid multipart boundary.");
  }
  const source = body.toString("latin1");
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...source.matchAll(new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, "g"))];
  if (matches.length < 2 || !matches.at(-1)?.[1]) {
    throw emlError("STORAGE_EML_MULTIPART_MALFORMED", "The email multipart body is incomplete or malformed.");
  }
  const parts: Buffer[] = [];
  for (let index = 0; index < matches.length - 1; index += 1) {
    const marker = matches[index];
    const next = matches[index + 1];
    if (marker[1]) break;
    const start = marker.index! + marker[0].length;
    const end = next.index!;
    if (end > start) parts.push(Buffer.from(source.slice(start, end), "latin1"));
  }
  if (!parts.length) throw emlError("STORAGE_EML_MULTIPART_MALFORMED", "The email multipart body contains no readable parts.");
  return parts;
}

function htmlToText(html: string): string {
  const withoutActive = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|iframe|object|embed|form|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return withoutActive.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return "\"";
    if (normalized === "apos") return "'";
    if (normalized === "nbsp") return " ";
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : "�";
  }).replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function safeText(text: string): string {
  if (/\u0000/u.test(text)) throw emlError("STORAGE_EML_TEXT_INVALID", "The email body contains unsafe binary text.");
  return text.replace(/\r\n?/g, "\n").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "�").trim();
}

const MIME_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/plain": "txt",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

function mimeForOctetStream(filename: string): string | null {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(filename)?.[1].toLowerCase();
  return ({
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    csv: "text/csv", tsv: "text/tab-separated-values", txt: "text/plain",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  } as Record<string, string>)[extension ?? ""] ?? null;
}

function attachmentFilename(candidate: string | undefined, mediaType: string, index: number): string {
  if (candidate) return candidate.normalize("NFKC");
  const extension = MIME_EXTENSION[mediaType];
  return extension ? `attachment-${index}.${extension}` : `attachment-${index}.bin`;
}

function quarantineAttachment(
  state: ParserState,
  index: number,
  filename: string,
  mediaType: string,
  disposition: "attachment" | "inline",
  error: unknown,
  byteSize = 0,
): void {
  const safeFilename = filename.length >= 1 && filename.length <= 180 && !/[\\/\p{Cc}\p{Cf}]/u.test(filename)
    ? filename
    : "(unsafe filename)";
  const storageError = error instanceof StorageError ? error : null;
  state.previews.push({
    index,
    filename: safeFilename,
    mimeType: mediaType,
    byteSize,
    disposition,
    status: "QUARANTINED",
    errorCode: storageError?.code ?? "STORAGE_EML_ATTACHMENT_UNSAFE",
    reason: storageError?.message ?? "The attachment could not be safely decoded or validated.",
  });
}

function parseEntity(bytes: Buffer, depth: number, state: ParserState): Headers {
  if (depth > MAX_MIME_DEPTH) throw emlError("STORAGE_EML_NESTING_LIMIT", "The email exceeds the MIME nesting-depth safety limit.");
  state.parts += 1;
  if (state.parts > MAX_MIME_PARTS) throw emlError("STORAGE_EML_PART_LIMIT", "The email exceeds the 64-part MIME safety limit.");
  const { header, body } = splitHeaderAndBody(bytes);
  const headers = parseHeaders(header);
  const contentType = parameterizedHeader(oneHeader(headers, "content-type", true), "text/plain");
  const dispositionHeader = oneHeader(headers, "content-disposition", true);
  const disposition = parameterizedHeader(dispositionHeader, "", false);
  const mediaType = contentType.value;
  if (mediaType === "multipart/encrypted" || mediaType === "application/pkcs7-mime" || mediaType === "application/x-pkcs7-mime") {
    throw emlError("STORAGE_EML_ENCRYPTED", "Encrypted email content cannot be safely inspected. Export the receipt attachment separately.");
  }
  if (mediaType.startsWith("multipart/")) {
    const boundary = contentType.parameters.get("boundary");
    if (!boundary) throw emlError("STORAGE_EML_BOUNDARY_INVALID", "The multipart email does not declare a boundary.");
    for (const part of splitMultipart(body, boundary)) parseEntity(part, depth + 1, state);
    return headers;
  }

  const dispositionValue = disposition.value === "inline" ? "inline" : "attachment";
  const candidateName = disposition.parameters.get("filename") ?? contentType.parameters.get("name");
  const isAttachment = Boolean(candidateName) || disposition.value === "attachment" || !mediaType.startsWith("text/");
  if (mediaType === "message/rfc822") {
    state.attachmentIndex += 1;
    if (state.attachmentIndex > MAX_ATTACHMENTS) throw emlError("STORAGE_EML_ATTACHMENT_LIMIT", "The email exceeds the 20-attachment safety limit.");
    quarantineAttachment(
      state,
      state.attachmentIndex,
      attachmentFilename(candidateName, mediaType, state.attachmentIndex),
      mediaType,
      dispositionValue,
      emlError("STORAGE_EML_NESTED_MESSAGE", "Nested email messages are quarantined. Export their attachments separately."),
      body.length,
    );
    return headers;
  }

  if (!isAttachment && (mediaType === "text/plain" || mediaType === "text/html")) {
    const decoded = decodeTransfer(body, oneHeader(headers, "content-transfer-encoding", true) ?? "7bit");
    state.decodedBytes += decoded.length;
    if (state.decodedBytes > MAX_DECODED_BYTES) throw emlError("STORAGE_EML_DECODED_LIMIT", "The decoded email exceeds the 4 MiB safety limit.");
    const charset = contentType.parameters.get("charset") ?? "utf-8";
    const text = safeText(decodeBytes(decoded, charset));
    if (mediaType === "text/plain") state.plainBodies.push(text);
    else state.htmlBodies.push(htmlToText(text));
    decoded.fill(0);
    return headers;
  }

  state.attachmentIndex += 1;
  const index = state.attachmentIndex;
  if (index > MAX_ATTACHMENTS) throw emlError("STORAGE_EML_ATTACHMENT_LIMIT", "The email exceeds the 20-attachment safety limit.");
  const filename = attachmentFilename(candidateName, mediaType, index);
  let decoded: Buffer | null = null;
  try {
    decoded = decodeTransfer(body, oneHeader(headers, "content-transfer-encoding", true) ?? "7bit");
    state.decodedBytes += decoded.length;
    if (state.decodedBytes > MAX_DECODED_BYTES) throw emlError("STORAGE_EML_DECODED_LIMIT", "The decoded email exceeds the 4 MiB safety limit.");
    const sha256 = createHash("sha256").update(decoded).digest("hex");
    if (dispositionValue === "inline" && mediaType.startsWith("image/")) {
      state.previews.push({ index, filename, mimeType: mediaType, byteSize: decoded.length, sha256, disposition: "inline", status: "INLINE_SKIPPED", reason: "Inline message artwork is not extracted as accounting evidence." });
      return headers;
    }
    if (state.attachmentHashes.has(sha256)) {
      state.previews.push({ index, filename, mimeType: mediaType, byteSize: decoded.length, sha256, disposition: dispositionValue, status: "DUPLICATE_SKIPPED", reason: "An identical attachment was already selected from this message." });
      return headers;
    }
    const validationMimeType = mediaType === "application/octet-stream" ? mimeForOctetStream(filename) ?? mediaType : mediaType;
    const validated = validateInboxDocumentBytes(filename, validationMimeType, decoded);
    state.attachmentHashes.add(sha256);
    const canonicalMimeType = inboxUploadMimeTypeSchema.parse(validated.canonicalMimeType);
    const attachment = { index, filename, mimeType: canonicalMimeType, byteSize: decoded.length, sha256, bytes: decoded };
    state.attachments.push(attachment);
    state.previews.push({ index, filename, mimeType: validated.canonicalMimeType, byteSize: decoded.length, sha256, disposition: dispositionValue, status: "READY_TO_EXTRACT" });
    decoded = null;
  } catch (error) {
    quarantineAttachment(state, index, filename, mediaType, dispositionValue, error, decoded?.length ?? body.length);
  } finally {
    decoded?.fill(0);
  }
  return headers;
}

export function parseEmlDocument(bytes: Buffer): ParsedEmlDocument {
  if (bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES) {
    throw emlError("STORAGE_EML_SIZE_LIMIT", "Emails must be between 1 byte and 2 MiB.");
  }
  const state: ParserState = {
    parts: 0,
    decodedBytes: 0,
    attachmentIndex: 0,
    attachmentHashes: new Set(),
    plainBodies: [],
    htmlBodies: [],
    previews: [],
    attachments: [],
  };
  try {
    const headers = parseEntity(bytes, 0, state);
    const htmlConverted = state.plainBodies.length === 0 && state.htmlBodies.length > 0;
    const fullText = (state.plainBodies.length ? state.plainBodies : state.htmlBodies).filter(Boolean).join("\n\n");
    const bodyTruncated = fullText.length > MAX_PREVIEW_CHARACTERS;
    const text = fullText.slice(0, MAX_PREVIEW_CHARACTERS);
    return {
      text,
      preview: {
        from: safeHeader(oneHeader(headers, "from"), 500),
        subject: safeHeader(oneHeader(headers, "subject"), 500),
        date: safeHeader(oneHeader(headers, "date"), 200),
        messageSha256: createHash("sha256").update(bytes).digest("hex"),
        bodySha256: createHash("sha256").update(text, "utf8").digest("hex"),
        htmlConverted,
        bodyTruncated,
        attachments: state.previews,
      },
      attachments: state.attachments,
    };
  } catch (error) {
    for (const attachment of state.attachments) attachment.bytes.fill(0);
    throw error;
  }
}
