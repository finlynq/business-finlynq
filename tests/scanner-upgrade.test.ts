import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const relative = "deploy/evidence/shared/compose-contract.sh";
const contract = readFileSync(relative, "utf8");
for (const [deployer, project] of [
  ["deploy/dev/deploy-dev.sh", "business-finlynq-dev"],
  ["deploy/development/deploy-development.sh", "business-finlynq-development"],
]) {
  describe(`${project} scanner upgrade`, () => {
    const source = readFileSync(deployer, "utf8");
    const start = source.indexOf("scanner_compose_inputs() {");
    const inputFunction = source.slice(start, source.indexOf("\ncompose() {", start));

    for (const mode of ["local", "shared"]) {
      for (const state of ["matching", "other-mode", "unhealthy", "ambiguous"]) {
        it(`checks the real scanner for a same-revision ${mode} ${state} deployment`, () => {
          const expected = mode === "shared" ? { image: "node:pinned", user: "10001:10001" } : { image: "clamav:pinned", user: "100:101" };
          const observed = state === "other-mode" ? { image: "other:pinned", user: "2000:2000" } : expected;
          const row = { Config: { Image: observed.image, User: observed.user }, State: { Running: true, Health: { Status: state === "unhealthy" ? "unhealthy" : "healthy" } } };
          const id = "a".repeat(64);
          const result = spawnSync("bash", ["-euc", inputFunction + '\ndocker(){ case "$1" in ps) printf "%s" "$fixture_ids";; inspect) printf "%s" "$fixture_rows";; *) return 1;; esac; };\nscanner_runtime_matches "$fixture_rendered"'], {
            env: { ...process.env, project, fixture_ids: state === "ambiguous" ? id + "\n" + id : id,
              fixture_rows: JSON.stringify([row]), fixture_rendered: JSON.stringify({ services: { evidence_scanner: expected } }) }, encoding: "utf8",
          });
          if (state === "matching") expect(result.status, result.stderr).toBe(0);
          else expect(result.status).not.toBe(0);
        });
      }
    }

    for (const scenario of ["predecessor", "candidate", "missing", "symlink", "old-candidate"]) {
      it(`resolves the actual Git contract for ${scenario}`, () => {
        const directory = mkdtempSync(join(tmpdir(), "scanner-upgrade-"));
        const environment = join(directory, ".git", "scanner-fixture.env");
        const git = (...args: string[]) => {
          const result = spawnSync("git", ["-c", "user.name=Fictive fixture", "-c", "user.email=fixture@veltrix.example", "-C", directory, ...args], { encoding: "utf8" });
          expect(result.status, result.stderr).toBe(0);
          return result.stdout.trim();
        };
        try {
          git("init", "-q");
          writeFileSync(join(directory, "README"), "Fictive predecessor\n");
          git("add", "."); git("commit", "-qm", "predecessor");
          const oldRevision = git("rev-parse", "HEAD");
          mkdirSync(join(directory, "deploy/evidence/shared"), { recursive: true });
          writeFileSync(join(directory, relative), contract);
          git("add", "."); git("commit", "-qm", "shared scanner contract");
          const candidate = git("rev-parse", "HEAD");
          writeFileSync(environment, "BUSINESS_FINLYNQ_SCANNER_MODE=shared\n");
          if (scenario === "predecessor" || scenario === "old-candidate") git("checkout", "-q", oldRevision);
          if (scenario === "missing" || scenario === "symlink") rmSync(join(directory, relative));
          if (scenario === "symlink") symlinkSync(environment, join(directory, relative));
          const result = spawnSync("bash", ["-euc", 'git_as_deploy(){ git -C "$repository" "$@"; };\n' + inputFunction + '\nscanner_compose_inputs\nprintf \'%s|%s|%s\' "$scanner_mode" "${#scanner_files[@]}" "$scanner_channel"'], {
            env: { ...process.env, repository: directory, compose_environment: environment, project,
              candidate_revision: scenario === "old-candidate" ? oldRevision : candidate }, encoding: "utf8",
          });
          if (scenario === "predecessor") {
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toBe("local|0|");
          } else if (scenario === "candidate") {
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toBe(`shared|2|${project.endsWith("-dev") ? "business_dev" : "business_stage"}`);
          } else expect(result.status).not.toBe(0);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });
    }
  });
}
