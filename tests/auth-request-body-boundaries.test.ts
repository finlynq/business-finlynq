import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const jsonMutationRoutes = [
  "src/app/api/auth/invitations/accept/route.ts",
  "src/app/api/auth/login/route.ts",
  "src/app/api/auth/mfa/enroll/confirm/route.ts",
  "src/app/api/auth/mfa/step-up/route.ts",
  "src/app/api/auth/password-reset/confirm/route.ts",
  "src/app/api/auth/password-reset/escalate/route.ts",
  "src/app/api/auth/password-reset/request/route.ts",
  "src/app/api/auth/recovery/approve/route.ts",
  "src/app/api/auth/signup/accept/route.ts",
  "src/app/api/auth/signup/request/route.ts",
] as const;

describe("public authentication request-body boundaries", () => {
  it.each(jsonMutationRoutes)("uses the bounded JSON reader in %s", (routePath) => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("readAuthMutationJson(request)");
    expect(source).not.toMatch(/request\.json\s*\(/);
  });

  it.each(["deploy/Caddyfile.container", "deploy/Caddyfile.example"])(
    "limits authentication mutation bodies at the edge in %s",
    (caddyfilePath) => {
      const source = readFileSync(caddyfilePath, "utf8");
      expect(source).toMatch(/@auth_mutations\s*\{[\s\S]*?path \/api\/auth\/\*[\s\S]*?method POST[\s\S]*?\}/);
      expect(source).toMatch(/request_body @auth_mutations\s*\{\s*max_size 16KB\s*\}/);
    },
  );
});
