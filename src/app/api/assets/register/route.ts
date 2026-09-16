import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { createAssetRecordSchema } from "@/modules/assets/model";
import { createAssetRecord } from "@/modules/assets/service";

export const POST = createMutationRoute({
  schema: createAssetRecordSchema,
  operation: "asset register creation",
  rateAction: "create",
  maximumBytes: 32_000,
  invalidMessage: "Review the asset or prepaid facts and try again.",
  failureMessage: "The asset or prepaid record could not be created safely.",
  auditReason: (body) => `Create asset register record ${body.assetNumber}`,
  invoke: (body, context) => createAssetRecord({ context, ...body }),
});
