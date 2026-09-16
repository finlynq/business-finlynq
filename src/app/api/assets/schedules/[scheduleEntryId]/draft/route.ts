import { z } from "zod";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { generateAssetScheduleJournal } from "@/modules/assets/service";

export const POST = createMutationRoute({
  schema: z.object({ idempotencyKey: z.string().trim().min(1).max(180) }).strict(),
  paramsSchema: z.object({ scheduleEntryId: z.uuid() }).strict(),
  invalidParamsMessage: "The schedule entry identifier is invalid.",
  invalidParamsStatus: 400,
  operation: "asset schedule journal generation",
  rateAction: "create",
  maximumBytes: 8_000,
  invalidMessage: "The schedule journal request is invalid.",
  failureMessage: "The balanced schedule journal could not be generated.",
  auditReason: () => "Generate an asset schedule journal draft",
  invoke: (body, context, params) => generateAssetScheduleJournal({
    context,
    scheduleEntryId: params.scheduleEntryId,
    idempotencyKey: body.idempotencyKey,
  }),
});
