import { isAuthorizationDeniedError } from "@/modules/identity/authorization-error";
import { StorageError } from "@/modules/document-storage/provider";

export const INBOUND_RETRY_INTERVAL_MS = 30_000;
export const INBOUND_RETRY_BATCH = 10;

export function retryDelaySeconds(retryCount: number): number {
  return [60, 120, 300, 900, 3600][Math.min(Math.max(retryCount, 0), 4)];
}

export function inboundFailure(error: unknown): Readonly<{
  code: string; stage: "AUTHORIZATION" | "CONFIGURATION" | "STORAGE" | "SCAN" | "CONTENT";
  quarantine: boolean;
}> {
  if (isAuthorizationDeniedError(error)) {
    return { code: "INBOUND_ACCESS_DENIED", stage: "AUTHORIZATION", quarantine: true };
  }
  if (error instanceof StorageError) {
    if (["STORAGE_REAL_ACCOUNT", "STORAGE_SCOPE_MISSING", "STORAGE_SCOPE_EXCESSIVE"].includes(error.code)) {
      return { code: error.code, stage: "AUTHORIZATION", quarantine: true };
    }
    if (["STORAGE_NOT_CONFIGURED", "STORAGE_DISCONNECTED", "STORAGE_RECONNECT"].includes(error.code)) {
      return { code: error.code, stage: "CONFIGURATION", quarantine: false };
    }
    if (["STORAGE_UPLOAD_CONFLICT", "STORAGE_FOLDER_BOUNDARY", "STORAGE_ACCOUNT_MISMATCH", "STORAGE_TOO_LARGE"].includes(error.code)) {
      return { code: error.code, stage: "STORAGE", quarantine: true };
    }
    if (["STORAGE_RETRYABLE", "STORAGE_THROTTLED", "STORAGE_PROVIDER_FAILED", "STORAGE_MISSING"].includes(error.code)) {
      return { code: error.code, stage: "STORAGE", quarantine: false };
    }
  }
  // Classify existing scanner/content errors, but never retain their raw text.
  const message = error instanceof Error ? error.message : "";
  if (/malware|password|encrypted|unsupported|invalid evidence/i.test(message)) {
    return { code: "ATTACHMENT_SECURITY_REJECTED", stage: "SCAN", quarantine: true };
  }
  if (/evidence scann|completely scanned/i.test(message)) {
    return { code: "SCANNER_UNAVAILABLE", stage: "SCAN", quarantine: false };
  }
  if (/Staged email attachment/i.test(message)) {
    return { code: "ATTACHMENT_CONTENT_UNAVAILABLE", stage: "CONTENT", quarantine: true };
  }
  return { code: "STORAGE_RETRYABLE", stage: "STORAGE", quarantine: false };
}
