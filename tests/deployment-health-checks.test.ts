import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const revision = "a".repeat(40);
const previousRevision = "b".repeat(40);

for (const path of [
  "deploy/dev/deploy-dev.sh",
  "deploy/development/deploy-development.sh",
]) {
  const source = readFileSync(path, "utf8");
  const stateStart = source.indexOf('\naccepted_revision=""\n');
  const stateEnd = source.indexOf('if [[ -z "$accepted_revision" ]]; then', stateStart);
  const sameStart = source.indexOf(
    'if [[ "$source_revision" == "$candidate_revision" ]]; then',
    stateEnd,
  );
  const sameEnd = source.indexOf("\nmutated=false", sameStart);
  const publicStart = source.indexOf("run_public_acceptance() {");
  const publicEnd = source.indexOf("\ncontain_uncommitted_development_router_on_exit()", publicStart);
  const writerStart = source.indexOf("write_accepted_revision() {");
  const writerEnd = source.indexOf("\nrestore_accepted_revision_pointer()", writerStart);
  if (stateStart < 0 || stateEnd < stateStart || sameStart < stateEnd || sameEnd < sameStart) {
    throw new Error(`Cannot locate deployment checks in ${path}`);
  }
  if (publicStart < 0 || publicEnd < publicStart || writerStart < 0 || writerEnd < writerStart) {
    throw new Error(`Cannot locate acceptance helpers in ${path}`);
  }

  // Execute the actual acceptance-state reader and unchanged-release branch.
  // Stub external effects so these tests never touch a host or a container.
  const script = `
set -Eeuo pipefail
source_revision="$SOURCE_REVISION"
candidate_revision="$CANDIDATE_REVISION"
accepted_revision_file="$STATE_FILE"
project=test-project
development_router_live_uncommitted=false
release_acceptance_token=""
public_acceptance_verified_revision=""
fail() { printf '%s\n' "$*" >&2; exit 1; }
validate_revision() { return 0; }
read_state_value() {
  case "$2" in
    revision) printf '%s' "$INITIAL_ACCEPTED_REVISION" ;;
    publicAcceptanceVerified) printf '%s' "$PUBLIC_VERIFIED" ;;
    *) return 1 ;;
  esac
}
grep() { [[ "$HAS_PUBLIC_RECORD" == true ]]; }
git_as_deploy() { return 0; }
revision_release_topology() { printf '%s' "$TOPOLOGY"; }
release_is_accepted() {
  local policy=full
  if [[ "$#" == 2 ]]; then policy="$2"; fi
  printf 'health:%s\n' "$policy"
  if [[ "$policy" == private ]]; then
    return "$PRIVATE_HEALTH_STATUS"
  fi
  return "$PUBLIC_HEALTH_STATUS"
}
read_environment_value() { printf '%s' "$REQUIRE_PUBLIC_ACCEPTANCE"; }
running_release_router_container() { printf 'test-router'; }
docker() { printf '%s' "$ROUTER_MODE"; }
reload_release_router_live() { printf 'reload:%s\n' "$1"; }
wait_for_public_readiness() { return 0; }
compose() { printf 'browser-tests\n'; return "$BROWSER_STATUS"; }
verify_external_edge_if_selected() {
  local boundary=normal
  if [[ "$#" == 2 ]]; then boundary="$2"; fi
  printf 'edge:%s\n' "$boundary"
}
commit_release_router_acceptance() { printf 'commit\n'; return "$COMMIT_STATUS"; }
write_accepted_revision() { printf 'record-accepted\n'; }
verify_shared_scanner_if_selected() { printf 'scanner\n'; }
${source.slice(publicStart, publicEnd)}
${source.slice(stateStart, stateEnd)}
accepted_revision="$CURRENT_ACCEPTED_REVISION"
${source.slice(sameStart, sameEnd)}
printf 'new-release-or-reconciliation\n'
`;

  function run(overrides: Record<string, string> = {}) {
    return spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        SOURCE_REVISION: revision,
        CANDIDATE_REVISION: revision,
        INITIAL_ACCEPTED_REVISION: revision,
        CURRENT_ACCEPTED_REVISION: revision,
        HAS_PUBLIC_RECORD: "true",
        PUBLIC_VERIFIED: "true",
        STATE_FILE: "/dev/null",
        TOPOLOGY: "router",
        ROUTER_MODE: "active",
        REQUIRE_PUBLIC_ACCEPTANCE: "true",
        PRIVATE_HEALTH_STATUS: "0",
        PUBLIC_HEALTH_STATUS: "0",
        BROWSER_STATUS: "0",
        COMMIT_STATUS: "0",
        ...overrides,
      },
    });
  }

  describe(path, () => {
    it("checks an unchanged accepted release without browser tests or runtime changes", () => {
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("health:private\n");
      expect(result.stdout).toContain("health:full\n");
      expect(result.stdout).toContain("edge:normal\n");
      expect(result.stdout).toContain("scanner\n");
      expect(result.stdout).toContain("full acceptance skipped");
      expect(result.stdout).not.toMatch(/browser-tests|reload:|commit|record-accepted|new-release-or-reconciliation/);
    });

    it("runs full browser acceptance before committing a recovered maintenance router", () => {
      const result = run({ ROUTER_MODE: "maintenance" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("reload:active\n");
      expect(result.stdout).toContain("edge:live-uncommitted\n");
      expect(result.stdout.indexOf("browser-tests")).toBeLessThan(result.stdout.indexOf("commit"));
      expect(result.stdout).not.toContain("full acceptance skipped");
    });

    it("keeps full tests after recovery updates the accepted revision in this run", () => {
      const result = run({ INITIAL_ACCEPTED_REVISION: previousRevision });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("browser-tests\n");
      expect(result.stdout).not.toContain("full acceptance skipped");
    });

    it("runs full tests when reconstructing a missing acceptance record", () => {
      const result = run({ STATE_FILE: "/nonexistent-business-finlynq-acceptance-record" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("browser-tests\n");
    });

    it.each([
      { HAS_PUBLIC_RECORD: "false", PUBLIC_VERIFIED: "true" },
      { HAS_PUBLIC_RECORD: "true", PUBLIC_VERIFIED: "false" },
    ])("establishes public acceptance once when its evidence is missing: %j", (settings) => {
      const result = run(settings);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("browser-tests\n");
      expect(result.stdout).toContain("record-accepted\n");
      expect(result.stdout).not.toContain("full acceptance skipped");
    });

    it("refuses malformed public acceptance evidence", () => {
      const result = run({ PUBLIC_VERIFIED: "invalid" });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toMatch(/browser-tests|full acceptance skipped/);
    });

    it("leaves a new revision on the full deployment path", () => {
      const result = run({ CANDIDATE_REVISION: previousRevision });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("new-release-or-reconciliation\n");
    });

    it("leaves runtime or configuration drift on the reconciliation path", () => {
      const result = run({ PRIVATE_HEALTH_STATUS: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("new-release-or-reconciliation\n");
      expect(result.stdout).not.toContain("full acceptance skipped");
    });

    it("reports a failed public health check without launching browser tests", () => {
      const result = run({ PUBLIC_HEALTH_STATUS: "1" });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("health:full\n");
      expect(result.stdout).not.toMatch(/browser-tests|full acceptance skipped|commit/);
    });

    it("does not commit recovery if full browser acceptance fails", () => {
      const result = run({ ROUTER_MODE: "maintenance", BROWSER_STATUS: "1" });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("browser-tests\n");
      expect(result.stdout).not.toContain("commit\n");
    });

    it("fails closed on an invalid router mode", () => {
      const result = run({ ROUTER_MODE: "invalid" });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toMatch(/browser-tests|full acceptance skipped|commit/);
    });

    it("respects an environment that has not enabled public acceptance", () => {
      const result = run({ REQUIRE_PUBLIC_ACCEPTANCE: "false" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("health:full\n");
      expect(result.stdout).not.toMatch(/browser-tests|edge:/);
    });

    it("also skips browser tests for an accepted legacy runtime", () => {
      const result = run({ TOPOLOGY: "legacy" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("health:full\n");
      expect(result.stdout).not.toMatch(/browser-tests|reload:|commit/);
    });

    it.each([
      { verifiedRevision: revision, expected: "true" },
      { verifiedRevision: previousRevision, expected: "false" },
      { verifiedRevision: "", expected: "false" },
    ])("records public acceptance only for its verified revision: %j", ({ verifiedRevision, expected }) => {
      const directory = mkdtempSync(join(tmpdir(), "finlynq-acceptance-"));
      const stateFile = join(directory, "accepted-revision");
      try {
        const result = spawnSync("bash", ["-c", `
set -Eeuo pipefail
accepted_revision_file="$STATE_FILE"
state_directory="$STATE_DIRECTORY"
public_acceptance_verified_revision="$VERIFIED_REVISION"
fail() { printf '%s' "$*" >&2; exit 1; }
validate_revision() { return 0; }
chown() { return 0; }
sync() { return 0; }
${source.slice(writerStart, writerEnd)}
write_accepted_revision "$REVISION"
`], {
          encoding: "utf8",
          env: {
            ...process.env,
            STATE_FILE: stateFile,
            STATE_DIRECTORY: directory,
            VERIFIED_REVISION: verifiedRevision,
            REVISION: revision,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(stateFile, "utf8")).toContain(`publicAcceptanceVerified=${expected}\n`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
}
