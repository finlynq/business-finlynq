import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const digestPattern = "sha256:[a-f0-9]{64}";

describe("external container supply-chain pins", () => {
  it("pins every Dockerfile base to a readable tag and immutable digest", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const externalBases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)]
      .map((match) => match[1])
      .filter((image) => image !== "dependencies");

    expect(externalBases.length).toBeGreaterThan(0);
    for (const image of externalBases) {
      expect(image).toMatch(new RegExp(`^[^@\\s]+@${digestPattern}$`));
    }
  });

  it("pins the production PostgreSQL and Caddy services", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");

    expect(compose).not.toMatch(/^\s*image:\s+(?:postgres|caddy):[^@\s]+\s*$/gm);
    expect(compose).toMatch(new RegExp(`image: postgres:16-alpine@${digestPattern}`));
    expect(compose).toMatch(new RegExp(`image: caddy:2\\.10\\.2-alpine@${digestPattern}`));
  });
});
