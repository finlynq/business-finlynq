import { describe, expect, it } from "vitest";
import { prepareLosslessPdf } from "@/modules/document-storage/pdf-preparation";

import { pdf } from "./fixtures/oversized-pdf";

describe("safe PDF preparation", () => {
  it("reduces uncompressed image streams and verifies every page", async () => {
    const original = pdf();
    const result = await prepareLosslessPdf(original);
    expect(original.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(result.optimized.length).toBeLessThan(2 * 1024 * 1024);
    expect(result.verification).toMatchObject({ pageCount: 2, verified: true, originalByteSize: original.length, optimizedByteSize: result.optimized.length });
    expect(result.verification.originalSha256).not.toBe(result.verification.optimizedSha256);
    await expect(prepareLosslessPdf(result.optimized)).rejects.toMatchObject({ code: "STORAGE_PDF_ALREADY_FITS" });
    result.optimized.fill(0); original.fill(0);
  }, 120_000);
  it("refuses an already compressed PDF that cannot fit and a compressed oversized pixel bomb", async () => {
    await expect(prepareLosslessPdf(pdf({ randomPixels: true, compressImages: true }))).rejects.toMatchObject({ code: "STORAGE_PDF_NOT_REDUCIBLE" });
    await expect(prepareLosslessPdf(pdf({ pages: 3, bombFirstImage: true }))).rejects.toMatchObject({ code: "STORAGE_PDF_PREPARATION_LIMIT" });
  }, 120_000);
  it("refuses signed, encrypted, malformed and oversized decoded-image inputs", async () => {
    await expect(prepareLosslessPdf(pdf({ catalog: "/AcroForm << /Fields [] >>" }))).rejects.toMatchObject({ code: "STORAGE_PDF_PROTECTED" });
    await expect(prepareLosslessPdf(pdf({ extra: "/Encrypt" }))).rejects.toMatchObject({ code: "STORAGE_PDF_ENCRYPTED" });
    await expect(prepareLosslessPdf(Buffer.concat([Buffer.from("%PDF-1.4\ninvalid"), Buffer.alloc(2 * 1024 * 1024)]))).rejects.toMatchObject({ code: "STORAGE_PDF_CORRUPT" });
    await expect(prepareLosslessPdf(pdf({ width: 20000 }))).rejects.toMatchObject({ code: "STORAGE_PDF_PREPARATION_LIMIT" });
  }, 120_000);
});
