import { readFileSync } from "node:fs";
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

  it("coordinates with development and preserves the parent CD lock", () => {
    expect(runner).toContain("acquire_host_deployment_lock");
    expect(runner).toContain('"$(readlink -f -- "/proc/self/fd/$host_lock_fd")" == "$lock_file"');
    expect(deployMain).toContain("--host-lock-fd 8");
  });
});
