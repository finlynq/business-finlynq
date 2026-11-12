import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

for (const installer of ["deploy/dev/install-dev.sh", "deploy/development/install-development.sh"]) {
  describe(installer, () => {
    const source = readFileSync(installer, "utf8");
    const begin = source.indexOf('if [[ -n "$scanner_mode" ]]; then');
    const end = source.indexOf('if [[ -n "$yahoo_fx_mode" ]]; then', begin);
    const update = source.slice(begin, end);

    for (const initial of ["", "BUSINESS_FINLYNQ_SCANNER_MODE=local\n", "BUSINESS_FINLYNQ_SCANNER_MODE=shared\n"]) {
      it(`atomically selects either mode and preserves unrelated settings (${initial || "unset"})`, () => {
        const directory = mkdtempSync(join(tmpdir(), "scanner-mode-"));
        const environment = join(directory, "compose.env");
        const preserved = "SYNTHETIC_SETTING=fixture=value\nOTHER_GATE=false\n";
        try {
          writeFileSync(environment, preserved + initial, { mode: 0o600 });
          for (const mode of ["shared", "local"]) {
            const result = spawnSync("bash", ["-euc", `fail(){ exit 42; }; chown(){ :; }; ${update}`], {
              env: { ...process.env, scanner_mode: mode, configuration_directory: directory, compose_environment: environment },
              encoding: "utf8",
            });
            expect(result.status, result.stderr).toBe(0);
            expect(readFileSync(environment, "utf8")).toBe(preserved + `BUSINESS_FINLYNQ_SCANNER_MODE=${mode}\n`);
            expect(statSync(environment).mode & 0o777).toBe(0o600);
            expect(readdirSync(directory)).toEqual(["compose.env"]);
          }
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });
    }

    it("refuses ambiguous duplicate modes without replacing the environment", () => {
      const directory = mkdtempSync(join(tmpdir(), "scanner-mode-"));
      const environment = join(directory, "compose.env");
      const original = "BUSINESS_FINLYNQ_SCANNER_MODE=local\nBUSINESS_FINLYNQ_SCANNER_MODE=shared\n";
      try {
        writeFileSync(environment, original, { mode: 0o600 });
        const result = spawnSync("bash", ["-euc", `fail(){ exit 42; }; chown(){ :; }; ${update}`], {
          env: { ...process.env, scanner_mode: "shared", configuration_directory: directory, compose_environment: environment },
          encoding: "utf8",
        });
        expect(result.status).toBe(42);
        expect(readFileSync(environment, "utf8")).toBe(original);
        expect(readdirSync(directory)).toEqual(["compose.env"]);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    it("rejects an unknown mode before privileged installation", () => {
      const result = spawnSync("bash", [installer, "--scanner-mode", "disabled"], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--scanner-mode requires local or shared");
    });
  });
}
