import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { uploadEvidenceSchema } from "./evidence-model";

export function decodeEvidence(input: z.output<typeof uploadEvidenceSchema>): Buffer {
  const bytes = Buffer.from(input.contentBase64, "base64");
  if (bytes.length !== input.byteSize || bytes.toString("base64") !== input.contentBase64) {
    bytes.fill(0);
    throw new Error("Evidence byte size or base64 encoding is invalid");
  }
  const actual = createHash("sha256").update(bytes).digest();
  if (!timingSafeEqual(actual, Buffer.from(input.sha256, "hex"))) {
    bytes.fill(0);
    throw new Error("Evidence checksum does not match");
  }
  const valid = input.mimeType === "application/pdf"
    ? /\.pdf$/i.test(input.filename) && /^%PDF-1\.[0-9]|^%PDF-2\.0/.test(bytes.subarray(0, 8).toString("ascii"))
    : input.mimeType === "image/png"
      ? /\.png$/i.test(input.filename) && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      : /\.jpe?g$/i.test(input.filename) && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!valid) {
    bytes.fill(0);
    throw new Error("Evidence filename, MIME type, and file signature must agree");
  }
  return bytes;
}
