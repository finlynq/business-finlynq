import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const installer = read("deploy/production/install-initial-production.sh");
const productionSignalWorkflow = read(".github/workflows/signal-production-deployment.yml");
const qualityGateWorkflow = read(".github/workflows/ci.yml");
const rehearsals = read("deploy/production/run-initial-rehearsals.sh");
const runner = read("deploy/release/run-release.sh");
const developmentInstaller = read("deploy/development/install-development.sh");
const developmentDeployer = read("deploy/development/deploy-development.sh");
const externalEdgeVerifier = read("deploy/edge/verify-external-edge.sh");
const rehearsalCompose = read("deploy/release/docker-compose.rehearsal.yml");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function shellFunction(source: string, name: string) {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`${name} is unavailable`);
  return source.slice(start, end + 2);
}

describe("fresh production bootstrap installer", () => {
  it("exposes separate, fail-closed phases for edge, configuration, run, and recovery", () => {
    for (const mode of [
      "--prepare-edge-network-only",
      "--prepare-configuration-only",
      "--run-provisioned",
      "--retry-pristine-initial",
      "--resume-initial",
      "--finalize-accepted-initial",
    ]) {
      expect(installer).toContain(mode);
    }
    expect(installer).toContain('[[ "$mode_count" == 1 ]]');
    expect(installer).toContain("configuration mode requires the public recipient and external edge contract files");
    expect(installer).toContain("provisioned-run mode accepts no new input files");
  });

  it("supports the target OS and creates only the exact externally owned ingress network", () => {
    expect(installer).toContain('env -i PATH="$clean_path" docker "$@"');
    expect(installer).toContain('os_release_link="$(readlink -- /etc/os-release)"');
    expect(installer).toContain('"$os_release_link" == ../usr/lib/os-release');
    expect(installer).toContain('readonly os_release_target="/usr/lib/os-release"');
    expect(installer).toContain('(8#$os_release_mode & 8#022) == 0');
    expect(installer).toContain('"$os_version" == 26.04');
    expect(installer).toContain("com.business-finlynq.environment=production");
    expect(installer).toContain("com.business-finlynq.edge-owner=external");
    expect(installer).toContain(".Driver == \"bridge\"");
    expect(installer).toContain(".Internal == true");
    expect(installer).toContain(".Attachable == false");
    expect(installer).toContain("Docker Compose 2.39.0 or newer is required");
  });

  it("verifies the exact keyless production signal before fresh-host mutation", () => {
    expect(installer).toContain('readonly github_cli="/usr/bin/gh"');
    expect(installer).toContain(
      'readonly production_signal_repository="finlynq/business-finlynq"',
    );
    expect(installer).toContain(
      'readonly production_signal_certificate_identity="https://github.com/finlynq/business-finlynq/.github/workflows/signal-production-deployment.yml@refs/heads/main"',
    );
    expect(installer).toContain(
      `readonly production_signal_workflow_sha256="${sha256(productionSignalWorkflow)}"`,
    );
    expect(installer).toContain(
      `readonly quality_gate_workflow_sha256="${sha256(qualityGateWorkflow)}"`,
    );
    expect(installer).toContain('[[ -f "$github_cli" && ! -L "$github_cli" \\');
    expect(installer).toContain(
      '"$(stat -c \'%u:%g:%a\' -- "$github_cli")" == 0:0:755 ]]',
    );
    expect(installer).toContain("GitHub CLI 2.100.0 or newer");
    const verifierStart = installer.indexOf("verify_ci_approved_production_signal() (");
    const verifierEnd = installer.indexOf("\n)\n", verifierStart);
    expect(verifierStart).toBeGreaterThan(-1);
    expect(verifierEnd).toBeGreaterThan(verifierStart);
    const verifier = installer.slice(verifierStart, verifierEnd);
    expect(verifier).toContain([
      "  printf '%s\\nrepository=%s\\nrevision=%s\\n' \\",
      "    'business-finlynq-production-deployment-v1' \\",
      '    "$production_signal_repository" \\',
      '    "$revision" >"$signal_file"',
    ].join("\n"));
    expect(verifier).toContain(
      'signal_asset="business-finlynq-production-deployment-$revision.attestation.json"',
    );
    expect(verifier).toContain(
      '"https://github.com/$production_signal_repository/releases/download/production-deployment-signals/$signal_asset"',
    );
    expect(verifier).toContain("curl --disable --proto '=https'");
    expect(verifier).toContain("--proto-redir '=https'");
    expect(verifier).toContain("--max-filesize 16777216");
    expect(verifier).toContain("timeout --signal=TERM --kill-after=10 45");
    expect(verifier).toContain("timeout --signal=TERM --kill-after=15 90");
    expect(verifier).toContain(
      'signal_directory="$(mktemp -d /tmp/business-finlynq-initial-production-signal.XXXXXX)"',
    );
    expect(verifier).toContain('HOME="$signal_directory/home"');
    expect(verifier).toContain('GH_CONFIG_DIR="$signal_directory/config"');
    expect(verifier).toContain('XDG_CACHE_HOME="$signal_directory/cache"');
    expect(verifier).toContain(
      '"$(stat -c \'%u:%g:%a:%h\' -- "$bundle_file")" == 0:0:600:1',
    );
    expect(verifier).toContain("env -i \\");
    expect(verifier).not.toContain("GH_TOKEN");
    expect(verifier).toContain(
      '.mediaType == "application/vnd.dev.sigstore.bundle.v0.3+json"',
    );
    expect(verifier).toContain(
      '.dsseEnvelope.payloadType == "application/vnd.in-toto+json"',
    );
    expect(verifier).toContain('--bundle "$bundle_file"');
    expect(verifier).toContain(
      '--cert-identity "$production_signal_certificate_identity"',
    );
    expect(verifier).toContain(
      "--cert-oidc-issuer https://token.actions.githubusercontent.com",
    );
    expect(verifier).toContain('--signer-digest "$revision"');
    expect(verifier).toContain('--source-digest "$revision"');
    expect(verifier).toContain("--source-ref refs/heads/main");
    expect(verifier).toContain("--deny-self-hosted-runners");
    expect(verifier).toContain("--predicate-type https://slsa.dev/provenance/v1");
    expect(verifier).not.toContain("--signer-workflow");
    expect(installer).not.toContain("refs/tags/deploy-production-");

    const checkoutValidated = installer.indexOf(
      '|| fail "canonical production checkout, origin, branch, or revision is not exact"',
    );
    const trustedWorkflowsValidated = installer.indexOf(
      "candidate_uses_trusted_production_workflows \\\n  || fail",
      verifierEnd,
    );
    const signalVerified = installer.indexOf(
      "verify_ci_approved_production_signal \\\n  || fail",
      verifierEnd,
    );
    const firstStateMutation = installer.indexOf(
      'install -d -o root -g deploy -m 0775 -- "$state_directory"',
    );
    expect(installer).toContain(
      'git_as_deploy cat-file blob "$revision:$path" | sha256sum',
    );
    expect(trustedWorkflowsValidated).toBeGreaterThan(checkoutValidated);
    expect(signalVerified).toBeGreaterThan(trustedWorkflowsValidated);
    expect(signalVerified).toBeLessThan(firstStateMutation);
  });

  it("uses portable numeric ownership for container-writable backup directories", () => {
    for (const line of installer.split(/\r?\n/u)) {
      expect(line).not.toMatch(/\binstall\b.*\s-[og]\s+\+?[0-9]+\b/u);
    }
    const creation = installer.indexOf(
      'install -d -o root -g root -m 0700 -- "$backup_directory"',
    );
    const ownership = installer.indexOf('chown -- +70:+70 "$backup_directory"');
    expect(creation).toBeGreaterThan(-1);
    expect(ownership).toBeGreaterThan(creation);
    for (const path of [
      '$backup_directory',
      '$rehearsal_evidence_root/backups',
      '$rehearsal_evidence_root/backups/first',
      '$rehearsal_evidence_root/backups/second',
    ]) {
      expect(installer.slice(creation, ownership)).toContain(path);
      expect(installer.slice(ownership, ownership + 400)).toContain(path);
    }
  });

  it("bridges only a protected root-managed external edge contract", () => {
    expect(installer).toContain("--external-edge-contract-file <root-managed-contract>");
    expect(installer).toContain("external edge contract source must be a root:root mode 0400");
    expect(installer).toContain("edge_contract_keys");
    expect(installer).toContain("edge-contract.env does not have the exact reviewed key set");
    expect(installer).toContain("partial canonical edge contract is unsafe");
    expect(installer).toContain('sync -f -- "$edge_directory"');
    expect(installer).toContain("install_protected_external_edge_verifier");
    expect(installer).toContain(
      'external_edge_verifier_root="/usr/local/libexec/business-finlynq"',
    );
    expect(installer).toContain('"$external_edge_verifier_target"');
    expect(installer).toContain('"$external_edge_verifier_route_target"');
    expect(installer).toContain("external-edge verifier differs from the exact Git revision");
  });

  it("installs the verifier in a relocation-safe protected repository shape", () => {
    const protectedRoot = "/usr/local/libexec/business-finlynq";
    const installedDirectory = `${protectedRoot}/deploy/edge`;
    expect(posix.resolve(installedDirectory, "../..")).toBe(protectedRoot);
    expect(posix.join(protectedRoot, "deploy/edge/Caddyfile.business-external")).toBe(
      `${installedDirectory}/Caddyfile.business-external`,
    );
    expect(installer).toContain(
      'external_edge_verifier_directory="$external_edge_verifier_root/deploy/edge"',
    );
    expect(installer).toContain(
      'external_edge_verifier_route_target="$external_edge_verifier_directory/Caddyfile.business-external"',
    );
  });

  it("journals secrets before mutation and safely resumes an interrupted configuration", () => {
    const prepareStart = installer.indexOf("prepare_new_configuration() {");
    const prepareEnd = installer.indexOf("\n}\n\nallocate_rehearsal_batch", prepareStart);
    const prepareBody = installer.slice(prepareStart, prepareEnd);
    const writeJournal = prepareBody.indexOf("write_preparation_state");
    const createDirectories = prepareBody.indexOf("create_protected_directories", writeJournal);
    const render = prepareBody.indexOf("render_and_verify_initial_configuration", createDirectories);
    const removeJournal = prepareBody.indexOf('rm -- "$preparation_state"', render);
    const unsetPasswords = prepareBody.indexOf(
      "unset production_owner_password first_owner_password second_owner_password",
      render,
    );
    expect(writeJournal).toBeGreaterThan(-1);
    expect(writeJournal).toBeLessThan(createDirectories);
    expect(createDirectories).toBeLessThan(render);
    expect(render).toBeLessThan(removeJournal);
    expect(removeJournal).toBeLessThan(unsetPasswords);
    expect(installer).toContain('phase: "configuring"');
    expect(installer).toContain("ownerPasswords:");
    expect(installer).toContain('.env.initial.XXXXXX');
    expect(installer).toContain("repository environment staging copy is incomplete");
  });

  it("prepares three independent contained environments with durable placeholders", () => {
    for (const gate of [
      "DEMO_LOGIN_ENABLED=true",
      "DEMO_WRITES_ENABLED=true",
      "ACCOUNT_LOGIN_ENABLED=false",
      "ACCOUNT_SIGNUP_ENABLED=false",
      "AUTH_EMAIL_DELIVERY_ENABLED=false",
      "SIGNUP_TURNSTILE_ENABLED=false",
      "BUSINESS_WRITES_ENABLED=false",
      "BANK_FEEDS_ENABLED=false",
      "YAHOO_FX_ENABLED=false",
    ]) {
      expect(installer).toContain(gate);
    }
    for (const port of ["3100", "3310", "3311"]) expect(installer).toContain(port);
    expect(installer).toContain("generated secrets are not independent");
    expect(installer).toContain('[[ "$generated_hash_count" == 15 ]]');
    expect(installer).toContain("generated secret checksum inventory is incomplete");
    expect(installer).toContain("durable disabled-secret placeholder is invalid");
    expect(installer).toContain("BACKUP_REQUIRE_OFFSITE=false");
    expect(installer).toContain("MONITOR_REQUIRE_OFFSITE=false");
  });

  it("renders both the active profile set and the explicitly inert edge service", () => {
    expect(installer).toContain('(.services | has("edge") | not)');
    expect(installer).toContain(
      'release_router_reference="business-finlynq-release-router:v1"',
    );
    expect(installer).toContain('release_router_revision="release-router-v1"');
    expect(installer).toContain('release_router_contract="v1"');
    expect(installer).toContain(
      'release_router_build_project="business-finlynq-release-router-build-v1"',
    );
    expect(installer).toContain(
      'release_router_state_volume="business_finlynq_private-release-router-state-v1"',
    );
    expect(installer).not.toContain(
      'release_router_state_volume="business_finlynq_private_release-router-state-v1"',
    );
    expect(
      (installer.match(/\.services\.release_router\.image == \$releaseRouterReference/gu) ?? [])
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(installer).not.toContain(
      '.services.release_router.image == ("business-finlynq-release-router:" + $revision)',
    );
    expect(installer).toContain(
      '.services.release_router.networks.business_finlynq_edge.aliases == ["production-app"]',
    );
    expect(installer).toContain('((.services.app.ports // []) | length) == 0');
    expect(installer).toContain(
      '.services.app.networks.business_finlynq_frontend.aliases == ["release-app"]',
    );
    expect(installer).toContain(
      '.networks.business_finlynq_frontend.name == "business_finlynq_private-frontend"',
    );
    expect(installer).toContain(
      '.volumes.business_finlynq_release_router_state.name == $releaseRouterStateVolume',
    );
    expect(installer).toContain('.source == "business_finlynq_release_router_state"');
    expect(installer).toContain('.target == "/state"');
    expect(installer).toContain('($project + "-release-router-state-v1")');
    expect(installer).toContain('[.volumes[].name, .networks[].name]');
    expect(installer).toContain("--profile external-edge-disabled config --format json");
    expect(installer).toContain('.services.edge.entrypoint == ["/bin/false"]');
    expect(installer).toContain('.services.edge.network_mode == "none"');
    expect(installer).toContain("external-edge overlay does not leave the local listener inert");
  });

  it("runs two retryable isolated rehearsals and verifies them without host Node", () => {
    expect(rehearsals).toContain('"rehearsal-a-$batch_id" "rehearsal-b-$batch_id"');
    expect(rehearsals).toContain("--entrypoint node");
    expect(rehearsals).toContain("--network none");
    expect(rehearsals).not.toContain("command -v node");
    expect(rehearsals).toContain(".verifier.imageId == $imageId");
    expect(rehearsals).toContain(".verifier.sourceSha256 == $sourceSha256");
    expect(rehearsalCompose).toContain("${RELEASE_REHEARSAL_PROJECT:?set RELEASE_REHEARSAL_PROJECT}-epm-edge");
    expect(rehearsalCompose).toContain("${RELEASE_REHEARSAL_PROJECT:?set RELEASE_REHEARSAL_PROJECT}-consult-edge");
  });

  it("allows only an exact pre-resource failure to authorize a new pristine attempt", () => {
    expect(installer).toContain("verify_pristine_initial_failure");
    expect(installer).toContain("verify_protected_evidence_inventory");
    expect(installer).toContain("failure is not at an acknowledged pre-resource initial stage");
    expect(installer).toContain("failed run has complete resume evidence; use --resume-initial instead");
    expect(installer).toContain("assert_empty_production_runtime");
    expect(installer).toContain("verify_all_bootstrap_automation_disabled");
    expect(installer).toContain('status: "authorized"');
    expect(installer).toContain("priorInventorySha256");
    expect(installer).toContain("installStateSha256");
  });

  it("reconciles only the narrow accepted-plus-complete-evidence failure", () => {
    expect(installer).toContain('.stage == "complete-evidence"');
    expect(installer).toContain("accepted-plus-failure evidence is not the narrow complete-evidence case");
    expect(installer).toContain("sha256sum --check --strict --quiet SHA256SUMS");
    expect(installer).toContain("^\\./[0-9A-Za-z][0-9A-Za-z._-]*$");
    expect(installer).toContain("release evidence checksum inventory is not an exact file set");
    expect(installer).toContain("recover_accepted_terminal_inventory_gap");
    expect(installer).toContain("unsupported uninventoried release evidence exception");
    expect(installer).toContain("terminal acceptance has both published and staged records");
    expect(installer).toContain("write_recovered_initial_terminal_record");
    expect(installer).toContain("refresh_accepted_initial_inventory");
  });

  it("validates terminal evidence before recovery and can finalize an already-published completion", () => {
    expect(installer).toContain("verify_contained_initial_terminal_evidence");
    expect(installer).toContain("verify_install_completion_for_run");
    expect(installer).toContain("06-initial-inputs.json");
    expect(installer).toContain("accepted initial inputs do not match the protected configuration");
    expect(installer).toContain('select(.name == "router")');
    expect(installer).toContain('"maintenanceConfirmedBeforeSchemaMigration"');
    expect(installer).toContain('"releaseRouterConfigSha256"');
    expect(installer).toContain('"releaseRouterImageId"');
    expect(installer).toContain(".maintenanceConfirmedBeforeSchemaMigration == true");
    expect(installer).toContain(".releaseRouterImageId == $releaseRouterImageId");
    expect(installer).toContain(".releaseRouterConfigSha256 == $releaseRouterConfigSha256");
    const routerManifest = shellFunction(installer, "checked_release_router_config_sha256");
    expect(routerManifest).toContain("sha256sum Caddyfile Caddyfile.maintenance");
    expect(routerManifest).toContain("| sha256sum | awk '{print $1}'");
    expect(shellFunction(installer, "verify_contained_initial_terminal_evidence_records"))
      .toContain('expected_router_config_sha="$(checked_release_router_config_sha256)"');
    expect(shellFunction(installer, "write_recovered_initial_terminal_record"))
      .toContain('expected_router_config_sha="$(checked_release_router_config_sha256)"');
    expect(installer).not.toMatch(
      /checked_file_sha256\s+\\?\r?\n?\s*"\$repository\/deploy\/release\/router\/Caddyfile"/u,
    );
    const finalizeStart = installer.indexOf("finalize_accepted_initial() {");
    const finalizeEnd = installer.indexOf("\n}\n\nif [[ \"$prepare_configuration_only\"", finalizeStart);
    const finalize = installer.slice(finalizeStart, finalizeEnd);
    const terminalValidation = finalize.indexOf(
      'verify_contained_initial_terminal_evidence "$accepted_run_id"',
    );
    const containment = finalize.indexOf('wrapper_stop_app_on_failure="true"');
    const recovery = finalize.indexOf('recover_accepted_stopped_app "$accepted_evidence"');
    const activation = finalize.indexOf(
      'activate_accepted_release_router "$accepted_recovery_router_container"',
    );
    const publicReadiness = finalize.indexOf("verify_accepted_public_readiness");
    const externalReadiness = finalize.indexOf(
      '"$external_edge_verifier_target" --scope production',
    );
    const completion = finalize.indexOf('write_install_completion "$accepted_run_id"');
    const disarm = finalize.indexOf('wrapper_stop_app_on_failure="false"', completion);
    const output = finalize.indexOf("printf 'Recovered wrapper completion", completion);
    expect(terminalValidation).toBeGreaterThan(-1);
    expect(terminalValidation).toBeLessThan(containment);
    expect(containment).toBeLessThan(recovery);
    expect(terminalValidation).toBeLessThan(recovery);
    expect(recovery).toBeLessThan(activation);
    expect(activation).toBeLessThan(publicReadiness);
    expect(publicReadiness).toBeLessThan(externalReadiness);
    expect(externalReadiness).toBeLessThan(completion);
    expect(recovery).toBeLessThan(completion);
    expect(completion).toBeLessThan(disarm);
    expect(disarm).toBeLessThan(output);
    expect(installer).toContain('if [[ -e "$install_completion" || -L "$install_completion" ]]; then');
    expect(installer).toContain("existing initial installation completion could not be synchronized");
    expect(installer).not.toMatch(
      /local initial_run_id="\$1"[^\n]*initial_evidence=[^\n]*\$initial_run_id/u,
    );
    expect(
      (installer.match(/local initial_run_id="\$1"\r?\n\s+local initial_evidence=/gu) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("binds wrapper completion to the live contained runtime and durable one-shot evidence", () => {
    expect(installer).toContain("verify_live_accepted_initial_runtime");
    expect(installer).toContain("11-images.json");
    expect(installer).toContain("14-evidence-scanner.json");
    expect(installer).toContain('"HostIp":"127.0.0.1", "HostPort":"3100"');
    expect(installer).toContain("(.images | type == \"array\" and length == 7)");
    const imageInventory = shellFunction(installer, "verify_release_image_inventory");
    expect(imageInventory).toContain('.reference == $releaseRouterReference');
    expect(imageInventory).toContain('.ociRevision == $releaseRouterRevision');
    expect(imageInventory).toContain('.ociRevision == $revision');
    expect(imageInventory.indexOf('if .name == "router" then')).toBeLessThan(
      imageInventory.indexOf('.ociRevision == $revision'),
    );
    expect(installer).toContain("verify_release_router_runtime_contract");
    expect(installer).toContain("verify_release_router_image_contract");
    expect(installer).toContain("live release router is not running and healthy");
    expect(installer).toContain(
      "accepted production runtime does not contain exactly app, database, scanner, and release router",
    );
    expect(installer).toContain(
      '((.[0].HostConfig.PortBindings // {}) | length) == 0',
    );
    expect(installer).toContain('index("release-app")) != null');
    expect(installer).toContain("live app differs from the accepted contained runtime");
    expect(installer).toContain("business-finlynq-accounting-evidence.service");
    expect(installer).toContain("business-finlynq-monitor.service");
    expect(installer).not.toContain("--property=InvocationID");
    expect(installer).not.toContain("ExecMainStartTimestampMonotonic");
    expect(installer).toContain("accounting-evidence.prom");
    expect(installer).toContain("business_finlynq_accounting_evidence_verification_success");
    expect(installer).toContain("business_finlynq_host_monitor_success");
    expect(installer).toContain("did not publish a fresh safe $description");
    expect(installer).toContain("containedInitial == true");
    expect(installer).toContain("offsiteBackupDeferred == true");
    expect(installer).toContain("schedulerActivationDeferred == true");
    expect(installer).not.toContain("initialTimersEnabled");
    expect(installer).not.toContain("offsiteBackupDelivery");
  });

  it("fully attests the accepted release-router container boundary", () => {
    const routerContract = shellFunction(installer, "verify_release_router_runtime_contract");
    for (const contract of [
      '.[0].Image == $imageId',
      '"org.opencontainers.image.revision"] == $routerRevision',
      '"com.business-finlynq.release-router.contract"] == $routerContract',
      '.[0].Config.User == "10001:10001"',
      '.[0].Config.Entrypoint == ["/usr/local/bin/release-router-entrypoint"]',
      '.[0].Config.Cmd == ["serve"]',
      ".[0].Config.Healthcheck.Test ==",
      ".[0].HostConfig.ReadonlyRootfs == true",
      ".[0].HostConfig.Init == true",
      '"Name":"unless-stopped"',
      '(.[0].HostConfig.CapDrop | sort) == ["ALL"]',
      '"no-new-privileges:true"',
      '"HostIp":"127.0.0.1", "HostPort":"3100"',
      '(.[0].HostConfig.Tmpfs | keys | sort) == ["/config", "/data", "/tmp"]',
      '(.[0].Mounts | type == "array" and length == 1)',
      '.[0].Mounts[0].Name == $routerStateVolume',
      '.[0].Mounts[0].Destination == "/state"',
      '.[0].Mounts[0].RW == true',
      '["business_finlynq_edge", "business_finlynq_private-frontend"]',
      'index("production-app")) != null',
    ]) {
      expect(routerContract).toContain(contract);
    }
    expect(routerContract).not.toContain('--arg revision "$revision"');
    const imageContract = shellFunction(installer, "verify_release_router_image_contract");
    expect(imageContract).toContain('"com.docker.compose.project"] == $buildProject');
    expect(imageContract).toContain('release_router_build_project');
    const stateContract = shellFunction(installer, "verify_release_router_state_contract");
    expect(stateContract).toContain('10001:10001:700');
    expect(stateContract).toContain('10001:10001:600');
    expect(stateContract).toContain('active|maintenance');
    const liveRuntime = shellFunction(installer, "verify_live_accepted_initial_runtime");
    expect(liveRuntime).toContain('verify_release_router_image_contract');
    expect(liveRuntime).toContain('verify_release_router_runtime_contract');
    expect(liveRuntime).toContain('"$container_id" active "live accepted release router"');
    const recoveryRuntime = shellFunction(installer, "recover_accepted_stopped_app");
    expect(recoveryRuntime).toContain('verify_release_router_image_contract');
    expect(recoveryRuntime).toContain('verify_release_router_runtime_contract');
    expect(recoveryRuntime).toContain("hold_accepted_release_router_in_maintenance");
    const maintenanceRecovery = shellFunction(
      installer,
      "hold_accepted_release_router_in_maintenance",
    );
    expect(maintenanceRecovery).toContain(
      '"$container_id" active-or-maintenance "terminal-recovery release router"',
    );
    expect(maintenanceRecovery).toContain(
      '"$container_id" maintenance "terminal-recovery release router"',
    );
    const activation = shellFunction(installer, "activate_accepted_release_router");
    expect(activation).toContain('reload_accepted_release_router "$container_id" Caddyfile');
    expect(activation).toContain('commit_release_router_mode_online "$container_id" active');
    expect(activation.indexOf("reload_accepted_release_router")).toBeLessThan(
      activation.indexOf("commit_release_router_mode_online"),
    );
  });

  it("permits only an attested stable router boundary during an initial resume", () => {
    const resumeBoundary = shellFunction(installer, "verify_initial_resume_router_boundary");
    expect(resumeBoundary).toContain('verify_protected_evidence_inventory "$prior_evidence"');
    expect(resumeBoundary).toContain('verify_release_image_inventory');
    expect(resumeBoundary).toContain('select(.name == "router")');
    expect(resumeBoundary).toContain("initial resume found duplicate release-router containers");
    expect(resumeBoundary).toContain('verify_release_router_image_contract');
    expect(resumeBoundary).toContain('verify_release_router_runtime_contract');
    expect(resumeBoundary).toContain('business_finlynq_private-frontend');
    expect(resumeBoundary).toContain('.Internal == true');
    expect(resumeBoundary).toContain(
      '.Labels["com.docker.compose.network"] == "business_finlynq_frontend"',
    );
    expect(resumeBoundary).toContain('docker volume inspect "$release_router_state_volume"');
    expect(resumeBoundary).toContain(
      '.[0].Labels["com.docker.compose.volume"] == $logical',
    );
    expect(resumeBoundary).toContain('active-or-maintenance');
    expect(installer).toContain('verify_initial_resume_router_boundary "$prior_evidence"');
    const resumeDispatch = installer.lastIndexOf('run_initial_release "$resume_run_id"');
    expect(installer.lastIndexOf('verify_initial_resume_router_boundary "$prior_evidence"'))
      .toBeLessThan(resumeDispatch);
    expect(shellFunction(installer, "assert_empty_production_runtime"))
      .toContain('"$release_router_state_volume"');
    const initialState = shellFunction(runner, "verify_initial_state_contract");
    expect(initialState).toContain("normalized resumable release-router state");
    expect(initialState).toContain("0:0:700|0:0:755|10001:10001:700");
    expect(initialState).toContain("! -path /state/mode -print -quit");
    expect(initialState).toContain('--entrypoint sh "$resumable_router_expected_image_id"');
    expect(initialState).toContain('sync "$temporary" 2>/dev/null || sync');
    expect(initialState).toContain("sync -f /state 2>/dev/null || sync");
    expect(initialState).toContain('"$resumable_router_container_id"');
    expect(initialState).toContain('"restarted resumable release router" start');
    expect(initialState).toContain("exact resumable release router did not become healthy");
    expect(initialState).toContain("resumed release router did not start in public maintenance");
  });

  it.skipIf(process.platform === "win32")(
    "accepts systemd 259 one-shots only when they freshly publish exact success metrics",
    () => {
      const helper = shellFunction(installer, "run_fresh_installed_oneshot");
      const root = mkdtempSync(join(tmpdir(), "business-finlynq-initial-oneshot-"));
      temporaryDirectories.push(root);
      const fakeBin = join(root, "bin");
      mkdirSync(fakeBin);
      const currentUid = process.getuid?.() ?? 1000;
      const currentGid = process.getgid?.() ?? 1000;
      const fixedNow = 2_000_000_000;

      writeFileSync(join(fakeBin, "id"), `#!/usr/bin/env bash
case "$*" in
  "-u deploy") printf '%s\\n' '${currentUid}' ;;
  "-g deploy") printf '%s\\n' '${currentGid}' ;;
  *) /usr/bin/id "$@" ;;
esac
`);
      writeFileSync(join(fakeBin, "date"), `#!/usr/bin/env bash
[[ "$*" == '+%s' ]] || exit 98
printf '%s\\n' "$FAKE_NOW"
`);
      writeFileSync(join(fakeBin, "systemctl"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_SYSTEMD_LOG"

write_expected_metric() {
  local metric_file
  case "$2" in
    business-finlynq-accounting-evidence.service)
      metric_file="$FAKE_STATE_DIRECTORY/accounting-evidence.prom"
      printf 'business_finlynq_accounting_evidence_verification_success 1\\n' >"$metric_file"
      printf 'business_finlynq_accounting_evidence_verification_last_run_unixtime %s\\n' "$FAKE_NOW" >>"$metric_file"
      printf 'business_finlynq_accounting_evidence_verification_last_success_unixtime %s\\n' "$FAKE_NOW" >>"$metric_file"
      ;;
    business-finlynq-monitor.service)
      metric_file="$FAKE_STATE_DIRECTORY/host.prom"
      printf 'business_finlynq_host_monitor_success 1\\n' >"$metric_file"
      printf 'business_finlynq_host_monitor_last_run_unixtime %s\\n' "$FAKE_NOW" >>"$metric_file"
      ;;
    *) exit 96 ;;
  esac
  chmod 0644 -- "$metric_file"
  /usr/bin/touch --date="@$FAKE_NOW" -- "$metric_file"
  printf '%s\\n' "$metric_file"
}

case "$1" in
  start)
    [[ "$FAKE_SYSTEMD_MODE" != start-failure ]] || exit 42
    [[ "$FAKE_SYSTEMD_MODE" != no-metric ]] || exit 0
    metric_file="$(write_expected_metric "$@")"
    case "$FAKE_SYSTEMD_MODE" in
      duplicate)
        printf 'business_finlynq_host_monitor_success 1\\n' >>"$metric_file"
        ;;
      stale-file)
        /usr/bin/touch --date="@$((FAKE_NOW - 1))" -- "$metric_file"
        ;;
      stale-value)
        sed -i "s/last_run_unixtime $FAKE_NOW/last_run_unixtime $((FAKE_NOW - 1))/" "$metric_file"
        ;;
      wrong-mode)
        chmod 0600 -- "$metric_file"
        ;;
      wrong-success)
        sed -i 's/_success 1/_success 0/' "$metric_file"
        ;;
    esac
    if [[ "$FAKE_SYSTEMD_MODE" != stale-file ]]; then
      /usr/bin/touch --date="@$FAKE_NOW" -- "$metric_file"
    fi
    ;;
  is-active)
    if [[ "$FAKE_SYSTEMD_MODE" == active ]]; then
      printf '%s\\n' active
      exit 0
    fi
    # Ubuntu 26.04/systemd 259 clears invocation properties after the
    # successful one-shot exits, leaving only inactive/status 3 observable.
    printf '%s\\n' inactive
    exit 3
    ;;
  *) exit 94 ;;
