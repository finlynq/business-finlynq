import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { scanEvidence } from "@/security/evidence-scanner";
import { MAX_PDF_PREPARATION_BYTES, preparePdfUploadSchema } from "./model";
import { assertDirectChild, assertStorageFolder } from "./boundaries";
import { prepareLosslessPdf } from "./pdf-preparation";
import { StorageError } from "./provider";
import { assertStorageWrite, connectedDrive, loadConnection } from "./store";
import { uploadInboxDocument, type PdfUploadProvenance } from "./upload";

function decodeSource(command: z.output<typeof preparePdfUploadSchema>): Buffer {
  const bytes = Buffer.from(command.contentBase64, "base64");
  const actual = createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(command.sha256, "hex");
  if (bytes.length !== command.byteSize || bytes.toString("base64") !== command.contentBase64) {
    bytes.fill(0);
    throw new StorageError("STORAGE_UPLOAD_ENCODING", "PDF source size or base64 encoding is invalid. Re-read the source and retry.");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    bytes.fill(0);
    throw new StorageError("STORAGE_UPLOAD_CHECKSUM", "The PDF source checksum does not match. Re-read the source and retry.");
  }
  return bytes;
}

export async function prepareAndUploadPdf(context: TenantTransactionContext, input: z.input<typeof preparePdfUploadSchema>) {
  const command = preparePdfUploadSchema.parse(input);
  if (command.byteSize > MAX_PDF_PREPARATION_BYTES) throw new StorageError("STORAGE_PDF_PREPARATION_LIMIT", `Source size ${command.byteSize} bytes exceeds the ${MAX_PDF_PREPARATION_BYTES} byte preparation limit. Split or re-export the PDF and retry.`);
  // Authorize before decoding or scanning the supplied source.
  await withTenantTransaction(context, async (client) => { await assertStorageWrite(client, context); await loadConnection(client, context, command.connectionId, "manage"); });
  const original = decodeSource(command);
  let optimized: Buffer | undefined;
  try {
    await scanEvidence(original, MAX_PDF_PREPARATION_BYTES);
    const prepared = await prepareLosslessPdf(original);
    optimized = prepared.optimized;
    const savedOriginal = await withTenantTransaction(context, async (client) => {
      await assertStorageWrite(client, context);
      const connection = await loadConnection(client, context, command.connectionId, "manage");
      const { drive, location } = await connectedDrive(client, connection);
      await assertStorageFolder(drive, location, location.archiveId, "archive");
      const originalFolderId = await drive.folder(location.archiveId, "Original PDFs");
      const folder = await drive.file(originalFolderId);
      if (!folder.folder || folder.parentId !== location.archiveId || (location.driveId && folder.driveId !== location.driveId)) {
        throw new StorageError("STORAGE_FOLDER_BOUNDARY", "The original PDF archive folder is outside the selected company archive.");
      }
      const stem = `Upload-${prepared.verification.originalSha256}`;
      let file = await drive.findUpload(originalFolderId, stem);
      if (file) {
        assertDirectChild(file, originalFolderId);
        if (file.size !== original.length || file.mimeType !== "application/pdf") throw new StorageError("STORAGE_UPLOAD_CONFLICT", "An original PDF archive entry has different metadata. Review the archive and retry.");
        const retained = await drive.download(file.id, MAX_PDF_PREPARATION_BYTES);
        try { if (!retained.equals(original)) throw new StorageError("STORAGE_UPLOAD_CONFLICT", "An original PDF archive entry has different content. Review the archive and retry."); }
        finally { retained.fill(0); }
      } else {
        file = await drive.upload(originalFolderId, `${stem}.pdf`, "application/pdf", original, MAX_PDF_PREPARATION_BYTES);
      }
      assertDirectChild(file, originalFolderId);
      return { fileId: file.id, folderId: originalFolderId };
    });
    const provenance: PdfUploadProvenance = { ...prepared.verification, originalFilename: command.filename,
      originalProviderFileId: savedOriginal.fileId, originalArchiveFolderId: savedOriginal.folderId };
    const uploaded = await uploadInboxDocument(context, { connectionId: command.connectionId, filename: command.filename,
      mimeType: "application/pdf", byteSize: optimized.length, sha256: provenance.optimizedSha256,
      contentBase64: optimized.toString("base64"), idempotencyKey: `prepared-pdf:${command.sha256}` }, provenance);
    return { ...uploaded, preparation: provenance };
  } catch (error) {
    if (error instanceof Error && /Evidence rejected by malware scanning/.test(error.message)) {
      throw new StorageError("STORAGE_PDF_MALWARE", "The PDF was rejected by malware scanning. Do not retry the same file; obtain a clean source and retry.");
    }
    if (error instanceof Error && /Evidence scanning is unavailable|signatures are unavailable or stale|could not be completely scanned/.test(error.message)) {
      throw new StorageError("STORAGE_SCAN_UNAVAILABLE", "The PDF could not be fully scanned. Retry when evidence scanning is available.");
    }
    throw error;
  } finally { original.fill(0); optimized?.fill(0); }
}
