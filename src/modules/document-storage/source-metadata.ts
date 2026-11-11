import { exact } from "@/kernel/money";
import type { BusinessDocumentSnapshot } from "@/modules/subledger/document-model";

/** Credit originals can print either a positive credit magnitude or a signed
 * negative total. The document type, date and currency must still match.
 */
export function businessDocumentMatchesMetadata(
  snapshot: Pick<BusinessDocumentSnapshot, "kind" | "documentDate" | "currency" | "grossTotal">,
  metadata: { documentType: string; documentDate: string; currency?: string; total?: string },
) {
  if (!metadata.total || snapshot.documentDate !== metadata.documentDate || snapshot.currency !== metadata.currency) return false;
  if (snapshot.kind === "SUPPLIER_CREDIT_NOTE") {
    return metadata.documentType === "CREDIT_NOTE" && exact(snapshot.grossTotal).abs().eq(exact(metadata.total).abs());
  }
  return metadata.documentType !== "CREDIT_NOTE" && exact(snapshot.grossTotal).eq(exact(metadata.total));
}
