import { observeRouteHandler } from "@/observability/request-observability";
import { NextRequest, NextResponse } from "next/server";
import { requestPrincipal } from "@/modules/identity/session";
import { finishStorageConnection } from "@/modules/document-storage/connections";
import { providerSchema } from "@/modules/document-storage/model";
import { providerConfiguration, StorageError } from "@/modules/document-storage/provider";

const failureOutcomes: Readonly<Record<string, string>> = {
  STORAGE_ACCOUNT_MISMATCH: "original-account",
  STORAGE_MISSING: "folder-unavailable",
  STORAGE_FOLDER_BOUNDARY: "folder-unavailable",
  STORAGE_OAUTH_EXPIRED: "authorization-expired",
  STORAGE_RECONNECT: "authorization-expired",
  STORAGE_AUTHORIZATION_UNSUPPORTED: "unsupported-access",
  STORAGE_SCOPE_EXCESSIVE: "excessive-access",
};

async function callback(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
  let destination: URL | undefined;
  try {
    const provider = providerSchema.parse((await context.params).provider);
    destination = new URL("/app/settings/documents", providerConfiguration(provider).redirectUri);
    const principal = await requestPrincipal(request);
    if (!principal || principal.sessionMode !== "real" || request.nextUrl.searchParams.has("error")) throw new Error("Storage authorization was not completed");
    await finishStorageConnection(principal, provider, request.nextUrl.searchParams.get("state") ?? "", request.nextUrl.searchParams.get("code") ?? "");
    destination.searchParams.set("storage", "connected");
  } catch (error) {
    if (!destination) return NextResponse.json({ error: "This storage connection is unavailable." }, { status: 400, headers });
    destination.searchParams.set("storage", error instanceof StorageError && Object.hasOwn(failureOutcomes, error.code) ? failureOutcomes[error.code] : "failed");
  }
  // Neither authorization codes nor provider error text are rendered or logged.
  return NextResponse.redirect(destination, { status: 303, headers });
}

export const GET = observeRouteHandler("document-storage-callback", callback);
