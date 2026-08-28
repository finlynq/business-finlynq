import { describe, expect, it } from "vitest";
import {
  exchangeSimpleFinSetupToken,
  isPublicSimpleFinAddress,
  validateSimpleFinEndpoint,
} from "@/modules/banking/simplefin-client";

describe("SimpleFIN network boundary", () => {
  it("rejects loopback, private, documentation, transition, and reserved addresses", () => {
    for (const address of [
      "127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.4",
      "198.51.100.3", "240.0.0.1", "::1", "fc00::1", "fe80::1",
      "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::",
    ]) expect(isPublicSimpleFinAddress(address), address).toBe(false);
    expect(isPublicSimpleFinAddress("8.8.8.8")).toBe(true);
    expect(isPublicSimpleFinAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("requires HTTPS/443, the requested credential policy, and exclusively public DNS answers", async () => {
    const publicResolver = async () => [{ address: "8.8.8.8", family: 4 as const }];
    await expect(validateSimpleFinEndpoint("http://provider.example/claim", {
      credentials: "forbid", resolver: publicResolver,
    })).rejects.toMatchObject({ code: "UNSAFE_ENDPOINT" });
    await expect(validateSimpleFinEndpoint("https://provider.example:8443/claim", {
      credentials: "forbid", resolver: publicResolver,
    })).rejects.toMatchObject({ code: "UNSAFE_ENDPOINT" });
    await expect(validateSimpleFinEndpoint("https://user:secret@provider.example/access", {
      credentials: "forbid", resolver: publicResolver,
    })).rejects.toMatchObject({ code: "UNSAFE_ENDPOINT" });
    await expect(validateSimpleFinEndpoint("https://provider.example/access", {
      credentials: "require", resolver: publicResolver,
    })).rejects.toMatchObject({ code: "UNSAFE_ENDPOINT" });
    await expect(validateSimpleFinEndpoint("https://provider.example/claim", {
      credentials: "forbid",
      resolver: async () => [
        { address: "8.8.8.8", family: 4 as const },
        { address: "127.0.0.1", family: 4 as const },
      ],
    })).rejects.toMatchObject({ code: "UNSAFE_ENDPOINT" });
    await expect(validateSimpleFinEndpoint("https://provider.example/claim", {
      credentials: "forbid", resolver: publicResolver,
    })).resolves.toMatchObject({ addresses: [{ address: "8.8.8.8", family: 4 }] });
  });

  it("rejects malformed non-canonical setup tokens before any network request", async () => {
    await expect(exchangeSimpleFinSetupToken("A".repeat(21), {
      resolver: async () => { throw new Error("resolver must not run"); },
    })).rejects.toMatchObject({ code: "INVALID_SETUP_TOKEN" });
  });
});