esac
`);
      for (const command of ["id", "date", "systemctl"]) {
        chmodSync(join(fakeBin, command), 0o755);
      }

      const runCase = (
        name: string,
        mode: string,
        serviceName = "business-finlynq-monitor.service",
        prelude = "",
      ) => {
        const stateDirectory = join(root, name);
        const systemdLog = join(root, `${name}.systemctl.log`);
        mkdirSync(stateDirectory, { mode: 0o775 });
        chmodSync(stateDirectory, 0o775);
        const normalizedStateDirectory = stateDirectory.replaceAll("\\", "/");
        const result = spawnSync("/bin/bash", ["-c", `
set -Eeuo pipefail
state_directory='${normalizedStateDirectory}'
fail() { printf '%s\\n' "$1" >&2; return 1; }
${helper}
${prelude}
run_fresh_installed_oneshot '${serviceName}'
`], {
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_NOW: String(fixedNow),
            FAKE_STATE_DIRECTORY: normalizedStateDirectory,
            FAKE_SYSTEMD_LOG: systemdLog.replaceAll("\\", "/"),
            FAKE_SYSTEMD_MODE: mode,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
        });
        const metricFile = join(
          stateDirectory,
          serviceName === "business-finlynq-accounting-evidence.service"
            ? "accounting-evidence.prom"
            : "host.prom",
        );
        return { metricFile, result, systemdLog };
      };

      const acceptedMonitor = runCase(
        "accepted-monitor",
        "systemd259",
        "business-finlynq-monitor.service",
        `printf '%s\\n' 'stale sentinel' >"$state_directory/host.prom"
