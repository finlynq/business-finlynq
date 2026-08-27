import { NextResponse } from "next/server";
import { isDemoSessionLeaseLostError } from "@/db/errors";
import { clearSessionCookie } from "@/modules/identity/session";

const noStoreHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
};

/**
 * Converts only the typed, fail-closed demo lease race into an authentication
 * response. The browser-local demo claim remains intact so a later demo entry
 * can return to the same daily sandbox.
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
