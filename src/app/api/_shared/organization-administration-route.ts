import { NextRequest, NextResponse } from "next/server";
import type { ZodType } from "zod";
import { demoSessionLeaseLostResponse } from "@/app/api/_shared/demo-session-error-response";
import { consumeRateLimit } from "@/modules/identity/auth-store";
import { organizationAdministrationFailure } from "@/modules/identity/organization-administration";
import {
  requestFingerprints,
  validateSameOriginMutation,
} from "@/modules/identity/request-security";
import { requestPrincipal, type SessionPrincipal } from "@/modules/identity/session";
import { readBoundedJson, MutationBodyError } from "@/modules/ledger/request-body";
import { demoWritesEnabled } from "@/modules/workspace/write-policy";
import { identityLookupHash } from "@/security/identity-secret";

export const organizationAdminHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
};

type PrincipalResult =
  | Readonly<{ principal: SessionPrincipal; response?: never }>
  | Readonly<{ principal?: never; response: NextResponse }>;

export async function prepareOrganizationAdminMutation(
  request: NextRequest,
  action: string,
): Promise<PrincipalResult> {
  if (!validateSameOriginMutation(request)) {
    return {
      response: NextResponse.json(
        { error: "The request could not be verified." },
        { status: 403, headers: organizationAdminHeaders },
      ),
    };
  }
  const principal = await requestPrincipal(request);
  if (!principal) {
    return {
      response: NextResponse.json(
        { error: "Sign in to continue." },
        { status: 401, headers: organizationAdminHeaders },
      ),
    };
  }
  if (principal.sessionMode === "demo" && !demoWritesEnabled()) {
    return {
      response: NextResponse.json(
        { error: "Demo changes are not available on this deployment." },
        { status: 403, headers: organizationAdminHeaders },
      ),
    };
  }

  const { ipHash } = requestFingerprints(request);
  const keyHash = identityLookupHash(
    `organization-administration|${principal.organizationId}|${ipHash}|${action}`,
  );
  const [minute, hour] = await Promise.all([
    consumeRateLimit(`organization-admin-${action}-minute`, keyHash, 20, 60),
    consumeRateLimit(`organization-admin-${action}-hour`, keyHash, 120, 3600),
  ]);
  if (!minute.allowed || !hour.allowed) {
    const retryAfter = Math.max(minute.retry_after_seconds, hour.retry_after_seconds);
    return {
      response: NextResponse.json(
        { error: "Too many organization changes. Try again later." },
        {
          status: 429,
          headers: { ...organizationAdminHeaders, "Retry-After": String(retryAfter) },
        },
      ),
    };
  }
  return { principal };
}

export async function readOrganizationAdminJson<Output>(
  request: NextRequest,
  schema: ZodType<Output>,
  maxBytes = 16_384,
): Promise<Readonly<{ data: Output; response?: never }> | Readonly<{ data?: never; response: NextResponse }>> {
  try {
    const parsed = schema.safeParse(await readBoundedJson(request, maxBytes));
    if (!parsed.success) {
      return {
        response: NextResponse.json(
          { error: "Check the organization administration fields and try again." },
          { status: 400, headers: organizationAdminHeaders },
        ),
      };
    }
    return { data: parsed.data };
  } catch (error) {
    if (error instanceof MutationBodyError) {
      return {
        response: NextResponse.json(
          { error: error.message },
          { status: error.status, headers: organizationAdminHeaders },
        ),
      };
    }
    throw error;
  }
}

export function organizationAdminErrorResponse(error: unknown, operation: string): NextResponse {
  const expiredSession = demoSessionLeaseLostResponse(error);
  if (expiredSession) return expiredSession;
  const failure = organizationAdministrationFailure(error);
  console.error("Business Finlynq organization administration failed", {
    operation,
    code: failure.code,
  });
  return NextResponse.json(
    { error: failure.message, code: failure.code },
    { status: failure.status, headers: organizationAdminHeaders },
  );
}
