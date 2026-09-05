import "server-only";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { scanEvidence } from "@/security/evidence-scanner";
import { canonicalHash } from "@/modules/subledger/document-model";
import { uploadInboxSchema } from "./model";
import { assertStorageWrite, connectedDrive, encryptStorageValue, loadConnection } from "./store";
import { discoverFile, itemMetadata, type InboxRow } from "./inbox-store";
import { validatedCloudBytes } from "./evidence";
import { StorageError } from "./provider";
import { assertDirectChild, assertStorageFolder } from "./boundaries";
import { decodeInboxUpload } from "./file-types";

export async function uploadInboxDocument(context: TenantTransactionContext, input: z.input<typeof uploadInboxSchema>) {
  const command = uploadInboxSchema.parse(input);
  const uploadKey = canonicalHash(command.idempotencyKey); const uploadHash = canonicalHash(command);
  // Authorize before accepting/scanning document content.
  await withTenantTransaction(context, async (client) => {
    await assertStorageWrite(client, context); await loadConnection(client, context, command.connectionId, "manage");
  });
  const decoded = decodeInboxUpload(command);
  const bytes = decoded.bytes;
  try {
    await scanEvidence(bytes);
    return await withTenantTransaction(context, async (client) => {
      await assertStorageWrite(client, context);
      const connection = await loadConnection(client, context, command.connectionId, "manage");
      const replay = (await client.query<InboxRow & { upload_hash: string }>("SELECT * FROM document_inbox_items WHERE organization_id=$1 AND connection_id=$2 AND upload_key=$3", [context.organizationId, connection.id, uploadKey])).rows[0];
      if (replay) {
        if (replay.upload_hash !== uploadHash) throw new StorageError("STORAGE_UPLOAD_CONFLICT", "This upload key was already used with different file metadata or content.");
        return { item: await itemMetadata(client, replay), idempotentReplay: true };
      }
      const { drive, location } = await connectedDrive(client, connection);
      await assertStorageFolder(drive, location, location.inboxId, "inbox");
      const stem = `Upload-${uploadKey}`;
      let file = await drive.findUpload(location.inboxId, stem);
      if (file) {
        assertDirectChild(file, location.inboxId);
        const existing = await validatedCloudBytes(drive, file);
        try {
          if (existing.sha256 !== command.sha256 || existing.mimeType !== decoded.canonicalMimeType || file.size !== command.byteSize) throw new StorageError("STORAGE_UPLOAD_CONFLICT", "The cloud inbox already contains different content for this upload key.");
        } finally { existing.bytes.fill(0); }
      } else {
        const extension = { PDF: "pdf", PNG: "png", JPEG: "jpg", CSV: "csv", TSV: "tsv", TEXT: "txt", XLS: "xls", XLSX: "xlsx" }[decoded.format];
        file = await drive.upload(location.inboxId, `${stem}.${extension}`, decoded.canonicalMimeType, bytes);
      }
      assertDirectChild(file, location.inboxId);
      await assertStorageFolder(drive, location, location.inboxId, "inbox");
      const discovered = await discoverFile(client, context, connection, file);
      const row = discovered.row;
      if (!row) throw new Error("The provider did not create a document");
      const routingTarget = ["CSV", "TSV", "TEXT", "XLS", "XLSX"].includes(decoded.format) ? "BANKING_IMPORT_REVIEW" : undefined;
      const metadata = await encryptStorageValue(client, row, "document_inbox_items", "metadata_ciphertext", {
        name: command.filename,
        sourcePath: command.filename,
        sourceFolderId: location.inboxId,
        sourceDepth: 0,
        ...(routingTarget ? { routingTarget } : {}),
      });
      const updated = (await client.query<InboxRow>("UPDATE document_inbox_items SET upload_key=$3,upload_hash=$4,metadata_ciphertext=$5,mime_type=$6 WHERE organization_id=$1 AND id=$2 RETURNING *", [context.organizationId, row.id, uploadKey, uploadHash, metadata, decoded.canonicalMimeType])).rows[0];
      return { item: await itemMetadata(client, updated), idempotentReplay: false };
    });
  } finally { bytes.fill(0); }
}
