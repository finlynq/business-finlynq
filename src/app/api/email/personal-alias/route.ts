import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { observeRouteHandler } from "@/observability/request-observability";
import { requestIdFor } from "@/observability/request-correlation";
import { requestPrincipal } from "@/modules/identity/session";
import { validateSameOriginMutation } from "@/modules/identity/request-security";
import { consumeLedgerMutationRateLimit } from "@/modules/ledger/mutation-rate-limit";
import { MutationBodyError, readBoundedJson } from "@/modules/ledger/request-body";
import { mutationContext } from "@/modules/workspace/write-policy";
import {
  configurePersonalEmailAlias,
  getPersonalEmailAlias,
  provisionPersonalEmailAlias,
  rotatePersonalEmailAlias,
} from "@/modules/email/configuration";

const responseHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("provision"), connectionId: z.uuid().optional() }).strict(),
  z.object({ action: z.literal("configure"), aliasId: z.uuid(), expectedVersion: z.number().int().positive(), connectionId: z.uuid().nullable() }).strict(),
  z.object({ action: z.literal("rotate"), aliasId: z.uuid(), expectedVersion: z.number().int().positive(), idempotencyKey: z.uuid() }).strict(),
]);

function failure(error: unknown): NextResponse {
  if (error instanceof MutationBodyError) {
    return NextResponse.json({ error: error.message }, { status: error.status, headers: responseHeaders });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "Check the personal email settings and try again." }, { status: 400, headers: responseHeaders });
  }
  const safeMessages = new Set([
    "Your organization membership is not active",
    "Email alias storage connection is unavailable or belongs to another module",
    "Personal email address changed; reload before updating storage",
    "Personal address rotation requires the exact active version",
    "Personal address rotation key was already used differently",
    "Business writes are disabled",
  ]);
  const message = error instanceof Error && safeMessages.has(error.message)
    ? error.message
    : "The personal email address could not be updated. Check your access and try again.";
  return NextResponse.json({ error: message }, { status: 409, headers: responseHeaders });
}

async function get(request: NextRequest) {
  try {
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") {
      return NextResponse.json({ error: "Sign in to a real account to use personal email intake." }, { status: 401, headers: responseHeaders });
    }
    const context = mutationContext(principal, requestIdFor(request), { sourceSurface: "API" });
    return NextResponse.json({ alias: await getPersonalEmailAlias(context, principal.membershipId) }, { headers: responseHeaders });
  } catch (error) {
    return failure(error);
  }
}

async function mutate(request: NextRequest) {
  try {
    if (!validateSameOriginMutation(request)) {
      return NextResponse.json({ error: "The request could not be verified." }, { status: 403, headers: responseHeaders });
    }
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real") {
      return NextResponse.json({ error: "Sign in to a real account to use personal email intake." }, { status: 401, headers: responseHeaders });
    }
    const rate = await consumeLedgerMutationRateLimit(principal, "create");
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Too many email address changes. Try again later." },
        { status: 429, headers: { ...responseHeaders, "Retry-After": String(rate.retryAfterSeconds) } },
      );
    }
    const body = mutationSchema.parse(await readBoundedJson(request, 8_192));
    const reason = body.action === "rotate"
      ? "Rotate personal inbound email address"
      : body.action === "configure"
        ? "Configure personal inbound email storage"
        : "Provision personal inbound email address";
    const context = mutationContext(principal, requestIdFor(request), { reason, sourceSurface: "API" });
    const result = body.action === "rotate"
      ? await rotatePersonalEmailAlias({
        context,
        membershipId: principal.membershipId,
        aliasId: body.aliasId,
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        reason,
      })
      : body.action === "configure"
        ? await configurePersonalEmailAlias({
          context,
          membershipId: principal.membershipId,
          aliasId: body.aliasId,
          expectedVersion: body.expectedVersion,
          connectionId: body.connectionId,
          reason,
        })
        : await provisionPersonalEmailAlias({
          context,
          membershipId: principal.membershipId,
          ...(body.connectionId ? { connectionId: body.connectionId } : {}),
          reason,
        });
    return NextResponse.json(result, { headers: responseHeaders });
  } catch (error) {
    return failure(error);
  }
}

export const GET = observeRouteHandler("personal-email-alias", get);
export const POST = observeRouteHandler("personal-email-alias", mutate);