chmod 0644 -- "$state_directory/host.prom"`,
      );
      expect(acceptedMonitor.result.status, acceptedMonitor.result.stderr).toBe(0);
      expect(readFileSync(acceptedMonitor.metricFile, "utf8")).toBe(
        `business_finlynq_host_monitor_success 1\n` +
          `business_finlynq_host_monitor_last_run_unixtime ${fixedNow}\n`,
      );
      expect(readFileSync(acceptedMonitor.systemdLog, "utf8")).toBe(
        "start business-finlynq-monitor.service\n" +
          "is-active business-finlynq-monitor.service\n",
      );
      const monitorStat = statSync(acceptedMonitor.metricFile);
      expect(monitorStat.uid).toBe(currentUid);
      expect(monitorStat.gid).toBe(currentGid);
      expect(monitorStat.mode & 0o777).toBe(0o644);
      expect(Math.floor(monitorStat.mtimeMs / 1000)).toBe(fixedNow);

      const acceptedAccounting = runCase(
        "accepted-accounting",
        "systemd259",
        "business-finlynq-accounting-evidence.service",
      );
      expect(acceptedAccounting.result.status, acceptedAccounting.result.stderr).toBe(0);
      expect(readFileSync(acceptedAccounting.metricFile, "utf8")).toBe(
        `business_finlynq_accounting_evidence_verification_success 1\n` +
          `business_finlynq_accounting_evidence_verification_last_run_unixtime ${fixedNow}\n` +
          `business_finlynq_accounting_evidence_verification_last_success_unixtime ${fixedNow}\n`,
      );

      for (const [mode, expectedError] of [
        ["start-failure", "failed during accepted-initial finalization"],
        ["active", "did not return to the expected inactive one-shot state"],
        ["no-metric", "did not publish a fresh safe host-monitor metric"],
        ["duplicate", "success value is missing or duplicated"],
        ["stale-file", "did not freshly replace the expected host-monitor metric"],
        ["stale-value", "does not prove a fresh successful invocation"],
        ["wrong-mode", "did not freshly replace the expected host-monitor metric"],
        ["wrong-success", "does not prove a fresh successful invocation"],
      ] as const) {
        const rejected = runCase(`rejected-${mode}`, mode);
        expect(rejected.result.status).not.toBe(0);
        expect(rejected.result.stderr).toContain(expectedError);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts only the exact database data and read-only password mounts",
    () => {
      expect(installer).toContain('verify_database_mount_contract "$inspect_json" "live database"');
      expect(installer).toContain(
        'verify_database_mount_contract "$supporting_inspect" "terminal-recovery database"',
      );
      const helper = shellFunction(installer, "verify_database_mount_contract");
      const exact = [{ Mounts: [
        {
          Type: "volume",
          Name: "business_finlynq_pgdata",
          Source: "/var/lib/docker/volumes/business_finlynq_pgdata/_data",
          Destination: "/var/lib/postgresql/data",
          RW: true,
        },
        {
          Type: "bind",
          Source: "/etc/business-finlynq/secrets/app-db-password",
          Destination: "/run/secrets/business_finlynq_app_db_password",
          RW: false,
        },
      ] }];
      const rejected = [
        [{ Mounts: exact[0].Mounts.slice(0, 1) }],
        [{ Mounts: exact[0].Mounts.map((mount, index) => index === 1 ? { ...mount, RW: true } : mount) }],
        [{ Mounts: exact[0].Mounts.map((mount, index) => index === 1 ? { ...mount, Source: "/tmp/wrong" } : mount) }],
        [{ Mounts: exact[0].Mounts.map((mount, index) => index === 1 ? { ...mount, Destination: "/tmp/wrong" } : mount) }],
        [{ Mounts: exact[0].Mounts.map((mount, index) => index === 1 ? { ...mount, Destination: "/var/lib/postgresql/data" } : mount) }],
        [{ Mounts: exact[0].Mounts.map((mount, index) => index === 0 ? { ...mount, Name: "wrong" } : mount) }],
        [{ Mounts: [...exact[0].Mounts, {
          Type: "bind", Source: "/tmp/extra", Destination: "/tmp/extra", RW: false,
        }] }],
      ];
      const quote = (value: unknown) => `'${JSON.stringify(value)}'`;
      const negativeChecks = rejected.map((fixture) => `
