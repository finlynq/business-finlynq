import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeEvidence } from "@/modules/subledger/evidence-content";
import { evidenceReferencesSchema, MAX_EVIDENCE_BYTES, uploadEvidenceSchema } from "@/modules/subledger/evidence-model";
import { safeArgumentsSummary } from "@/modules/mcp/connection-policy";
import { scanEvidence } from "@/security/evidence-scanner";

function input(bytes = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF")) {
  return { module: "payables" as const, filename: "invoice.pdf", mimeType: "application/pdf" as const,
    byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"), idempotencyKey: randomUUID() };
}

describe("bounded source evidence validation", () => {
  it("accepts valid PDF metadata and bytes", () => {
    const command = uploadEvidenceSchema.parse(input());
    expect(decodeEvidence(command).toString()).toContain("%PDF-1.4");
  });
  it("accepts a maximum-sized bounded payload without regex stack exhaustion", () => {
    const bytes = Buffer.alloc(MAX_EVIDENCE_BYTES, 32);
    bytes.write("%PDF-1.4");
    expect(decodeEvidence(uploadEvidenceSchema.parse(input(bytes))).length).toBe(MAX_EVIDENCE_BYTES);
  });
  it.each([
    { mimeType: "text/html" }, { byteSize: MAX_EVIDENCE_BYTES + 1 }, { filename: "../invoice.pdf" },
    { filename: "bad\nname.pdf" }, { url: "http://169.254.169.254/latest/meta-data/" },
    { contentBase64: "not base64" },
  ])("rejects unsafe metadata: %j", (change) => {
    expect(uploadEvidenceSchema.safeParse({ ...input(), ...change }).success).toBe(false);
  });
  it.each([
    { sha256: "0".repeat(64) }, { byteSize: 1 }, { filename: "fake.jpg" },
    { mimeType: "image/png" as const },
  ])("rejects mismatched content: %j", (change) => {
    expect(() => decodeEvidence(uploadEvidenceSchema.parse({ ...input(), ...change }))).toThrow();
  });
  it("rejects executable content disguised as a PDF", () => {
    expect(() => decodeEvidence(uploadEvidenceSchema.parse(input(Buffer.from("MZ executable"))))).toThrow(/signature/);
  });
  it("redacts both binary payloads and filenames from MCP audit summaries", () => {
    expect(safeArgumentsSummary(input())).toMatchObject({ filename: "[redacted]", contentBase64: "[redacted]" });
  });
  it("rejects duplicate evidence links", () => {
    const ref = { assetId: randomUUID(), purpose: "INVOICE" };
    expect(evidenceReferencesSchema.safeParse([ref, ref]).success).toBe(false);
  });
});

describe.runIf(Boolean(process.env.EVIDENCE_SCANNER_HOST))("real ClamAV evidence scanning", () => {
  it("accepts clean PDF content with fresh signature metadata", async () => {
    const scan = await scanEvidence(Buffer.from(input().contentBase64, "base64"));
    expect(scan.version).toMatch(/^ClamAV /);
  });
  it("rejects the standard EICAR anti-malware test file", async () => {
    const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    await expect(scanEvidence(Buffer.from(eicar))).rejects.toThrow(/malware/);
  });
});
