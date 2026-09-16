import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { createAssetCategorySchema } from "@/modules/assets/model";
import { createAssetCategory } from "@/modules/assets/service";

export const POST = createMutationRoute({
  schema: createAssetCategorySchema,
  operation: "asset category creation",
  rateAction: "create",
  maximumBytes: 24_000,
  invalidMessage: "Review the asset-category mappings and try again.",
  failureMessage: "The asset category could not be created safely.",
  auditReason: (body) => `Create ${body.kind.toLowerCase()} category ${body.code}`,
  invoke: (body, context) => createAssetCategory({ context, ...body }),
});