if verify_database_mount_contract ${quote(fixture)} rejected >/dev/null 2>&1; then
  printf '%s\\n' 'unsafe database mount fixture was accepted' >&2
  exit 1
fi`).join("\n");
      const result = spawnSync("/bin/bash", ["-c", `
set -Eeuo pipefail
secret_directory=/etc/business-finlynq/secrets
fail() { printf '%s\\n' "$*" >&2; return 1; }
${helper}
verify_database_mount_contract ${quote(exact)} exact
${negativeChecks}
`], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("recovers only the exact stopped accepted app and recontains finalization failures", () => {
    expect(installer).toContain("recover_accepted_stopped_app");
    expect(installer).toContain(
      "terminal recovery requires exactly app, database, scanner, and release-router containers",
    );
    expect(installer).toContain("terminal-recovery scanner signature is writable or future-dated");
    expect(installer).toContain("signature_mtime <= now + 300");
    expect(installer).not.toContain("now - signature_mtime <= 604800");
    expect(installer).toContain("clamdscan --config-file=/tmp/finlynq-clamd.conf --version");
    expect(installer).toContain('clamd_database_is_fresh "$clamd_version" "$now"');
    expect(installer).toContain("terminal-recovery ClamD loaded signatures are unavailable, stale, or future-dated");
    expect(installer).toContain('start_output="$(docker start "$app_container")"');
    const routerRecovery = shellFunction(installer, "hold_accepted_release_router_in_maintenance");
    expect(routerRecovery).toContain('start_output="$(docker start "$container_id")"');
    expect(installer).toContain("terminal-recovery release-router liveness endpoint is unavailable");
    expect(installer).toContain("wrapper_stop_app_on_failure=\"true\"");
    expect(installer).toContain("stopped app differs from the exact accepted contained contract");
    const finalize = installer.slice(installer.indexOf("finalize_accepted_initial()"));
    const optionalFailure = finalize.indexOf('if [[ -f "$accepted_evidence/99-failure.json" ]]');
    const recovery = finalize.indexOf('recover_accepted_stopped_app "$accepted_evidence"');
    const optionalFailureEnd = finalize.indexOf("\n  fi", optionalFailure);
    expect(optionalFailure).toBeGreaterThan(-1);
    expect(optionalFailureEnd).toBeLessThan(recovery);
    const recoveryFunction = installer.slice(
      installer.indexOf("recover_accepted_stopped_app() {"),
      installer.indexOf("\n}\n\nfinalize_accepted_initial()", installer.indexOf("recover_accepted_stopped_app() {")),
    );
    expect(recoveryFunction.indexOf("hold_accepted_release_router_in_maintenance")).toBeLessThan(
      recoveryFunction.indexOf('docker start "$app_container"'),
    );
    expect(routerRecovery).toContain("release-router liveness endpoint");
    expect(recoveryFunction.indexOf("hold_accepted_release_router_in_maintenance")).toBeLessThan(
      recoveryFunction.indexOf("loopback detailed readiness"),
    );
  });

  it.skipIf(process.platform === "win32")(
    "validates ClamD ctime output at the exact stale and future boundaries",
    () => {
      const helper = shellFunction(installer, "clamd_database_is_fresh");
      const result = spawnSync("/bin/bash", ["-c", `
