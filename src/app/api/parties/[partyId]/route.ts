import { z } from "zod";
import { createMutationRoute } from "@/app/api/_shared/subledger-mutation-route";
import { hasRecentStepUp } from "@/modules/identity/session";
import { updateParty, updatePartySchema } from "@/modules/parties/party-lifecycle-service";

const bodySchema = updatePartySchema.omit({ partyId: true });
const paramsSchema = z.object({ partyId: z.uuid() });

export const PATCH = createMutationRoute({
  schema: bodySchema,
  paramsSchema,
  operation: "party correction",
  rateAction: "party",
  maximumBytes: 16_000,
  successStatus: 200,
  unauthorizedMessage: "An authorized real organization session is required.",
  forbiddenMessage: "Only an active organization owner can correct a party.",
  invalidParamsMessage: "An authorized organization party is required.",
  invalidParamsStatus: 403,
  invalidMessage: "Provide the current party values, corrected name, and a permanent reason.",
  failureMessage: "The party could not be corrected. Refresh the directory and verify your owner role and MFA assurance.",
  auditReason: (body) => body.reason,
  authorize: (_body, principal) => principal.sessionMode !== "real"
    ? { error: "Party corrections are unavailable in the public demo.", status: 403 }
    : !hasRecentStepUp(principal)
      ? { error: "Current MFA assurance is required before correcting a party.", status: 428 }
      : undefined,
  invoke: (body, context, params) => updateParty({
    context,
    partyId: params.partyId,
    ...body,
  }),
});
