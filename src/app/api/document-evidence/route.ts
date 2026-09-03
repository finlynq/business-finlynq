import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { uploadEvidenceSchema } from "@/modules/subledger/evidence-model";
import { uploadDocumentEvidence } from "@/modules/subledger/evidence-service";

export const POST = createMutationRoute({
  schema: uploadEvidenceSchema, operation: "document-evidence.upload", rateAction: "create",
  maximumBytes: 3 * 1024 * 1024,
  invalidMessage: "Evidence must be a PDF, PNG, or JPEG up to 2 MiB with matching file metadata.",
  failureMessage: "Evidence could not be accepted. Check your role, checksum, file content, and scanner availability.",
  auditReason: () => "Upload source-document evidence",
  invoke: (body, context) => uploadDocumentEvidence({ context, ...body }),
});
