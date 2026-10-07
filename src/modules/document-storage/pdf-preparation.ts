import "server-only";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocumentFilter } from "./content";
import { StorageError } from "./provider";
import { MAX_PDF_PREPARATION_BYTES } from "./model";
import { MAX_EVIDENCE_BYTES } from "@/modules/subledger/evidence-model";

export type PdfPreparationVerification = Readonly<{
  transformation: "QPDF_LOSSLESS_FLATE_STREAM_COMPRESSION";
  pageCount: number;
  verified: true;
  verification: "ALL_PAGE_COMMANDS_IMAGES_TEXT_GEOMETRY_AND_RENDERED_PIXELS";
  originalSha256: string; originalByteSize: number;
  optimizedSha256: string; optimizedByteSize: number;
}>;

type PdfJson = {
  pages: { contents: string[]; images: { name: string; object: string; width: number; height: number }[]; object: string }[];
  acroform?: { hasacroform?: boolean; fields?: unknown[] };
  encrypt?: { encrypted?: boolean };
  attachments?: Record<string, unknown>;
  qpdf?: [unknown, Record<string, { value?: unknown; stream?: { dict?: Record<string, unknown> } }>];
};
function pdfError(code: string, message: string): StorageError { return new StorageError(code, message); }
function digest(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function runQpdf(args: string[], maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("qpdf", args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, LANG: "C.UTF-8", TMPDIR: tmpdir(), NODE_ENV: process.env.NODE_ENV } });
    const chunks: Buffer[] = []; let size = 0; let finished = false;
    const timer = setTimeout(() => finish(pdfError("STORAGE_PDF_PREPARATION_LIMIT", "PDF preparation timed out. Split or re-export the source PDF and retry.")), 20_000);
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(error); }
      else resolve(Buffer.concat(chunks));
      for (const chunk of chunks) chunk.fill(0);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumBytes) { chunk.fill(0); finish(pdfError("STORAGE_PDF_PREPARATION_LIMIT", "PDF stream expansion exceeds the safe limit. Re-export or split this PDF and retry.")); }
      else if (!finished) chunks.push(chunk);
    });
    child.stderr.resume(); // qpdf diagnostic paths and PDF strings must not reach logs.
    child.on("error", () => finish(pdfError("STORAGE_PDF_PREPARATION_UNAVAILABLE", "PDF preparation is unavailable. Ask the operator to install qpdf.")));
    child.on("close", (code) => finish(code === 0 ? undefined : pdfError("STORAGE_PDF_CORRUPT", "This PDF is malformed, encrypted, or unsupported. Re-export an unsigned, unencrypted PDF and retry.")));
  });
}
function objectDictionary(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function unsafeFeature(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(unsafeFeature);
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value);
  if (entries.some(([key, nested]) => ["/ByteRange", "/Sig", "/Annots", "/AcroForm", "/XFA", "/JavaScript", "/OpenAction", "/EmbeddedFiles", "/OCProperties", "/AA", "/RichMedia"].includes(key)
    || (key === "/Type" && nested === "/Sig"))) return true;
  return entries.some(([, nested]) => unsafeFeature(nested));
}
function validateStructure(pdf: PdfJson): void {
  if (pdf.encrypt?.encrypted) throw pdfError("STORAGE_PDF_ENCRYPTED", "Encrypted PDFs cannot be prepared. Export an unencrypted copy and retry.");
  if (pdf.acroform?.hasacroform || pdf.acroform?.fields?.length || Object.keys(pdf.attachments ?? {}).length || unsafeFeature(pdf.qpdf)) {
    throw pdfError("STORAGE_PDF_PROTECTED", "Signed PDFs, forms, annotations, attachments and interactive PDFs cannot be optimized safely. Keep the original and export an unsigned flattened copy for review.");
  }
  if (!Array.isArray(pdf.pages) || pdf.pages.length < 1 || pdf.pages.length > 10) {
    throw pdfError("STORAGE_PDF_PAGE_LIMIT", "Lossless preparation supports 1 to 10 pages. Split this PDF and retry.");
  }
  for (const page of pdf.pages) {
    if (!Array.isArray(page.contents) || !Array.isArray(page.images) || page.contents.length > 20 || page.images.length > 20) {
      throw pdfError("STORAGE_PDF_PREPARATION_LIMIT", "This PDF has too many page streams or images. Split or re-export it and retry.");
    }
    for (const image of page.images) {
      if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > 8_000_000) {
        throw pdfError("STORAGE_PDF_PREPARATION_LIMIT", "An image in this PDF exceeds the safe decoded-pixel limit. Re-export it at a smaller size.");
      }
    }
  }
  const objects = pdf.qpdf?.[1] ?? {};
  if (Object.keys(objects).length > 300) throw pdfError("STORAGE_PDF_PREPARATION_LIMIT", "This PDF contains too many objects to verify safely. Split or re-export it.");
  for (const object of Object.values(objects)) {
    const stream = objectDictionary(object.stream?.dict);
    if (!Object.keys(stream).length) continue;
    const length = stream["/Length"];
    if (typeof length === "number" && length > MAX_PDF_PREPARATION_BYTES) throw pdfError("STORAGE_PDF_PREPARATION_LIMIT", "A PDF stream exceeds the 8 MiB preparation limit.");
    const filter = stream["/Filter"];
    if (filter !== undefined && filter !== "/FlateDecode") {
      throw pdfError("STORAGE_PDF_UNSUPPORTED_FILTER", "This PDF uses an image or stream encoding that cannot be verified losslessly. Export a smaller PDF and retry.");
    }
  }
}
function refs(page: PdfJson["pages"][number]): string[] {
  const images = [...page.images].sort((a, b) => a.name.localeCompare(b.name));
  return [...page.contents, ...images.map((image) => image.object)];
}
function pageGeometry(info: Buffer): string[] {
  return info.toString("utf8").split("\n").filter((line) => /^Page\s+\d+\s+(?:size|MediaBox|CropBox|BleedBox|TrimBox|ArtBox|rot):/.test(line));
}
async function verifyAllPages(original: Buffer, optimized: Buffer, sourcePath: string, outputPath: string, source: PdfJson, result: PdfJson) {
  if (source.pages.length !== result.pages.length) throw pdfError("STORAGE_PDF_VERIFICATION_FAILED", "The prepared PDF has a different page count. Keep the original and re-export a smaller source.");
  const count = source.pages.length;
  const [sourceInfo, resultInfo] = await Promise.all([
    runDocumentFilter("pdfinfo", ["-f", "1", "-l", String(count), "-box", "-"], original, 100_000),
    runDocumentFilter("pdfinfo", ["-f", "1", "-l", String(count), "-box", "-"], optimized, 100_000),
  ]);
  try { if (JSON.stringify(pageGeometry(sourceInfo)) !== JSON.stringify(pageGeometry(resultInfo))) throw pdfError("STORAGE_PDF_VERIFICATION_FAILED", "Page geometry changed during preparation. Keep the original and re-export a smaller source."); }
  finally { sourceInfo.fill(0); resultInfo.fill(0); }
  for (let index = 0; index < count; index += 1) {
    const originalPage = source.pages[index]; const preparedPage = result.pages[index];
    const originalRefs = refs(originalPage); const preparedRefs = refs(preparedPage);
    if (originalRefs.length !== preparedRefs.length || originalPage.images.map((image) => `${image.name}:${image.width}:${image.height}`).sort().join("|") !== preparedPage.images.map((image) => `${image.name}:${image.width}:${image.height}`).sort().join("|")) {
      throw pdfError("STORAGE_PDF_VERIFICATION_FAILED", "A page image or content stream changed. Keep the original and re-export a smaller source.");
    }
    for (let streamIndex = 0; streamIndex < originalRefs.length; streamIndex += 1) {
      const [left, right] = await Promise.all([
        runQpdf([`--show-object=${originalRefs[streamIndex]}`, "--filtered-stream-data", sourcePath], 16 * 1024 * 1024),
        runQpdf([`--show-object=${preparedRefs[streamIndex]}`, "--filtered-stream-data", outputPath], 16 * 1024 * 1024),
      ]);
      try { if (!left.equals(right)) throw pdfError("STORAGE_PDF_VERIFICATION_FAILED", "Decoded page commands or image pixels changed. Keep the original and re-export a smaller source."); }
      finally { left.fill(0); right.fill(0); }
    }
    const page = String(index + 1);
    const [leftText, rightText, leftPixels, rightPixels] = await Promise.all([
      runDocumentFilter("pdftotext", ["-f", page, "-l", page, "-layout", "-", "-"], original, 100_000),
      runDocumentFilter("pdftotext", ["-f", page, "-l", page, "-layout", "-", "-"], optimized, 100_000),
      runDocumentFilter("pdftoppm", ["-f", page, "-l", page, "-singlefile", "-scale-to", "1600", "-r", "72", "-"], original, 8 * 1024 * 1024),
      runDocumentFilter("pdftoppm", ["-f", page, "-l", page, "-singlefile", "-scale-to", "1600", "-r", "72", "-"], optimized, 8 * 1024 * 1024),
    ]);
    try { if (!leftText.equals(rightText) || !leftPixels.equals(rightPixels)) throw pdfError("STORAGE_PDF_VERIFICATION_FAILED", "Page text or rendered pixels changed. Keep the original and re-export a smaller source."); }
    finally { leftText.fill(0); rightText.fill(0); leftPixels.fill(0); rightPixels.fill(0); }
  }
}

