import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");
const runner = source("deploy/release/run-release.sh");
const monitor = source("deploy/monitoring/check-production.sh");
const deployMain = source("deploy/continuous-deployment/deploy-main.sh");

describe("contained initial production release", () => {
  it("has an explicit, acknowledged initial and exact-parent resume contract", () => {
    expect(runner).toContain('"$mode" == "initial"');
    expect(runner).toContain("--resume-initial <prior-initial-run-id>");
    expect(runner).toContain(
      '"resume:$revision:$initial_resume_run_id:$run_id"',
    );
    expect(runner).toContain(
      'prior_evidence_directory="$evidence_root/$revision/$initial_resume_run_id"',
    );
    expect(runner).toContain("sha256sum --check --strict --quiet SHA256SUMS");
    expect(runner).toContain('.runId == $priorRunId and .initialTimersRemainDisabled == true');
    expect(runner).toContain("initial secret/input attestations changed");
    expect(runner).not.toContain("-name 99-failure.json -print");
  });

  it("requires the contained synthetic-demo posture and durable disabled inputs", () => {
    for (const contract of [
      '"$release_DEMO_LOGIN_ENABLED" == "true"',
      '"$release_DEMO_WRITES_ENABLED" == "true"',
      '"$release_ACCOUNT_LOGIN_ENABLED" == "false"',
      '"$release_ACCOUNT_SIGNUP_ENABLED" == "false"',
      '"$release_AUTH_EMAIL_DELIVERY_ENABLED" == "false"',
      '"$release_SIGNUP_TURNSTILE_ENABLED" == "false"',
      '"$release_BUSINESS_WRITES_ENABLED" == "false"',
      '"$release_BANK_FEEDS_ENABLED" == "false"',
      '"$release_YAHOO_FX_ENABLED" == "false"',
    ]) expect(runner).toContain(contract);
    expect(runner).toContain("one durable empty placeholder");
    expect(runner).toContain("06-initial-inputs.json");
    expect(runner).toContain("composeEnvironmentSha256");
    expect(runner).toContain("operationsEnvironmentSha256");
  });

  it("allows only an attested precreated ingress network on a fresh host", () => {
    expect(runner).toContain("fresh initial production requires no preexisting");
    expect(runner).toContain("business_finlynq_pgdata_clamav");
    expect(runner).toContain('Labels["com.docker.compose.volume"] == $logical');
    expect(runner).toContain('(.[0].Options == null or .[0].Options == {})');
    expect(runner).not.toContain('(.Options == null or .Options == {})');
    expect(runner).toContain('Labels["com.docker.compose.network"] == $logical');
    expect(runner).toContain('verify-external-edge.sh" --scope preflight');
    expect(runner).toContain('verify-external-edge.sh" --scope development');
    expect(runner).toContain("resumable $service_name container image ID differs from prior evidence");
  });

  it("boots, attests, and probes ClamAV before starting the application", () => {
    const rollback = runner.indexOf('12-rollback-artifact.json');
    const scanner = runner.indexOf('stage="initial-evidence-scanner-bootstrap"');
    const eicar = runner.indexOf('stage="initial-evidence-scanner-eicar-boundary"');
    const app = runner.indexOf('stage="candidate-readiness-with-writes-disabled"');
    expect(rollback).toBeGreaterThan(-1);
    expect(rollback).toBeLessThan(scanner);
    expect(scanner).toBeLessThan(eicar);
    expect(eicar).toBeLessThan(app);
    expect(runner).toContain("--no-build --force-recreate evidence_scanner");
    expect(runner).toContain("now - signature_mtime <= 604800");
    expect(runner).toContain("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
    expect(runner).toContain("eicarDetected: true");
    expect(runner).toContain('if [[ "$mode" == "initial" || "$mode" == "rehearsal" ]]');
    expect(runner).toContain('stage="rehearsal-evidence-scanner-bootstrap"');
    expect(runner).toContain('stage="rehearsal-evidence-scanner-eicar-boundary"');
    expect(runner).toContain('--arg volumeName "$scanner_volume_name"');
    expect(runner).toContain('--arg evidenceNetwork "$scanner_evidence_network_name"');
    expect(runner).toContain('--arg egressNetwork "$scanner_egress_network_name"');
  });

  it("backs up only after fresh migrations and never invents a prior app", () => {
    const migrations = runner.indexOf('stage="pre-traffic-migration-and-contract-verification"');
    const postBootstrap = runner.indexOf('stage="post-bootstrap-accounting-verification"');
    const initialBackup = runner.indexOf('stage="initial-post-migration-local-backup"');
    expect(migrations).toBeLessThan(postBootstrap);
    expect(postBootstrap).toBeLessThan(initialBackup);
    expect(runner).toContain('preMigrationBackup: "not-applicable"');
    expect(runner).toContain('previousApplication: null');
    expect(runner).toContain('previous: (if $previousImageId == "" then null');
    expect(runner).toContain('localEncryptedBackup: "verified"');
    expect(runner).toContain('offsiteDelivery: "deferred"');
  });

  it("installs but leaves all operation timers disabled, including on failure", () => {
    expect(runner).toContain("quiesce_and_verify_initial_schedulers");
    expect(runner).toContain("business-finlynq-continuous-deployment.timer");
    expect(runner).toContain('initial_schedule_installed="true"');
    expect(runner).toContain("contain_initial_schedule_on_failure");
    expect(runner).toContain('current_invocation" != "$previous_invocation');
    expect(runner).toContain('timersEnabled: false, timersActive: false');
    expect(monitor).toContain('MONITOR_EXPECT_SCHEDULERS_ACTIVE="${MONITOR_EXPECT_SCHEDULERS_ACTIVE:-true}"');
    expect(monitor).toContain("deferred scheduled operations timer is not exactly disabled");
  });

  it("cannot fall through to rehearsal cleanup and runs full external acceptance", () => {
    expect(runner).toContain('elif [[ "$mode" == "initial" ]]; then');
    expect(runner).toContain('if [[ "$mode" != rehearsal && "$edge_mode" == external ]]');
    const initialFinal = runner.lastIndexOf('elif [[ "$mode" == "initial" ]]; then');
    const rehearsalCleanup = runner.lastIndexOf('stage="clean-rehearsal-project"');
    expect(initialFinal).toBeLessThan(rehearsalCleanup);
    expect(runner.slice(initialFinal, rehearsalCleanup)).not.toContain("down --volumes");
  });

  it("durably publishes accepted and failed evidence inventories", () => {
    expect(runner).toContain("sync_evidence_inventory");
    expect(runner).toContain('sync -f -- "$evidence_directory/SHA256SUMS"');
    expect(runner).toContain('sync -f -- "$evidence_directory"');
    expect(runner).toContain("accepted release evidence could not be durably synchronized");
    expect(runner).toContain("do not use it for resume");
    expect(runner).toContain("if ! find . -maxdepth 1 -type f ! -name SHA256SUMS");
    expect(runner).toContain("mv -f -- .SHA256SUMS.partial SHA256SUMS || exit 1");
    expect(runner).toContain("browser-acceptance log checksum could not be read");
    expect(runner).toContain('failure_record_temporary="$evidence_directory/.99-failure.json.partial"');
    expect(runner).toContain('mv -- "$failure_record_temporary"');
    expect(runner).toContain('terminal_evidence_temporary="$evidence_directory/.90-release-complete.json.partial"');
    const terminalStage = runner.indexOf('stage="complete-evidence"');
    const preterminalInventory = runner.indexOf("refresh_checksums", terminalStage);
    const terminalRename = runner.indexOf('mv -- "$terminal_evidence_temporary"', terminalStage);
    const finalInventory = runner.indexOf("refresh_checksums", terminalRename);
    expect(preterminalInventory).toBeLessThan(terminalRename);
    expect(terminalRename).toBeLessThan(finalInventory);
  });

  it("logs in an isolated command scope and propagates every output boundary", () => {
    const start = runner.indexOf("run_logged() {");
    const end = runner.indexOf("\n}\n\ncaptured_compose_container_id", start);
    const helper = runner.slice(start, end);
    expect(helper).toContain("trap - EXIT ERR INT TERM");
    expect(helper).toContain("set -Eeuo pipefail");
    expect(helper).toContain(') >"$evidence_directory/$filename" 2>&1');
    expect(helper).not.toContain('"$@" 2>&1 | tee');
    expect(helper).toContain('if tee <"$evidence_directory/$filename"; then');
    expect(helper).toContain("(( command_status == 0 ))");
    expect(helper).toContain("(( display_status == 0 ))");
    expect(helper).toContain("(( chmod_status == 0 ))");
  });

  it.skipIf(process.platform === "win32")(
    "rejects command and tee failures independently in the logging boundary",
    () => {
      const temporary = mkdtempSync(join(tmpdir(), "business-run-logged-"));
      const fakeBin = join(temporary, "bin");
      const evidence = join(temporary, "evidence");
      try {
        mkdirSync(fakeBin);
        mkdirSync(evidence);
        const tee = join(fakeBin, "tee");
        writeFileSync(tee, "#!/usr/bin/env bash\n/usr/bin/cat\nexit \"${TEE_STATUS:-0}\"\n");
        chmodSync(tee, 0o755);
        const start = runner.indexOf("run_logged() {");
        const end = runner.indexOf("\n}\n\ncaptured_compose_container_id", start) + 2;
        const helper = runner.slice(start, end);
        const result = spawnSync("/bin/bash", ["-c", `
set -uo pipefail
PATH='${fakeBin}:/usr/bin:/bin'
evidence_directory='${evidence}'
${helper}
succeed() { printf '%s\\n' payload; }
fail_command() { printf '%s\\n' failed; return 42; }
fail_midway() { false; printf '%s\\n' unsafe >'${join(temporary, "continued")}'; }
export TEE_STATUS=73
set +e
run_logged tee.log succeed
tee_status=$?
export TEE_STATUS=0
run_logged command.log fail_command
command_status=$?
run_logged midway.log fail_midway
midway_status=$?
set -e
[[ "$tee_status" == 73 && "$command_status" == 42 && "$midway_status" != 0 \
  && ! -e '${join(temporary, "continued")}' ]]
`], { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it("retains resume state and arms each partial mutation in the parent", () => {
    const initialGate = runner.indexOf('stage="initial-fresh-state-contract"');
    const initialRun = runner.indexOf("run_logged 01-initial-fresh-state.log", initialGate);
    expect(runner.indexOf('initial_schedule_installed="true"', initialGate)).toBeLessThan(initialRun);
    expect(runner.indexOf('prior_evidence_directory="$evidence_root/$revision/$initial_resume_run_id"', initialGate))
      .toBeLessThan(initialRun);
    expect(runner.indexOf('initial_schedulers_verified="true"', initialRun)).toBeGreaterThan(initialRun);

    const pause = runner.indexOf("run_logged 20-pause-schedulers.log");
    expect(runner.lastIndexOf('scheduler_pause_attempted="true"', pause)).toBeLessThan(pause);
    const stop = runner.indexOf("run_logged 25-stop-write-surfaces.log");
    expect(runner.lastIndexOf('write_surface_containment_armed="true"', stop)).toBeLessThan(stop);
    for (const invocation of [
      "run_logged 50-pretraffic-up.log",
      "run_logged 55-bootstrap-up.log",
      "run_logged 58-post-bootstrap-accounting-up.log",
    ]) {
      const up = runner.indexOf(invocation);
      expect(runner.lastIndexOf('detached_mutator_containment_armed="true"', up)).toBeLessThan(up);
      expect(runner.indexOf('detached_mutator_containment_armed="false"', up)).toBeGreaterThan(up);
    }
    expect(runner).toContain("contain_project_services_on_failure");
    expect(runner).toContain('docker kill "$container_id"');
  });

  it("status-checks evidence assembly inside isolated logged functions", () => {
    expect(runner).toContain("container evidence could not be assembled");
    expect(runner).toContain("state evidence could not be written");
    expect(runner).toContain("evidence scanner signature evidence could not be assembled");
    expect(runner).toContain("evidence-scanner attestation could not be written");
    expect(runner).toContain("immutable backup evidence could not be written");
  });

  it("status-checks exact initial inventories and resume container fields", () => {
    expect(runner).toContain('if ! initial_secret_sources="$(jq -r');
    expect(runner).not.toContain("< <(");
    expect(runner).toContain('evidence_records="$(printf');
    expect(runner).toContain("immutable backup evidence lines could not be extracted");
    for (const field of [
      "project",
      "service",
      "revision",
      "image reference",
      "image ID",
      "running state",
      "lifecycle state",
      "health",
    ]) {
      expect(runner).toContain(`resumable container ${field} could not be parsed`);
    }
  });

  it("coordinates with development and preserves the parent CD lock", () => {
    expect(runner).toContain("acquire_host_deployment_lock");
    expect(runner).toContain('"$(readlink -f -- "/proc/self/fd/$host_lock_fd")" == "$lock_file"');
    expect(deployMain).toContain("--host-lock-fd 8");
  });
});
