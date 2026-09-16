import { z } from "zod";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { assetAdjustmentSchema } from "@/modules/assets/model";
import { recordAssetAdjustment } from "@/modules/assets/service";

const bodySchema = assetAdjustmentSchema.omit({ assetId: true });

export const POST = createMutationRoute({
  schema: bodySchema,
  paramsSchema: z.object({ assetId: z.uuid() }).strict(),
  invalidParamsMessage: "The asset identifier is invalid.",
  invalidParamsStatus: 400,
  operation: "asset lifecycle update",
  rateAction: "create",
  maximumBytes: 16_000,
  invalidMessage: "Review the lifecycle event and try again.",
  failureMessage: "The asset lifecycle event could not be recorded.",
  auditReason: (body) => body.reason,
  invoke: (body, context, params) => recordAssetAdjustment({ context, assetId: params.assetId, ...body }),
});
