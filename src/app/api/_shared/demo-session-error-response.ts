import { NextResponse } from "next/server";
import { isDemoSessionLeaseLostError } from "@/db/errors";
import { clearSessionCookie } from "@/modules/identity/session";

const noStoreHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
};

/**
 * Converts only the typed, fail-closed shared-demo reset race into an
 * authentication response. A later demo entry creates a fresh session in the
 * same shared company after maintenance completes.
 */
export function demoSessionLeaseLostResponse(error: unknown): NextResponse | null {
  if (!isDemoSessionLeaseLostError(error)) return null;

  const response = NextResponse.json(
    { error: "The demo session expired. Open the demo again to continue." },
    { status: 401, headers: noStoreHeaders },
  );
  clearSessionCookie(response);
  return response;
}
