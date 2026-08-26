import { describe, expect, it, vi } from "vitest";
import { loadOrganizationRootKek } from "@/security/root-secret";

const encodedRootKey = Buffer.alloc(32, 0x5a).toString("base64");

describe("organization root-secret loading", () => {
  it("loads a production root key from the configured secret file", () => {
    const readTextFile = vi.fn(() => `${encodedRootKey}\n`);

    const key = loadOrganizationRootKek({
      environment: {
        NODE_ENV: "production",
        ORGANIZATION_ROOT_KEK_FILE: "/run/secrets/business_finlynq_root_kek",
      },
      readTextFile,
    });

    expect(key.equals(Buffer.alloc(32, 0x5a))).toBe(true);
    expect(readTextFile).toHaveBeenCalledWith("/run/secrets/business_finlynq_root_kek");
  });

  it("rejects an inline root key in production", () => {
    expect(() =>
      loadOrganizationRootKek({
        environment: { NODE_ENV: "production", ORGANIZATION_ROOT_KEK: encodedRootKey },
      }),
    ).toThrow(/requires ORGANIZATION_ROOT_KEK_FILE/);
  });

  it("permits an inline root key only for local development and tests", () => {
    const key = loadOrganizationRootKek({
      environment: { NODE_ENV: "test", ORGANIZATION_ROOT_KEK: encodedRootKey },
    });

    expect(key.equals(Buffer.alloc(32, 0x5a))).toBe(true);
  });

  it("rejects conflicting, malformed, and incorrectly sized root keys", () => {
    expect(() =>
      loadOrganizationRootKek({
        environment: {
          NODE_ENV: "test",
          ORGANIZATION_ROOT_KEK: encodedRootKey,
          ORGANIZATION_ROOT_KEK_FILE: "/run/secrets/root",
        },
      }),
    ).toThrow(/only ORGANIZATION_ROOT_KEK_FILE/);

    expect(() =>
      loadOrganizationRootKek({
        environment: { NODE_ENV: "test", ORGANIZATION_ROOT_KEK: "not base64" },
      }),
    ).toThrow(/canonical base64/);

    expect(() =>
      loadOrganizationRootKek({
        environment: {
          NODE_ENV: "production",
          ORGANIZATION_ROOT_KEK_FILE: "/run/secrets/root",
        },
        readTextFile: () => Buffer.alloc(16).toString("base64"),
      }),
    ).toThrow(/exactly 32 bytes/);
  });
});
