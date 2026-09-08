import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const installer = read("deploy/production/install-initial-production.sh");
const rehearsals = read("deploy/production/run-initial-rehearsals.sh");
const runner = read("deploy/release/run-release.sh");
const developmentInstaller = read("deploy/development/install-development.sh");
const developmentDeployer = read("deploy/development/deploy-development.sh");
const externalEdgeVerifier = read("deploy/edge/verify-external-edge.sh");
const rehearsalCompose = read("deploy/release/docker-compose.rehearsal.yml");

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
    const finalizeStart = installer.indexOf("finalize_accepted_initial() {");
    const finalizeEnd = installer.indexOf("\n}\n\nif [[ \"$prepare_configuration_only\"", finalizeStart);
    const finalize = installer.slice(finalizeStart, finalizeEnd);
    const terminalValidation = finalize.indexOf(
      'verify_contained_initial_terminal_evidence "$accepted_run_id"',
    );
    const containment = finalize.indexOf('wrapper_stop_app_on_failure="true"');
    const recovery = finalize.indexOf('recover_accepted_stopped_app "$accepted_evidence"');
    const completion = finalize.indexOf('write_install_completion "$accepted_run_id"');
    const disarm = finalize.indexOf('wrapper_stop_app_on_failure="false"', completion);
    const output = finalize.indexOf("printf 'Recovered wrapper completion", completion);
    expect(terminalValidation).toBeGreaterThan(-1);
    expect(terminalValidation).toBeLessThan(containment);
    expect(containment).toBeLessThan(recovery);
    expect(terminalValidation).toBeLessThan(recovery);
    expect(recovery).toBeLessThan(completion);
    expect(completion).toBeLessThan(disarm);
    expect(disarm).toBeLessThan(output);
    expect(installer).toContain('if [[ -e "$install_completion" || -L "$install_completion" ]]; then');
    expect(installer).toContain("existing initial installation completion could not be synchronized");
  });

  it("binds wrapper completion to the live contained runtime and fresh one-shots", () => {
    expect(installer).toContain("verify_live_accepted_initial_runtime");
    expect(installer).toContain("11-images.json");
    expect(installer).toContain("14-evidence-scanner.json");
    expect(installer).toContain('"HostIp":"127.0.0.1", "HostPort":"3100"');
    expect(installer).toContain("live app differs from the accepted contained runtime");
    expect(installer).toContain("business-finlynq-accounting-evidence.service");
    expect(installer).toContain("business-finlynq-monitor.service");
    expect(installer).toContain("--property=InvocationID");
    expect(installer).toContain('current_invocation" != "$previous_invocation');
    expect(installer).toContain("containedInitial == true");
    expect(installer).toContain("offsiteBackupDeferred == true");
    expect(installer).toContain("schedulerActivationDeferred == true");
    expect(installer).not.toContain("initialTimersEnabled");
    expect(installer).not.toContain("offsiteBackupDelivery");
  });

  it("recovers only the exact stopped accepted app and recontains finalization failures", () => {
    expect(installer).toContain("recover_accepted_stopped_app");
    expect(installer).toContain("terminal recovery requires exactly app, database, and scanner containers");
    expect(installer).toContain("terminal-recovery scanner signature is writable, stale, or future-dated");
    expect(installer).toContain('start_output="$(docker start "$app_container")"');
    expect(installer).toContain("wrapper_stop_app_on_failure=\"true\"");
    expect(installer).toContain("stopped app differs from the exact accepted contained contract");
    const finalize = installer.slice(installer.indexOf("finalize_accepted_initial()"));
    const optionalFailure = finalize.indexOf('if [[ -f "$accepted_evidence/99-failure.json" ]]');
    const recovery = finalize.indexOf('recover_accepted_stopped_app "$accepted_evidence"');
    const optionalFailureEnd = finalize.indexOf("\n  fi", optionalFailure);
    expect(optionalFailure).toBeGreaterThan(-1);
    expect(optionalFailureEnd).toBeLessThan(recovery);
  });

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
    expect(installer).toContain("business-finlynq-continuous-deployment.timer");
    expect(installer).toContain("business-finlynq-development-deployment.timer");
    expect(installer).toContain("productionContinuousDeploymentInstalled: false");
    expect(installer).toContain("developmentDeploymentEnabled: false");
    expect(installer).toContain("for service_name in app auth_email_worker; do");
    expect(installer).toContain("wrapper_stop_app_on_failure");
    expect(developmentInstaller).toContain('install -d -o root -g deploy -m 0775 -- "$shared_state_directory"');
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
