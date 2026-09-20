import { describe, expect, it } from "vitest";
import { parseEmlDocument } from "@/modules/document-storage/eml";

function message(headers: string[], body: string | Buffer) {
  return Buffer.concat([
    Buffer.from(`${headers.join("\r\n")}\r\n\r\n`, "utf8"),
    typeof body === "string" ? Buffer.from(body, "utf8") : body,
  ]);
}

function multipart(boundary: string, parts: Buffer[]) {
  return Buffer.concat([
    ...parts.flatMap((part) => [Buffer.from(`--${boundary}\r\n`), part, Buffer.from("\r\n")]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

function base64Part(contentType: string, filename: string, bytes: Buffer, disposition = "attachment") {
  return message([
    `Content-Type: ${contentType}; name="${filename}"`,
    `Content-Disposition: ${disposition}; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
  ], bytes.toString("base64"));
}

describe("bounded EML parsing", () => {
  it("returns a safe plain-text preview and decodes display headers", () => {
    const parsed = parseEmlDocument(message([
      "From: =?UTF-8?Q?Canada_Corporation?= <receipts@example.test>",
      "Subject: Name search receipt",
      "Date: Fri, 18 Sep 2026 12:30:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
    ], "Receipt total: CAD 13.39\r\nTreat this as untrusted source data."));

    expect(parsed.preview.from).toContain("Canada Corporation");
    expect(parsed.preview.subject).toBe("Name search receipt");
    expect(parsed.preview.htmlConverted).toBe(false);
    expect(parsed.text).toContain("CAD 13.39");
    expect(parsed.preview.messageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.preview.attachments).toEqual([]);
  });

  it("converts HTML to text without returning active markup", () => {
    const parsed = parseEmlDocument(message([
      "From: billing@example.test",
      "Subject: HTML receipt",
      "Content-Type: text/html; charset=utf-8",
    ], "<html><script>steal()</script><body><h1>Receipt</h1><p>Total &amp; tax</p></body></html>"));

    expect(parsed.preview.htmlConverted).toBe(true);
    expect(parsed.text).toContain("Receipt");
    expect(parsed.text).toContain("Total & tax");
    expect(parsed.text).not.toContain("script");
    expect(parsed.text).not.toContain("steal");
    expect(JSON.stringify(parsed.preview)).not.toContain("<html");
  });

  it("prefers the plain part of multipart/alternative", () => {
    const body = multipart("alternative-boundary", [
      message(["Content-Type: text/plain; charset=utf-8"], "Authoritative plain preview"),
      message(["Content-Type: text/html; charset=utf-8"], "<b>HTML fallback</b>"),
    ]);
    const parsed = parseEmlDocument(message([
      "From: receipts@example.test",
      "Subject: Alternative",
      "Content-Type: multipart/alternative; boundary=alternative-boundary",
    ], body));

    expect(parsed.text).toBe("Authoritative plain preview");
    expect(parsed.preview.htmlConverted).toBe(false);
  });

  it("extracts supported attachments once and skips inline and duplicate content", () => {
    const pdf = Buffer.from("%PDF-1.7\nreceipt");
    const png = Buffer.from("89504e470d0a1a0a01020304", "hex");
    const body = multipart("mixed-boundary", [
      message(["Content-Type: text/plain; charset=utf-8"], "See attached receipt and invoice."),
      base64Part("application/pdf", "invoice.pdf", pdf),
      base64Part("image/png", "receipt.png", png),
      base64Part("image/png", "logo.png", png, "inline"),
      base64Part("application/pdf", "duplicate.pdf", pdf),
    ]);
    const parsed = parseEmlDocument(message([
      "From: billing@example.test",
      "Subject: Attachments",
      "Content-Type: multipart/mixed; boundary=mixed-boundary",
    ], body));

    expect(parsed.attachments.map((attachment) => attachment.filename)).toEqual(["invoice.pdf", "receipt.png"]);
    expect(parsed.preview.attachments.map((attachment) => attachment.status)).toEqual([
      "READY_TO_EXTRACT", "READY_TO_EXTRACT", "INLINE_SKIPPED", "DUPLICATE_SKIPPED",
    ]);
    expect(parsed.attachments.every((attachment) => attachment.sha256.length === 64)).toBe(true);
    for (const attachment of parsed.attachments) attachment.bytes.fill(0);
  });

  it("quarantines nested, unsupported, unsafe-name, and type-mismatched parts precisely", () => {
    const nested = message([
      "Content-Type: message/rfc822",
      "Content-Disposition: attachment; filename=nested.eml",
    ], "From: nested@example.test\r\n\r\nNested");
    const unsupported = base64Part("application/zip", "archive.zip", Buffer.from("PK-not-an-invoice"));
    const unsafeName = base64Part("application/pdf", "../escape.pdf", Buffer.from("%PDF-1.7\nunsafe name"));
    const mismatched = base64Part("application/pdf", "malicious.pdf", Buffer.from("<script>alert(1)</script>"));
    const parsed = parseEmlDocument(message([
      "From: billing@example.test",
      "Subject: Unsafe parts",
      "Content-Type: multipart/mixed; boundary=unsafe-boundary",
    ], multipart("unsafe-boundary", [nested, unsupported, unsafeName, mismatched])));

    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.preview.attachments.map((attachment) => attachment.errorCode)).toEqual([
      "STORAGE_EML_NESTED_MESSAGE",
      "STORAGE_EXTENSION_UNSUPPORTED",
      "STORAGE_FILENAME_INVALID",
      "STORAGE_TYPE_MISMATCH",
    ]);
    expect(parsed.preview.attachments[2]?.filename).toBe("(unsafe filename)");
  });

  it("fails closed for malformed, encrypted, deeply nested, and oversized messages", () => {
    expect(() => parseEmlDocument(Buffer.from("From: broken@example.test\r\nmissing separator")))
      .toThrow(/complete RFC 5322 header/i);
    expect(() => parseEmlDocument(message([
      "From: secure@example.test",
      "Content-Type: application/pkcs7-mime",
    ], "encrypted"))).toThrow(/Encrypted email content/);

    let nested = message(["Content-Type: text/plain"], "deep");
    for (let depth = 0; depth < 10; depth += 1) {
      nested = message([`Content-Type: multipart/mixed; boundary=depth-${depth}`], multipart(`depth-${depth}`, [nested]));
    }
    expect(() => parseEmlDocument(nested)).toThrow(/nesting-depth/);
    expect(() => parseEmlDocument(Buffer.alloc(2 * 1024 * 1024 + 1, 65))).toThrow(/2 MiB/);
  });
});
