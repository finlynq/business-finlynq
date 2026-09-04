import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { documentPage } from "@/modules/document-storage/content";

// A real two-page PDF, including an image-only second page. No fixture file is
// written: the parser receives bytes on stdin and returns page pixels on stdout.
function pdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    "BT /F1 18 Tf 30 240 Td (Invoice 42 - USD 158.20) Tj ET",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 6 0 R >>",
    "q 180 0 0 180 40 50 cm /Im1 Do Q",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n1020ff>\nendstream",
  ];
  let body = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    const content = i === 3 || i === 5 ? `<< /Length ${Buffer.byteLength(object)} >>\nstream\n${object}\nendstream` : object;
    body += `${i + 1} 0 obj\n${content}\nendobj\n`;
  });
  const start = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(body);
}
const available = ["pdfinfo", "pdftoppm", "pdftotext"].every((tool) => spawnSync(tool, ["-v"]).status === 0);
describe.skipIf(!available)("native PDF content delivery (requires Poppler)", () => {
  it("returns searchable text and actual PNG pages with a reliable page count", async () => {
    const bytes = pdf();
    const first = await documentPage(bytes, "application/pdf", 1);
    expect(first.pageCount).toBe(2); expect(first.text).toContain("Invoice 42 - USD 158.20");
    expect(Buffer.from(first.imageBase64, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const second = await documentPage(bytes, "application/pdf", 2);
    expect(second.text.trim()).toBe(""); expect(second.imageBase64).not.toBe(first.imageBase64);
    await expect(documentPage(bytes, "application/pdf", 3)).rejects.toThrow(/page/);
    await expect(documentPage(Buffer.from("%PDF-1.4\nbroken"), "application/pdf", 1)).rejects.toThrow(/read/);
  });
});