set -Eeuo pipefail
${helper}
now=1788868800
clamd_database_is_fresh 'ClamAV 1.5.4/28117/Tue Sep  8 06:26:31 2026' "$now"
clamd_database_is_fresh 'ClamAV 1.5.4/28110/Tue Sep  1 12:00:00 2026' "$now"
clamd_database_is_fresh 'ClamAV 1.5.4/28118/Tue Sep  8 12:05:00 2026' "$now"
! clamd_database_is_fresh 'ClamAV 1.5.4/28109/Tue Sep  1 11:59:59 2026' "$now"
! clamd_database_is_fresh 'ClamAV 1.5.4/28118/Tue Sep  8 12:05:01 2026' "$now"
! clamd_database_is_fresh 'ClamAV 1.5.4' "$now"
! clamd_database_is_fresh 'ClamAV 1.5.4/28117/not-a-date' "$now"
! clamd_database_is_fresh 'ClamAV 1.5.4/28117/Tue Feb 31 06:26:31 2026' "$now"
! clamd_database_is_fresh 'ClamAV 1.5.4/28117/Mon Sep  8 06:26:31 2026' "$now"
`], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("prunes only disposable initial containers and retains all volumes and networks", () => {
    expect(runner).toContain('stage="initial-runtime-pruning"');
    expect(runner).toContain("initial_disposable_services=(");
    expect(runner).toContain("87-initial-runtime-pruned.json");
    const pruning = runner.slice(
      runner.indexOf('stage="initial-runtime-pruning"'),
      runner.indexOf("87-initial-runtime-pruned.json") + 40,
    );
    expect(pruning).toContain("compose --profile operations rm --force --stop");
    expect(pruning).not.toContain("--volumes");
    expect(pruning).not.toContain("network rm");
  });

  it("contains every bootstrap failure and keeps production CD absent", () => {
    expect(installer).toContain("contain_initial_wrapper_failure");
    const containmentEnd = installer.indexOf("\n}\n", installer.indexOf(
      "contain_initial_wrapper_failure() {",
    ));
    const wrapperArm = installer.indexOf('initial_wrapper_active="true"', containmentEnd);
    const signalTraps = installer.slice(containmentEnd, wrapperArm);
    expect(containmentEnd).toBeGreaterThan(0);
    expect(wrapperArm).toBeGreaterThan(containmentEnd);
    expect(signalTraps).toContain("trap contain_initial_wrapper_failure EXIT");
    expect(signalTraps).toContain("trap 'exit 130' INT");
    expect(signalTraps).toContain("trap 'exit 143' TERM");
    expect(installer).toContain("business-finlynq-continuous-deployment.timer");
    expect(installer).toContain("business-finlynq-development-deployment.timer");
    expect(installer).toContain("productionContinuousDeploymentInstalled: false");
    expect(installer).toContain("developmentDeploymentEnabled: false");
    expect(installer).toContain("for service_name in app auth_email_worker; do");
    expect(installer).toContain("wrapper_stop_app_on_failure");
    const containment = shellFunction(installer, "contain_initial_wrapper_failure");
    expect(containment).toContain('wrapper_force_router_maintenance_on_failure" == true');
    expect(containment).toContain("commit_release_router_mode_online");
    expect(containment).toContain("commit_release_router_maintenance_offline");
    expect(containment).toContain("resolve_accepted_router_containment_target");
    expect(containment).toContain("Caddyfile.maintenance");
    expect(containment).not.toContain("docker stop --time 30 \"$accepted_recovery_router_container\"");
    expect(developmentInstaller).toContain('install -d -o root -g deploy -m 0775 -- "$shared_state_directory"');
    const runInitial = shellFunction(installer, "run_initial_release");
    const child = runInitial.indexOf('bash "$repository/deploy/release/run-release.sh"');
    expect(runInitial.lastIndexOf(
      'wrapper_force_router_maintenance_on_failure="true"', child,
    )).toBeGreaterThan(-1);
    expect(runInitial).toContain("arm_accepted_router_failure_containment");
    const finalizer = shellFunction(installer, "finalize_accepted_initial");
    expect(finalizer.indexOf('wrapper_force_router_maintenance_on_failure="true"'))
      .toBeLessThan(finalizer.indexOf("recover_accepted_terminal_inventory_gap"));
    expect(installer).toContain("business_finlynq_private-frontend release-app");
    expect(installer).toContain("business_finlynq_edge production-app");
  });

  it("propagates security-critical producer failures before publishing evidence", () => {
    const jqProducerSubstitution =
      /--arg(?:json)?\s+\S+\s+(?:\\\r?\n\s*)?"\$\((?:sha256sum|date -u)/u;
    for (const source of [installer, rehearsals, runner]) {
      expect(source).not.toMatch(jqProducerSubstitution);
    }
    expect(installer).toContain("checked_file_sha256");
    expect(installer).toContain("checked_utc_timestamp");
    expect(installer).toContain("assert_environment_value");
    expect(installer).toContain("existing initial evidence could not be enumerated");
    expect(rehearsals).toContain("canonical production checkout status could not be inspected");
    expect(rehearsals).toContain("canonical production checkout status could not be reinspected");
    expect(runner).toContain('if ! initial_secret_sources="$(jq -r');
    expect(runner).toContain("forward-repair application inventory could not be read");
    expect(runner).toContain(
      "forward-repair authentication-worker inventory could not be read",
    );
    expect(runner).not.toContain("done < <(");
    expect(developmentInstaller).toContain("checked_random_base64_32");
    expect(developmentInstaller).not.toContain(
      'printf \'%s\\n\' "$(openssl rand -base64 32)"',
    );
    for (const source of [
      installer,
      rehearsals,
      runner,
      developmentInstaller,
      developmentDeployer,
      externalEdgeVerifier,
    ]) {
      expect(source.split(/\r?\n/u).slice(0, 5)).toContain("set +x");
      expect(source).not.toContain("< <(");
    }
    expect(developmentDeployer).toContain(
      'repository_status="$(git_as_deploy status --porcelain=v1 --untracked-files=all)"',
    );
    expect(developmentDeployer).toContain("the development checkout status could not be read");
    expect(developmentDeployer).toContain(
      'duplicate_keys="$(sed -n',
    );
    expect(developmentDeployer).toContain(
      'require_public_acceptance="$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)" \\',
    );
    expect(developmentDeployer).not.toMatch(
      /\[\[\s*"\$\(read_environment_value (?:ACCOUNT_LOGIN_ENABLED|DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)\)"/u,
    );
    expect(developmentDeployer).toContain("duplicate container environment setting");
    expect(developmentDeployer).toContain("missing Compose environment setting");
  });
});
