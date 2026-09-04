import "server-only";
import { z } from "zod";
import { withTenantTransaction, type TenantTransactionContext } from "@/db/transaction";
import { scanEvidence } from "@/security/evidence-scanner";
import { canonicalHash } from "@/modules/subledger/document-model";
import { decodeEvidence } from "@/modules/subledger/evidence-content";
import { uploadInboxSchema } from "./model";
import { assertStorageWrite, connectedDrive, encryptStorageValue, loadConnection } from "./store";
import { discoverFile, itemMetadata, type InboxRow } from "./inbox-store";
import { validatedCloudBytes } from "./evidence";
import { StorageError } from "./provider";

export async function uploadInboxDocument(context: TenantTransactionContext, input: z.input<typeof uploadInboxSchema>) {
  const command = uploadInboxSchema.parse(input);
  const uploadKey = canonicalHash(command.idempotencyKey); const uploadHash = canonicalHash(command);
  // Authorize before accepting/scanning document content.
  await withTenantTransaction(context, async (client) => {
    await assertStorageWrite(client, context); await loadConnection(client, context, command.connectionId, "manage");
  });
  const bytes = decodeEvidence({ ...command, module: "payables" });
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
      const stem = `Upload-${uploadKey}`;
      let file = await drive.findUpload(location.inboxId, stem);
      if (file) {
        const existing = await validatedCloudBytes(drive, file);
        try {
          if (existing.sha256 !== command.sha256 || file.mimeType !== command.mimeType || file.size !== command.byteSize) throw new StorageError("STORAGE_UPLOAD_CONFLICT", "The cloud inbox already contains different content for this upload key.");
        } finally { existing.bytes.fill(0); }
      } else {
        const extension = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" }[command.mimeType];
        file = await drive.upload(location.inboxId, `${stem}.${extension}`, command.mimeType, bytes);
      }
      const row = await discoverFile(client, context, connection, file);
      if (!row) throw new Error("The provider did not create a document");
      const metadata = await encryptStorageValue(client, row, "document_inbox_items", "metadata_ciphertext", { name: command.filename });
      const updated = (await client.query<InboxRow>("UPDATE document_inbox_items SET upload_key=$3,upload_hash=$4,metadata_ciphertext=$5 WHERE organization_id=$1 AND id=$2 RETURNING *", [context.organizationId, row.id, uploadKey, uploadHash, metadata])).rows[0];
      return { item: await itemMetadata(client, updated), idempotentReplay: false };
    });
  } finally { bytes.fill(0); }
}