export async function prepareLosslessPdf(original: Buffer): Promise<{ optimized: Buffer; verification: PdfPreparationVerification }> {
  if (original.length < 1 || original.length > MAX_PDF_PREPARATION_BYTES) throw pdfError("STORAGE_PDF_PREPARATION_LIMIT", `Source size ${original.length} bytes exceeds the ${MAX_PDF_PREPARATION_BYTES} byte (8 MiB) preparation limit. Split or re-export the PDF and retry.`);
  if (!/^%PDF-(?:1\.[0-9]|2\.0)/.test(original.subarray(0, 8).toString("ascii"))) throw pdfError("STORAGE_PDF_CORRUPT", "This file is not a valid PDF. Re-export the document and retry.");
  if (original.length <= MAX_EVIDENCE_BYTES) throw pdfError("STORAGE_PDF_ALREADY_FITS", `Source size ${original.length} bytes is within the ${MAX_EVIDENCE_BYTES} byte inbox limit. Upload this PDF normally.`);
  if (/\/Encrypt\b/.test(original.toString("latin1"))) throw pdfError("STORAGE_PDF_ENCRYPTED", "Encrypted PDFs cannot be prepared. Export an unencrypted copy and retry.");
  if (/\/ByteRange\b/.test(original.toString("latin1"))) throw pdfError("STORAGE_PDF_PROTECTED", "Signed PDFs cannot be recompressed safely. Keep the signed original and export an unsigned copy for review.");
  const directory = await mkdtemp(join(tmpdir(), `finlynq-pdf-${randomUUID()}-`));
  const sourcePath = join(directory, "original.pdf"); const outputPath = join(directory, "prepared.pdf");
  let optimized: Buffer | undefined;
  try {
    await writeFile(sourcePath, original, { mode: 0o600, flag: "wx" });
    let source: PdfJson;
    try { const bytes = await runQpdf(["--json", "--json-stream-data=none", sourcePath], 4 * 1024 * 1024); try { source = JSON.parse(bytes.toString("utf8")) as PdfJson; } finally { bytes.fill(0); } }
    catch (error) { if (error instanceof StorageError) throw error; throw pdfError("STORAGE_PDF_CORRUPT", "This PDF is malformed. Re-export the source and retry."); }
    validateStructure(source);
    await runQpdf(["--check", sourcePath], 100_000);
    await runQpdf(["--deterministic-id", "--stream-data=compress", "--object-streams=preserve", "--normalize-content=n", sourcePath, outputPath], 100_000);
    const info = await stat(outputPath);
    if (info.size > MAX_EVIDENCE_BYTES || info.size >= original.length || info.size < 1) {
      throw pdfError("STORAGE_PDF_NOT_REDUCIBLE", `Source size ${original.length} bytes cannot be safely reduced below ${MAX_EVIDENCE_BYTES} bytes. Keep the original and split or re-export a smaller unsigned PDF, then retry.`);
    }
    optimized = await readFile(outputPath);
    const json = await runQpdf(["--json", "--json-stream-data=none", outputPath], 4 * 1024 * 1024);
    let result: PdfJson;
    try { result = JSON.parse(json.toString("utf8")) as PdfJson; } finally { json.fill(0); }
    validateStructure(result);
    await runQpdf(["--check", outputPath], 100_000);
    await verifyAllPages(original, optimized, sourcePath, outputPath, source, result);
    return { optimized, verification: { transformation: "QPDF_LOSSLESS_FLATE_STREAM_COMPRESSION", pageCount: source.pages.length, verified: true,
      verification: "ALL_PAGE_COMMANDS_IMAGES_TEXT_GEOMETRY_AND_RENDERED_PIXELS", originalSha256: digest(original), originalByteSize: original.length,
      optimizedSha256: digest(optimized), optimizedByteSize: optimized.length } };
  } catch (error) { optimized?.fill(0); throw error; }
  finally { await rm(directory, { recursive: true, force: true }); }
}
