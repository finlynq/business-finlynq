import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inboundWorkerContext } from "@/modules/email/worker-context";
import { realStorageContext } from "@/modules/document-storage/store";
import { inboundFailure, retryDelaySeconds } from "@/modules/email/retry-policy";
import { StorageError } from "@/modules/document-storage/provider";
import { AuthorizationDeniedError } from "@/modules/identity/authorization-error";

describe("inbound email worker storage authority", () => {
  it.each(["SELF_SMTP", "RESEND"] as const)("accepts the minted %s capability and rejects imitations", (provider) => {
    const context = inboundWorkerContext({ organizationId: randomUUID(), actorId: randomUUID(), requestId: randomUUID(), provider });
    expect(() => realStorageContext(context)).not.toThrow();
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => realStorageContext({ ...context })).toThrow(/signed-in real account/);
    expect(() => realStorageContext(JSON.parse(JSON.stringify(context)))).toThrow(/signed-in real account/);
    expect(() => realStorageContext({ ...context, organizationId: randomUUID() })).toThrow(/signed-in real account/);
    expect(() => realStorageContext({ ...context, sessionMode: "demo", sessionId: randomUUID() })).toThrow(/signed-in real account/);
  });

  it("preserves ordinary signed-in real-account access", () => {
    expect(() => realStorageContext({ organizationId: randomUUID(), actorId: randomUUID(),
      requestId: randomUUID(), sessionId: randomUUID(), sessionMode: "real", sourceSurface: "MCP", authMethod: "password+mfa" })).not.toThrow();
  });

  it("retains only safe codes and distinguishes authorization, configuration, scan and transient errors", () => {
    const privateText = "private invoice https://example.test/?token=private";
    expect(inboundFailure(new StorageError("STORAGE_RECONNECT", privateText))).toEqual({
      code: "STORAGE_RECONNECT", stage: "CONFIGURATION", quarantine: false,
    });
    expect(inboundFailure(new AuthorizationDeniedError(privateText))).toEqual({
      code: "INBOUND_ACCESS_DENIED", stage: "AUTHORIZATION", quarantine: true,
    });
    expect(inboundFailure(new Error("Evidence rejected by malware scanning"))).toMatchObject({ stage: "SCAN", quarantine: true });
    expect(inboundFailure(new Error("Evidence scanner timed out"))).toMatchObject({ code: "SCANNER_UNAVAILABLE", quarantine: false });
    expect(JSON.stringify(inboundFailure(new StorageError(privateText, privateText)))).not.toContain("private");
    expect(inboundFailure(new Error(privateText))).toMatchObject({ code: "STORAGE_RETRYABLE", quarantine: false });
    expect([0, 1, 2, 3, 4, 5].map(retryDelaySeconds)).toEqual([60, 120, 300, 900, 3600, 3600]);
  });
});
