import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { logRouteFailure } from "@/app/api/_shared/route-failure-log";
import { requestIdFor } from "@/observability/request-correlation";
import { observeRouteHandler } from "@/observability/request-observability";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { requestPrincipal } from "@/modules/identity/session";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import {
  setWorkspaceEntityContextCookie,
  validateWorkspaceEntitySelection,
} from "@/modules/workspace/entity-context";

const noStoreHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
} as const;

const selectionSchema = z.object({
  entityId: z.uuid(),
}).strict();

async function put(request: NextRequest) {
  const requestId = requestIdFor(request);
  try {
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json(
        { error: "The entity selection request could not be verified." },
        { status: 403, headers: noStoreHeaders },
      );
    }

    const principal = await requestPrincipal(request);
    if (!principal) {
      return NextResponse.json(
        { error: "An authenticated organization session is required." },
        { status: 401, headers: noStoreHeaders },
      );
    }

    let unparsedBody: unknown;
    try {
      unparsedBody = await readBoundedJson(request, 1_024);
    } catch (error) {
      if (error instanceof MutationBodyError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status, headers: noStoreHeaders },
        );
      }
      throw error;
    }

    const parsed = selectionSchema.safeParse(unparsedBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Choose a valid legal entity and try again." },
        { status: 400, headers: noStoreHeaders },
      );
    }

    const selectedEntity = await validateWorkspaceEntitySelection(
      principal,
      parsed.data.entityId,
    );
    if (!selectedEntity) {
      return NextResponse.json(
        { error: "That legal entity is not available in this organization." },
        { status: 404, headers: noStoreHeaders },
      );
    }

    const response = NextResponse.json(
      { selectedEntity },
      { headers: noStoreHeaders },
    );
    setWorkspaceEntityContextCookie(response, selectedEntity.id);
    return response;
  } catch (error) {
    const expiredSession = demoSessionLeaseLostResponse(error);
    if (expiredSession) return expiredSession;
    logRouteFailure("entity-context-selection", requestId, error);
    return NextResponse.json(
      { error: "The legal entity selection could not be saved." },
      { status: 503, headers: noStoreHeaders },
    );
  }
}

export const PUT = observeRouteHandler("entity-context-selection", put);
