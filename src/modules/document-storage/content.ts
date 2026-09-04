import "server-only";
import { spawn } from "node:child_process";
import { StorageError } from "./provider";

/** Poppler uses stdin/stdout only: no invoice or rendered page is written to disk. */
export function runDocumentFilter(command: "pdftotext" | "pdftoppm" | "pdfinfo", args: string[], input: Buffer, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: process.env.NODE_ENV } });
    const chunks: Buffer[] = []; let length = 0; let finished = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(error); } else resolve(Buffer.concat(chunks));
      for (const chunk of chunks) chunk.fill(0);
    };
    const timer = setTimeout(() => finish(new StorageError("STORAGE_RENDER_LIMIT", "Document rendering exceeded its time limit. Review this file manually.")), 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > maximumBytes) { chunk.fill(0); finish(new StorageError("STORAGE_RENDER_LIMIT", "This document page exceeds the rendering limit.")); }
      else if (!finished) chunks.push(chunk);
    });
    child.stderr.resume(); // Parser errors can contain document text; never log them.
    child.stdin.on("error", () => undefined);
    child.on("error", () => finish(new StorageError("STORAGE_RENDER_UNAVAILABLE", "PDF reading is unavailable on this server. Ask the operator to install Poppler.")));
    child.on("close", (code) => finish(code === 0 && length > 0 ? undefined : new StorageError("STORAGE_RENDER_FAILED", "This PDF page could not be read. Check the page number or review the original.")));
    child.stdin.end(input);
  });
}
export async function documentPage(bytes: Buffer, mimeType: string, page: number) {
  if (mimeType !== "application/pdf") {
    if (page !== 1) throw new StorageError("STORAGE_PAGE_INVALID", "Images have one page.");
    return { mimeType, imageBase64: bytes.toString("base64"), text: "", pageCount: 1 };
  }
  const info = await runDocumentFilter("pdfinfo", ["-"], bytes, 100000);
  let pageCount: number;
  try { pageCount = Number(/^Pages:\s+(\d+)\s*$/m.exec(info.toString("utf8"))?.[1]); }
  finally { info.fill(0); }
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100) throw new StorageError("STORAGE_PAGE_LIMIT", "PDFs must contain 1 to 100 pages. Split this document or review it manually.");
  if (page > pageCount) throw new StorageError("STORAGE_PAGE_INVALID", "This PDF does not contain that page.");
  const png = await runDocumentFilter("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-scale-to", "1600", "-png", "-"], bytes, 4 * 1024 * 1024);
  try {
    let text = "";
    try {
      const extracted = await runDocumentFilter("pdftotext", ["-f", String(page), "-l", String(page), "-layout", "-", "-"], bytes, 100000);
      try { text = extracted.toString("utf8"); } finally { extracted.fill(0); }
    } catch { /* A scanned PDF may have no text. The page image is authoritative. */ }
    return { mimeType: "image/png", imageBase64: png.toString("base64"), text, pageCount };
  } finally { png.fill(0); }
}
