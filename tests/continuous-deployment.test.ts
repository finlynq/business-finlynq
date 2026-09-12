import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const workflow = read(".github", "workflows", "signal-production-deployment.yml");
const qualityGateWorkflow = read(".github", "workflows", "ci.yml");
const deployMain = read("deploy", "continuous-deployment", "deploy-main.sh");
const installProduction = read(
  "deploy",
  "continuous-deployment",
  "install-production.sh",
);
const releaseRunner = read("deploy", "release", "run-release.sh");
const deployService = read(
  "deploy",
  "continuous-deployment",
  "business-finlynq-continuous-deployment.service",
);
const reconcileSharedEdge = read("deploy", "edge", "reconcile-shared-edge.sh");
const deployDevelopment = read("deploy", "development", "deploy-development.sh");
const installDevelopment = read("deploy", "development", "install-development.sh");
const playwrightConfig = read("playwright.config.ts");
const compose = read("docker-compose.yml");
const allowRevisions = read(
  "deploy",
  "continuous-deployment",
  "allow-backup-revisions.sh",
);
const receiverInstaller = read(
  "deploy",
  "continuous-deployment",
  "install-backup-receiver.sh",
);

describe("continuous deployment safety boundary", () => {
  it("runs branch pushes deliberately and cancels only stale pull-request checks", () => {
    expect(qualityGateWorkflow).toContain([
      "on:",
      "  push:",
      "    branches:",
      "      - main",
      "      - stage",
      "      - dev",
      "  pull_request:",
    ].join("\n"));
    expect(qualityGateWorkflow).toContain(
      "group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}",
    );
    expect(qualityGateWorkflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
  });

  it("reuses only the incremental Next.js build cache across matching dependencies", () => {
    const cacheStart = qualityGateWorkflow.indexOf("- name: Restore Next.js build cache");
    const cacheEnd = qualityGateWorkflow.indexOf("\n      - ", cacheStart + 1);
    const cacheBlock = qualityGateWorkflow.slice(cacheStart, cacheEnd);
    const buildStart = qualityGateWorkflow.indexOf("- run: npm run build");

    expect(cacheStart).toBeGreaterThan(-1);
    expect(cacheStart).toBeLessThan(buildStart);
    expect(cacheBlock).toContain("uses: actions/cache@v5");
    expect(cacheBlock).toContain("path: ${{ github.workspace }}/.next/cache");
    expect(cacheBlock).toContain("hashFiles('package-lock.json')");
    expect(cacheBlock).toContain(
      "hashFiles('src/**', 'public/**', 'package.json', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs')",
    );
    expect(cacheBlock).not.toContain("**/*.ts");
    expect(cacheBlock).toContain(
      "${{ runner.os }}-nextjs-${{ hashFiles('package-lock.json') }}-",
    );
    expect(cacheBlock).not.toMatch(/node_modules|test-results|evidence|security/i);
  });

  it("attests only a successful exact same-repository main quality gate", () => {
    expect(workflow).toContain([
      "permissions:",
      "  contents: write",
      "  id-token: write",
      "  attestations: write",
    ].join("\n"));
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("- quality-gate");
    expect(workflow).toContain([
      "    branches:",
      "      - main",
      "    types:",
    ].join("\n"));
    expect(workflow).toContain("workflow_run.conclusion == 'success'");
    expect(workflow).toContain("workflow_run.event == 'push'");
    expect(workflow).toContain("workflow_run.head_branch == 'main'");
    expect(workflow).toContain(
      "workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain(
      "uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0",
    );
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "UPSTREAM_WORKFLOW_PATH: ${{ github.event.workflow_run.path }}",
    );
    expect(workflow).toContain('test "$UPSTREAM_WORKFLOW_ID" = \'343064471\'');
    expect(workflow).toContain('test "$UPSTREAM_REPOSITORY_ID" = \'1347535948\'');
    expect(workflow).toContain('test "$CURRENT_REPOSITORY_ID" = \'1347535948\'');
    expect(workflow).toContain(".github/workflows/ci.yml@main");
    expect(workflow).toContain([
      "            'business-finlynq-production-deployment-v1' \\",
      "            'finlynq/business-finlynq' \\",
      '            "$CANDIDATE_REVISION" \\',
    ].join("\n"));
    expect(workflow).toContain(
      "uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2",
    );
    expect(workflow).toContain("subject-path: ${{ runner.temp }}/business-finlynq-production-deployment-v1.txt");
    expect(workflow).toContain("ATTESTATION_BUNDLE: ${{ steps.attest.outputs.bundle-path }}");
    expect(workflow).toContain([
      "          ' \"$ATTESTATION_BUNDLE\" >/dev/null",
      '          install -m 0600 -- "$ATTESTATION_BUNDLE" "$transport"',
      '          cmp --silent -- "$ATTESTATION_BUNDLE" "$transport"',
    ].join("\n"));
    expect(workflow).not.toContain('\"$ATTESTATION_BUNDLE\" >\"$transport\"');
    expect(workflow).toContain("release=production-deployment-signals");
    expect(workflow).toContain("gh release upload");
    expect(workflow).not.toContain("git tag");
  });

  it("deploys only the signalled fast-forward origin/main commit", () => {
    expect(deployMain).toContain(
      'remote_main_revision="$(git_as_deploy rev-parse refs/remotes/origin/main)"',
    );
    expect(deployMain).toContain('candidate_revision="$remote_main_revision"');
    expect(deployMain).toContain('if [[ "$release_forward_repair_pending" == true ]]');
    expect(deployMain).toContain('candidate_revision="$release_transition_candidate_revision"');
    expect(deployMain).toContain(
      '"$release_transition_candidate_revision" "$remote_main_revision"',
    );
    expect(deployMain).toContain(
      'git_as_deploy merge-base --is-ancestor "$source_revision" "$candidate_revision"',
    );
    expect(deployMain).toContain("verify_ci_approved_production_signal() (");
    expect(deployMain).toContain('readonly github_cli="/usr/bin/gh"');
    expect(deployMain).toContain(
      'readonly production_signal_repository="finlynq/business-finlynq"',
    );
    expect(deployMain).toContain(
      'readonly production_signal_certificate_identity="https://github.com/finlynq/business-finlynq/.github/workflows/signal-production-deployment.yml@refs/heads/main"',
    );
    expect(deployMain).toContain("GitHub CLI 2.100.0 or newer");
    const signalVerifierStart = deployMain.indexOf(
      "verify_ci_approved_production_signal() (",
    );
    const signalVerifierEnd = deployMain.indexOf("\n)\n", signalVerifierStart);
    const signalVerifier = deployMain.slice(signalVerifierStart, signalVerifierEnd);
    expect(signalVerifier).toContain([
      "  printf '%s\\nrepository=%s\\nrevision=%s\\n' \\",
      "    'business-finlynq-production-deployment-v1' \\",
      '    "$production_signal_repository" \\',
      '    "$candidate_revision" >"$signal_file"',
    ].join("\n"));
    expect(signalVerifier).toContain(
      'signal_asset="business-finlynq-production-deployment-$candidate_revision.attestation.json"',
    );
    expect(signalVerifier).toContain(
      '"https://github.com/$production_signal_repository/releases/download/production-deployment-signals/$signal_asset"',
    );
    expect(signalVerifier).toContain("curl --disable --proto '=https'");
    expect(signalVerifier).toContain("--proto-redir '=https'");
    expect(signalVerifier).toContain("--max-filesize 16777216");
    expect(signalVerifier).toContain("env -i \\");
    expect(signalVerifier).not.toContain("GH_TOKEN");
    expect(signalVerifier).toContain(
      '.mediaType == "application/vnd.dev.sigstore.bundle.v0.3+json"',
    );
    expect(signalVerifier).toContain(
      '.dsseEnvelope.payloadType == "application/vnd.in-toto+json"',
    );
    expect(signalVerifier).toContain("--bundle \"$bundle_file\"");
    expect(signalVerifier).toContain(
      "--cert-identity \"$production_signal_certificate_identity\"",
    );
    expect(signalVerifier).toContain(
      "--cert-oidc-issuer https://token.actions.githubusercontent.com",
    );
    expect(signalVerifier).toContain('--signer-digest "$candidate_revision"');
    expect(signalVerifier).toContain('--source-digest "$candidate_revision"');
    expect(signalVerifier).toContain("--source-ref refs/heads/main");
    expect(signalVerifier).toContain("--deny-self-hosted-runners");
    expect(signalVerifier).not.toContain("--signer-workflow");
    expect(deployMain).not.toContain("refs/tags/deploy-production-");
    const fetchedMain = deployMain.indexOf("git_as_deploy fetch --prune --force --no-tags origin");
    const trustedWorkflows = deployMain.indexOf(
      "candidate_uses_trusted_production_workflows \\",
    );
    const signalVerified = deployMain.indexOf(
      "verify_ci_approved_production_signal \\",
    );
    const receiverUpdated = deployMain.indexOf('"allow $backup_source_revision $candidate_revision"');
    const candidateEnvironmentPrepared = deployMain.indexOf(
      'prepare_revision_file "$compose_environment"',
    );
    const mutationArmed = deployMain.indexOf('mutated="true"');
    expect(trustedWorkflows).toBeGreaterThan(fetchedMain);
    expect(signalVerified).toBeGreaterThan(trustedWorkflows);
    expect(signalVerified).toBeLessThan(receiverUpdated);
    expect(receiverUpdated).toBeLessThan(candidateEnvironmentPrepared);
    expect(candidateEnvironmentPrepared).toBeLessThan(mutationArmed);
    expect(signalVerified).toBeLessThan(mutationArmed);
    expect(installProduction).toContain('readonly github_cli="/usr/bin/gh"');
    expect(installProduction).toContain("GitHub CLI 2.100.0 or newer is required");
    expect(installProduction).toContain("--bundle");
    expect(deployMain).toContain(
      'readonly production_signal_cache_directory="/var/cache/business-finlynq/github-attestations"',
    );
    expect(signalVerifier).toContain(
      'XDG_CACHE_HOME="$production_signal_cache_directory"',
    );
    expect(signalVerifier).not.toContain('XDG_CACHE_HOME="$signal_directory/cache"');
    expect(installProduction).toContain(
      'readonly attestation_cache_directory="$attestation_cache_parent/github-attestations"',
    );
    expect(installProduction).toContain(
      '"$(stat -c \'%u:%g:%a\' -- "$attestation_cache_directory")" == 0:0:700',
    );
    expect(deployMain).toContain("candidate_uses_trusted_production_workflows() {");
    expect(deployMain).toContain(
      'git_as_deploy cat-file blob "$candidate_revision:$path" | sha256sum',
    );
    expect(deployMain).toContain(
      `readonly production_signal_workflow_sha256="${sha256(workflow)}"`,
    );
    expect(deployMain).toContain(
      `readonly quality_gate_workflow_sha256="${sha256(qualityGateWorkflow)}"`,
    );
    expect(deployMain).toContain('git_as_deploy merge --ff-only "$candidate_revision"');
    expect(deployMain).toContain('bash "$repository/deploy/release/run-release.sh"');
    expect(deployMain).toContain("--scheduler systemd");
    const releaseAccepted = deployMain.lastIndexOf(
      'release_is_accepted || fail "the release runner returned without an accepted live revision"',
    );
    const edgeReconciled = deployMain.lastIndexOf(
      'bash "$repository/deploy/edge/verify-external-edge.sh" --scope production',
    );
    expect(edgeReconciled).toBeGreaterThan(releaseAccepted);
    expect(deployMain.indexOf('mutated="false"', edgeReconciled)).toBeGreaterThan(edgeReconciled);
  });

  it("clears an acknowledged failure latch without deployment prerequisites", () => {
    const clearStart = deployMain.indexOf('if [[ "${1:-}" == "--clear-failure" ]]');
    const clearEnd = deployMain.indexOf('[[ "$#" == 0 ]]', clearStart);
    const fullPrerequisites = deployMain.indexOf("for command_name in awk bash");
    const githubValidation = deployMain.indexOf("require_secure_github_cli \\");
    const clearPath = deployMain.slice(clearStart, clearEnd);

    expect(clearStart).toBeGreaterThan(-1);
    expect(clearStart).toBeLessThan(fullPrerequisites);
    expect(clearStart).toBeLessThan(githubValidation);
    expect(clearPath).toContain("CONTINUOUS_DEPLOYMENT_FAILURE_ACK");
    expect(clearPath).toContain('grep -Fxq "candidateRevision=$2"');
    expect(clearPath).toContain('rm -- "$failure_latch"');
    expect(clearPath).toContain('sync -f -- "${failure_latch%/*}"');
    expect(clearPath).not.toMatch(/\b(?:curl|docker|gh|git|ssh|systemctl)\b/);
  });

  it("independently recontains a failed or killed release child", () => {
    const containment = deployMain.slice(
      deployMain.indexOf("force_parent_release_router_maintenance() {"),
      deployMain.indexOf("\ncleanup() {"),
    );
    const parentCleanup = deployMain.slice(
      deployMain.indexOf("\ncleanup() {") + 1,
      deployMain.indexOf("\ntrap cleanup EXIT"),
    );
    expect(parentCleanup).toContain("trap - EXIT");
    expect(parentCleanup).toContain("trap '' HUP INT TERM");
    expect(parentCleanup).not.toContain("trap - EXIT HUP INT TERM");
    expect(containment).toContain("business_finlynq_private-release-router-state-v2");
    expect(containment).toContain('printf "maintenance\\n"');
    expect(containment).toContain("Caddyfile.maintenance");
    expect(containment).toContain("pause-schedulers.sh");
    expect(containment).toContain("systemd --allow-already-paused");
    expect(containment).toContain("stop_parent_release_service auth_email_worker");
    expect(containment).toContain("stop_parent_public_alias_owners");
    expect(containment).toContain("source_pre_router_runtime_is_safely_active");
    expect(deployMain).toContain("source_pre_router_runtime_is_safely_active() {");
    expect(deployMain).toContain(
      'readonly legacy_f8485_image_id="sha256:2135e8e936bf8befdc44132771698dfb942fc97dccb19b71eeb3db9f3e5b66b5"',
    );
    expect(deployMain).toContain(
      "export ROLLBACK_COMPATIBILITY_ACK=f8485-one-release-only",
    );
    const child = deployMain.indexOf('bash "$repository/deploy/release/run-release.sh"');
    const arm = deployMain.lastIndexOf('release_child_containment_armed="true"', child);
    const strictAcceptance = deployMain.indexOf("release_is_accepted || fail", child);
    const disarm = deployMain.indexOf('release_child_containment_armed="false"', child);
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(child);
    expect(child).toBeLessThan(strictAcceptance);
    expect(strictAcceptance).toBeLessThan(disarm);
    expect(deployMain).toContain("containmentProven=%s");
    expect(deployService).toContain("TimeoutStopSec=15m");
    expect(deployService).toContain("KillMode=control-group");
    expect(deployService).toContain("KillSignal=SIGTERM");
  });

  it("never blesses an interrupted same-revision production release from health alone", () => {
    const evidenceVerifier = deployMain.slice(
      deployMain.indexOf("evidence_inventory_is_valid() {"),
      deployMain.indexOf("\nrelease_is_accepted() {"),
    );
    const accepted = deployMain.slice(
      deployMain.indexOf("release_runtime_matches_accepted_evidence() {"),
      deployMain.indexOf('\nif [[ "$source_revision" == "$candidate_revision" ]]'),
    );
    expect(evidenceVerifier).toContain("sha256sum --check --strict --quiet SHA256SUMS");
    expect(evidenceVerifier).toContain("90-release-complete.json");
    expect(evidenceVerifier).toContain('.mode == "release"');
    expect(evidenceVerifier).toContain('.status == "accepted"');
    expect(evidenceVerifier).toContain('.candidateAppImageId == $appImage');
    expect(evidenceVerifier).toContain('.releaseRouterImageId == $routerImage');
    expect(evidenceVerifier).toContain("keys == ([");
    for (const terminalKey of [
      "browserAcceptancePassed",
      "browserLogSha256",
      "candidateAppImageId",
      "completedAt",
      "containedInitial",
      "databaseRollback",
      "localEncryptedBackupVerified",
      "maintenanceConfirmedBeforeSchemaMigration",
      "mode",
      "offsiteBackupDeferred",
      "postBootstrapAccountingEvidenceVerified",
      "preTrafficDatabaseContractVerified",
      "previousAppImageId",
      "product",
      "releaseRouterConfigSha256",
      "releaseRouterImageId",
      "revision",
      "runId",
      "schedulerActivationDeferred",
      "schemaVersion",
      "status",
    ]) {
      expect(evidenceVerifier).toContain(`"${terminalKey}"`);
    }
    expect(evidenceVerifier).toContain(
      'test("^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T',
    );
    expect(evidenceVerifier).toContain(
      '.previousAppImageId | type == "string" and test("^sha256:[a-f0-9]{64}$")',
    );
    expect(evidenceVerifier).toContain(
      '.releaseRouterConfigSha256 | type == "string" and test("^[a-f0-9]{64}$")',
    );
    expect(evidenceVerifier).toContain(
      "'$2 == \"./70-browser-acceptance.log\" { print $1 }'",
    );
    expect(evidenceVerifier).toContain('sha256sum -- "$browser_log"');
    expect(evidenceVerifier).toContain(
      '"$browser_log_actual_sha256" == "$browser_log_inventory_sha256"',
    );
    expect(evidenceVerifier).toContain(
      '.browserLogSha256 == $browserLogSha256',
    );
    expect(accepted).toContain('[[ "$router_mode" == "$expected_router_mode" ]]');
    expect(accepted).toContain(
      'accepted_terminal_evidence_exists "$app_image" "$router_image"',
    );
    expect(accepted).toContain(
      "release_runtime_matches_accepted_evidence active",
    );
    expect(accepted).toContain("live_release_router_is_active");
    expect(deployMain).toContain(
      "has no complete active acceptance; safely rerunning its release gates.",
    );
    expect(deployMain).not.toContain(
      "matching release is not accepted; automatic retry is unsafe",
    );
  });

  it("recovers journaled same-revision reruns after a host interruption", () => {
    expect(deployMain).toContain(".candidateRevision == $candidateRevision");
    expect(deployMain).not.toContain(".sourceRevision != .candidateRevision");
    expect(releaseRunner).toContain(".candidateRevision == $candidateRevision");
    expect(releaseRunner).not.toContain(".sourceRevision != $candidateRevision");
    expect(deployMain).toContain('if [[ "$source_revision" == "$candidate_revision" ]]');
  });

  it("finalizes only an evidenced live-active release left durably in maintenance", () => {
    const verifierStart = deployMain.indexOf(
      "release_runtime_matches_accepted_evidence() {",
    );
    const atomicFinalizerStart = deployMain.indexOf(
      "atomically_reload_router_active_and_persist() {",
    );
    const finalizerStart = deployMain.indexOf(
      "persist_interrupted_acceptance_active() {",
    );
    const sameRevisionStart = deployMain.indexOf(
      'if [[ "$source_revision" == "$candidate_revision" ]]',
    );
    const earlyContainmentStart = deployMain.indexOf(
      "contain_unaccepted_live_router_before_fetch() {",
    );
    const atomicFinalizer = deployMain.slice(atomicFinalizerStart, finalizerStart);
    const finalizer = deployMain.slice(finalizerStart, earlyContainmentStart);
    const sameRevision = deployMain.slice(
      sameRevisionStart,
      deployMain.indexOf("\nverify_ci_approved_production_signal() (", sameRevisionStart),
    );

    expect(verifierStart).toBeGreaterThan(-1);
    expect(atomicFinalizerStart).toBeGreaterThan(verifierStart);
    expect(finalizerStart).toBeGreaterThan(verifierStart);
    expect(earlyContainmentStart).toBeGreaterThan(finalizerStart);
    expect(deployMain).toContain(
      "release_runtime_matches_accepted_evidence maintenance",
    );
    expect(deployMain).toContain(
      'readonly active_finalization_max_authorization_age_seconds="3600"',
    );
    expect(deployMain).toContain('"$active_finalization_phase" == "active-commit-authorized"');
    expect(deployMain).toContain("active_finalization_authorization_is_current() {");
    expect(deployMain).toContain("terminalEvidenceSha256");
    expect(deployMain).toContain(
      "current_epoch - authorized_epoch <= active_finalization_max_authorization_age_seconds",
    );
    expect(deployMain).toContain(
      "--header 'X-Business-Finlynq-Internal-Health: 1'",
    );
    expect(deployMain).toContain(
      "--header 'X-Request-Id: continuous-deployment-active-finalizer'",
    );
    expect(deployMain).toContain(
      "type == \"object\" and keys == [\"status\"] and .status == \"ready\"",
    );
    expect(finalizer).toContain("interrupted_acceptance_is_finalizable");
    expect(finalizer).toContain('"$active_finalization_revision" == "$source_revision"');
    expect(finalizer).toContain("atomically_reload_router_active_and_persist");
    expect(atomicFinalizer).toContain('"$(cat /state/mode)" == maintenance');
    expect(atomicFinalizer).toContain("caddy reload --config /etc/caddy/Caddyfile");
    expect(atomicFinalizer).toContain('printf "active\\n" >"$temporary"');
    expect(atomicFinalizer).toContain('mv -f "$temporary" /state/mode');
    expect(atomicFinalizer).toContain("sync /state/mode 2>/dev/null || sync");
    expect(atomicFinalizer).toContain("sync -f /state 2>/dev/null || sync");
    expect(atomicFinalizer).toContain("Caddyfile.maintenance");
    expect(deployMain.indexOf("contain_unaccepted_live_router_before_fetch ")).toBeLessThan(
      deployMain.indexOf("git_as_deploy fetch --prune"),
    );
    expect(deployMain).toContain("Caddyfile.maintenance");

    const eligible = sameRevision.indexOf(
      "if interrupted_acceptance_is_finalizable; then",
    );
    const commit = sameRevision.indexOf(
      "persist_interrupted_acceptance_active",
      eligible,
    );
    const strictRecheck = sameRevision.indexOf("release_is_accepted", commit);
    const reconcile = sameRevision.indexOf(
      'bash "$repository/deploy/edge/verify-external-edge.sh" --scope production',
      strictRecheck,
    );
    const exit = sameRevision.indexOf("exit 0", reconcile);
    expect(eligible).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(eligible);
    expect(strictRecheck).toBeGreaterThan(commit);
    expect(reconcile).toBeGreaterThan(strictRecheck);
    expect(exit).toBeGreaterThan(reconcile);
  });

  it("signals stage only after its complete quality gate succeeds", () => {
    expect(qualityGateWorkflow).toContain("signal-staging:");
    expect(qualityGateWorkflow).toContain("github.ref == 'refs/heads/stage'");
    expect(qualityGateWorkflow).toContain("needs: verify");
    expect(qualityGateWorkflow).toContain('tag="deploy-stage-$CANDIDATE_REVISION"');
    expect(qualityGateWorkflow).toContain("'+refs/heads/stage:refs/remotes/origin/stage'");
  });

  it("requires network-wide unique router and app aliases in accepted runtimes", () => {
    for (const source of [deployMain, deployDevelopment]) {
      expect(source).toContain('--filter "network=$network"');
      expect(source).toContain('[[ "$container" == "$expected_full_id" ]]');
    }
    expect(deployMain).toContain(
      "business_finlynq_private-frontend release-app \"$app_container\"",
    );
    expect(deployDevelopment).toContain(
      "business_finlynq_development_private-frontend release-app",
    );
    expect(deployDevelopment).toContain(
      "business_finlynq_development_edge development-app",
    );
  });

  it("deploys stage through a disjoint checkout, state tree, port, and resource namespace", () => {
    expect(deployDevelopment).toContain(
      'readonly repository="/home/deploy/business-finlynq-stage"',
    );
    expect(deployDevelopment).toContain(
      'readonly compose_environment="/etc/business-finlynq-development/compose.env"',
    );
    expect(deployDevelopment).toContain(
      'readonly state_directory="/var/lib/business-finlynq-development"',
    );
    expect(deployDevelopment).toContain(
      'candidate_revision="$(git_as_deploy rev-parse refs/remotes/origin/stage)"',
    );
    expect(deployDevelopment).toContain('signal_tag="deploy-stage-$candidate_revision"');
    expect(deployDevelopment).toContain(
      'readonly installed_deployer="/usr/local/sbin/business-finlynq-deploy-development"',
    );
    const signalVerification = deployDevelopment.indexOf(
      '[[ "$signal_revision" == "$candidate_revision" ]]',
    );
    const deployerRefresh = deployDevelopment.indexOf(
      'refresh_installed_deployer_if_needed "$candidate_revision"',
    );
    const candidateMutation = deployDevelopment.indexOf(
      'git_as_deploy merge --ff-only "$candidate_revision"',
    );
    expect(deployerRefresh).toBeGreaterThan(signalVerification);
    expect(candidateMutation).toBeGreaterThan(deployerRefresh);
    expect(deployDevelopment).toContain(
      'expected_oid="$(git_as_deploy rev-parse "$revision:$relative_path")"',
    );
    expect(deployDevelopment).toContain(
      'observed_oid="$(git_as_deploy hash-object --stdin <"$candidate_source")"',
    );
    expect(deployDevelopment).toContain(
      'mv -T -- "$staged_target" "$installed_deployer"',
    );
    expect(deployDevelopment).toContain('exec env -i PATH="$clean_path" "$installed_deployer"');
    expect(deployDevelopment).toContain("http://127.0.0.1:3200/api/health");
    expect(deployDevelopment).not.toContain("/etc/business-finlynq/compose.env");
    expect(deployDevelopment).not.toContain("refs/remotes/origin/main");
    for (const resource of [
      "pgdata",
      "private",
      "egress",
      "edge",
      "restore_drill",
    ]) {
      expect(installDevelopment).toContain(`business_finlynq_development_${resource}`);
    }
    expect(installDevelopment).not.toContain("business_finlynq_development_caddy_data");
    expect(installDevelopment).not.toContain("business_finlynq_development_caddy_config");
  });

  it("creates the candidate deployer staging file with the reviewed mktemp command", () => {
    const start = deployDevelopment.indexOf('  candidate_source="$(mktemp');
    const end = deployDevelopment.indexOf("\n  expected_oid=", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const stagingCommand = deployDevelopment.slice(start, end);
    const bash =
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\bin\\bash.exe"
        : "bash";
    const result = spawnSync(
      bash,
      [
        "-c",
        [
          "set -Eeuo pipefail",
          'state_directory="$(mktemp -d)"',
          'revision="0123456789abcdef0123456789abcdef01234567"',
          'trap \'rm -rf -- "$state_directory"\' EXIT',
          'candidate_source=""',
          'fail() { printf \'%s\\n\' "$*" >&2; exit 1; }',
          stagingCommand,
          'test -f "$candidate_source"',
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "mktemp staging command failed");
    }
  });

  it("serializes application deployments while preserving central-edge aliases", () => {
    const sharedLock = 'readonly host_deployment_lock="/var/lib/business-finlynq/deployment-host.lock"';
    expect(deployMain).toContain(sharedLock);
    expect(deployDevelopment).toContain(sharedLock);
    expect(compose).toContain("BUSINESS_FINLYNQ_APP_NETWORK_ALIAS:-production-app");
    expect(compose).toContain("BUSINESS_FINLYNQ_EDGE_NETWORK:-business_finlynq_edge");
    expect(compose).not.toMatch(/^  edge:\s*$/mu);
    expect(reconcileSharedEdge).toContain("verify-external-edge.sh");
    for (const script of [deployMain, deployDevelopment]) {
      expect(script).toContain("0:$deploy_gid:660:1");
      expect(script).toContain('exec 8<>"$host_deployment_lock"');
    }
    expect(installDevelopment).toContain(
      'readonly host_deployment_lock="$shared_state_directory/deployment-host.lock"',
    );
    expect(installDevelopment).toContain("0:$deploy_gid:660:1");
  });

  it("keeps the legacy reconciler name read-only", () => {
    expect(reconcileSharedEdge).toContain("verify-external-edge.sh");
    expect(reconcileSharedEdge).toContain("--scope production");
    expect(reconcileSharedEdge).not.toContain("docker compose");
    expect(reconcileSharedEdge).not.toContain("caddy reload");
    expect(reconcileSharedEdge).not.toContain("epm-finlynq");
    expect(reconcileSharedEdge).not.toContain("consult-finlynq");
  });

  it("starts development with external identity integrations disabled", () => {
    expect(installDevelopment).toContain("ACCOUNT_LOGIN_ENABLED=false");
    expect(installDevelopment).toContain("AUTH_OIDC_ENABLED=false");
    expect(installDevelopment).toContain("AUTH_OIDC_SIGNUP_ENABLED=false");
    expect(installDevelopment).toContain("ACCOUNT_SIGNUP_ENABLED=false");
    expect(installDevelopment).toContain("AUTH_EMAIL_DELIVERY_ENABLED=false");
    expect(installDevelopment).toContain("SIGNUP_TURNSTILE_ENABLED=false");
    expect(installDevelopment).toContain("BUSINESS_WRITES_ENABLED=true");
    expect(installDevelopment).toContain("BANK_FEEDS_ENABLED=false");
    expect(installDevelopment).toContain("YAHOO_FX_ENABLED=false");
    expect(installDevelopment).toContain("--enable-yahoo-fx-experimental");
    expect(installDevelopment).toContain("--disable-yahoo-fx");
  });

  it("keeps pre-OIDC development revisions recoverable across the SSO release boundary", () => {
    expect(deployDevelopment).toContain("revision_uses_oidc_runtime_contract() {");
    expect(deployDevelopment).toContain(
      'revision_uses_oidc_runtime_contract "$expected_revision"',
    );
    expect(deployDevelopment).toContain(
      '"$app_container" "$rendered" "$oidc_contract_expected"',
    );
    expect(deployDevelopment).toContain(
      'for setting in "${required_environment_settings[@]}"',
    );
  });

  it("enables every development feature only with isolated provider secrets", () => {
    expect(installDevelopment).toContain("--enable-all-features");
    expect(installDevelopment).toContain("resend-api-key turnstile-secret-key");
    expect(installDevelopment).toContain("root:business-finlynq-secrets:440");
    for (const gate of [
      "ACCOUNT_LOGIN_ENABLED",
      "ACCOUNT_SIGNUP_ENABLED",
      "BUSINESS_WRITES_ENABLED",
      "BANK_FEEDS_ENABLED",
    ]) {
      expect(installDevelopment).toContain(`= "${gate}"`);
    }
    expect(installDevelopment).toContain('values[keys[key_index]] = "true"');
    expect(installDevelopment).not.toContain("for (index =");
    expect(deployDevelopment).toContain("SIGNUP_TURNSTILE_SITE_KEY");
    expect(deployDevelopment).toContain("YAHOO_FX_ENABLED");
    expect(deployDevelopment).toContain('[[ "$actual" == "$expected" ]] || return 1');
  });

  it("waits for the public route before externally targeted browser acceptance", () => {
    const readiness = deployDevelopment.lastIndexOf(
      "    if ( wait_for_public_readiness",
    );
    const acceptance = deployDevelopment.lastIndexOf(
      "compose --profile acceptance run --rm --no-deps release_acceptance",
    );
    expect(deployDevelopment).toContain("deadline=$((SECONDS + 120))");
    expect(deployDevelopment).toContain('"https://$hostname/api/health"');
    expect(readiness).toBeGreaterThan(0);
    expect(acceptance).toBeGreaterThan(readiness);
    expect(deployDevelopment).toContain("for attempt in 1 2");
    expect(playwrightConfig).toContain(
      'const managedServer = process.env.PLAYWRIGHT_MANAGED_SERVER === "true";',
    );
    expect(playwrightConfig).toContain("webServer: managedServer ? undefined : {");
    expect(compose).toContain('PLAYWRIGHT_MANAGED_SERVER: "true"');
  });

  it("keeps development reachable through a verified release router during cutover", () => {
    const build = deployDevelopment.indexOf("deployment_stage=build");
    const maintenance = deployDevelopment.indexOf("deployment_stage=enter-maintenance");
    const stop = deployDevelopment.indexOf(
      "compose --profile auth-email stop --timeout 60 auth_email_worker app",
      maintenance,
    );
    const router = deployDevelopment.indexOf(
      "compose up --detach --wait --no-deps --no-build release_router",
      stop,
    );
    const maintenanceReload = deployDevelopment.indexOf(
      "reload_release_router maintenance",
      router,
    );
    const proof = deployDevelopment.indexOf(
      "wait_for_release_router_maintenance",
      maintenanceReload,
    );
    const app = deployDevelopment.indexOf("deployment_stage=live-apply", proof);
    const candidateProof = deployDevelopment.indexOf(
      "deployment_stage=candidate-verification",
      app,
    );
    const activeReload = deployDevelopment.indexOf(
      "reload_release_router_live active",
      candidateProof,
    );

    expect([
      build,
      maintenance,
      stop,
      router,
      maintenanceReload,
      proof,
      app,
      candidateProof,
      activeReload,
    ].every((position) => position >= 0))
      .toBe(true);
    expect(build).toBeLessThan(maintenance);
    expect(maintenance).toBeLessThan(stop);
    expect(stop).toBeLessThan(router);
    expect(router).toBeLessThan(maintenanceReload);
    expect(maintenanceReload).toBeLessThan(proof);
    expect(router).toBeLessThan(proof);
    expect(proof).toBeLessThan(app);
    expect(app).toBeLessThan(candidateProof);
    expect(candidateProof).toBeLessThan(activeReload);
    expect(deployDevelopment).toContain(
      'readonly release_router_reference="business-finlynq-release-router:v2"',
    );
    expect(deployDevelopment).toContain(
      'readonly release_router_revision="release-router-v2"',
    );
    expect(deployDevelopment).toContain(
      'readonly release_router_build_project="business-finlynq-release-router-build-v2"',
    );
    expect(deployDevelopment).toContain("compose_release_router_build");
    expect(deployDevelopment).toContain('"business_finlynq_development_private-frontend"');
    expect(deployDevelopment).toContain('"business_finlynq_development_private-router-control"');
    expect(deployDevelopment).toContain(".services.release_router.ports[0].published");
    expect(deployDevelopment).toContain(".services.app.ports | length");
    expect(deployDevelopment).toContain('keys == ["status"] and .status == "unavailable"');
    expect(deployDevelopment).toContain("router_container_output");
    expect(deployDevelopment).toContain("--address unix//tmp/caddy-admin.sock");
    expect(deployDevelopment).toContain(
      '"BUSINESS_FINLYNQ_RELEASE_ACCEPTANCE_TOKEN=$release_acceptance_token"',
    );
    expect(deployDevelopment).toContain(
      '--header "Authorization: Bearer $release_acceptance_token"',
    );
    expect(deployDevelopment).not.toContain("--force-recreate release_router");
    expect(deployDevelopment).not.toContain('"business-finlynq-release-router:$revision"');
  });

  it("quarantines and exactly restores the legacy development alias around first-router bootstrap", () => {
    const maintenance = deployDevelopment.indexOf("deployment_stage=enter-maintenance");
    const identify = deployDevelopment.indexOf(
      'legacy_app_container="$(exact_legacy_development_app_container "$source_revision")"',
      maintenance,
    );
    const stop = deployDevelopment.indexOf(
      "compose --profile auth-email stop --timeout 60 auth_email_worker app",
      identify,
    );
    const quarantine = deployDevelopment.indexOf(
      'quarantine_legacy_development_app_alias "$source_revision" "$legacy_app_container"',
      stop,
    );
    const router = deployDevelopment.indexOf(
      "compose up --detach --wait --no-deps --no-build release_router",
      quarantine,
    );
    expect(identify).toBeGreaterThan(maintenance);
    expect(stop).toBeGreaterThan(identify);
    expect(quarantine).toBeGreaterThan(stop);
    expect(router).toBeGreaterThan(quarantine);

    const quarantineStart = deployDevelopment.indexOf(
      "quarantine_legacy_development_app_alias() {",
    );
    const quarantineEnd = deployDevelopment.indexOf(
      "\nrestore_legacy_development_app_alias() {",
      quarantineStart,
    );
    const quarantineBody = deployDevelopment.slice(quarantineStart, quarantineEnd);
    expect(quarantineBody).toContain('[[ "$container" == "$expected_container" ]]');
    expect(quarantineBody).toContain('[[ "$running" == false ]]');
    expect(quarantineBody).toContain("network_alias_has_exact_owner");
    expect(quarantineBody).toContain(
      "docker network disconnect --force business_finlynq_development_edge",
    );
    expect(quarantineBody).toContain("network_alias_has_no_owner");

    const recoveryStart = deployDevelopment.indexOf("restore_accepted_revision() {");
    const removeRouter = deployDevelopment.indexOf(
      'remove_failed_router_for_legacy_recovery "$failed_revision" "$recovery_revision"',
      recoveryStart,
    );
    const restoreAlias = deployDevelopment.indexOf(
      'restore_legacy_development_app_alias "$recovery_revision" "$failed_revision"',
      removeRouter,
    );
    const startApp = deployDevelopment.indexOf(
      'start_revision_runtime "$recovery_revision"',
      restoreAlias,
    );
    expect(removeRouter).toBeGreaterThan(recoveryStart);
    expect(restoreAlias).toBeGreaterThan(removeRouter);
    expect(startApp).toBeGreaterThan(restoreAlias);

    const restoreFunctionStart = deployDevelopment.indexOf(
      "restore_legacy_development_app_alias() {",
    );
    const restoreFunctionEnd = deployDevelopment.indexOf(
      "\nrelease_is_accepted() {",
      restoreFunctionStart,
    );
    const restoreBody = deployDevelopment.slice(restoreFunctionStart, restoreFunctionEnd);
    expect(restoreBody).toContain('[[ "$running" == false ]]');
    expect(restoreBody).toContain("network_alias_has_no_owner");
    expect(restoreBody).toContain(
      "docker network connect --alias development-app",
    );
    expect(restoreBody).toContain("network_alias_has_exact_owner");
    expect(restoreBody).toContain(
      'exact_development_app_container "$failed_revision"',
    );
    expect(restoreBody).toContain(
      'docker rm --force -- "$candidate_container"',
    );
    expect(deployDevelopment).toContain(
      '.Config.Labels["org.opencontainers.image.revision"] == $revision',
    );
  });

  it("bootstraps the first stable router only for an empty fresh development runtime", () => {
    const resourceGuardStart = deployDevelopment.indexOf(
      "assert_fresh_development_resources() {",
    );
    const resourceGuardEnd = deployDevelopment.indexOf(
      "\nrelease_router_runtime_is_accepted() {",
      resourceGuardStart,
    );
    const resourceGuard = deployDevelopment.slice(resourceGuardStart, resourceGuardEnd);
    expect(resourceGuardStart).toBeGreaterThan(0);
    expect(resourceGuardEnd).toBeGreaterThan(resourceGuardStart);
    expect(resourceGuard).toContain("docker volume ls --format '{{.Name}}'");
    expect(resourceGuard).toContain("business_finlynq_development_pgdata");
    expect(resourceGuard).toContain("business_finlynq_development_pgdata_clamav");
    expect(resourceGuard).not.toContain("business_finlynq_development_caddy_data");
    expect(resourceGuard).not.toContain("business_finlynq_development_caddy_config");
    expect(resourceGuard).toContain('docker volume inspect "$release_router_state_volume"');
    expect(resourceGuard).toContain(
      '.[0].Labels["com.docker.compose.volume"] == "business_finlynq_release_router_state"',
    );
    expect(resourceGuard).toContain("docker network ls --format '{{.Name}}'");
    for (const network of [
      "business_finlynq_development_private",
      "business_finlynq_development_private_evidence",
      "business_finlynq_development_egress",
      "business_finlynq_development_egress_scanner",
      "business_finlynq_development_private-frontend",
      "business_finlynq_development_private-router-control",
      "business_finlynq_development_restore_drill",
    ]) {
      expect(resourceGuard).toContain(network);
    }
    expect(resourceGuard).toContain(
      "docker network inspect business_finlynq_development_edge",
    );
    expect(resourceGuard).not.toContain("com.business-finlynq.edge-owner");
    expect(resourceGuard).toContain('.[0].Internal == true');

    const initialization = deployDevelopment.slice(
      deployDevelopment.indexOf('accepted_revision=""'),
      deployDevelopment.indexOf(
        'elif [[ "$source_revision" != "$accepted_revision" ]]; then',
      ),
    );
    expect(deployDevelopment).toContain('initial_development_bootstrap="false"');
    expect(initialization).toContain("docker ps --all --no-trunc --quiet");
    expect(initialization).toContain(
      '--filter label=com.docker.compose.service=release_router',
    );
    expect(initialization).toContain('${#existing_project_containers[@]} != 0');
    expect(initialization).toContain('${#existing_app_containers[@]} != 0');
    expect(initialization).toContain('${#existing_router_containers[@]} != 0');
    const resourceProof = initialization.indexOf("assert_fresh_development_resources");
    const bootstrapAuthorization = initialization.indexOf(
      'initial_development_bootstrap="true"',
    );
    expect(resourceProof).toBeGreaterThan(0);
    expect(bootstrapAuthorization).toBeGreaterThan(resourceProof);
    expect(initialization).toContain('initial_development_bootstrap="true"');

    const build = deployDevelopment.indexOf(
      '[[ "$source_topology" == legacy || "$initial_development_bootstrap" == true ]]',
    );
    const fresh = deployDevelopment.indexOf(
      'elif [[ "$initial_development_bootstrap" == true ]]; then',
      build,
    );
    const durableMaintenance = deployDevelopment.indexOf(
      "persist_release_router_named_volume_mode maintenance",
      fresh,
    );
    const createRouter = deployDevelopment.indexOf(
      "compose up --detach --wait --no-deps --no-build release_router",
      durableMaintenance,
    );
    const captureRouter = deployDevelopment.indexOf(
      'persistent_release_router_id="$(running_release_router_container)"',
      createRouter,
    );
    const maintenanceProof = deployDevelopment.indexOf(
      'release_router_runtime_is_accepted \\',
      captureRouter,
    );
    const databaseMutation = deployDevelopment.indexOf(
      "deployment_stage=database-mutation-chain",
      maintenanceProof,
    );
    expect(build).toBeGreaterThan(0);
    expect(fresh).toBeGreaterThan(build);
    expect(durableMaintenance).toBeGreaterThan(fresh);
    expect(createRouter).toBeGreaterThan(durableMaintenance);
    expect(captureRouter).toBeGreaterThan(createRouter);
    expect(maintenanceProof).toBeGreaterThan(captureRouter);
    expect(databaseMutation).toBeGreaterThan(maintenanceProof);
    expect(deployDevelopment).toContain(
      '[[ "$source_topology" == router && "$initial_development_bootstrap" != true ]]',
    );
  });

  it("executes and attests the complete candidate database chain before starting the app", () => {
    const functionStart = deployDevelopment.indexOf("run_candidate_database_chain() {");
    const functionEnd = deployDevelopment.indexOf("\nrepository_root=", functionStart);
    expect(functionStart).toBeGreaterThan(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const chain = deployDevelopment.slice(functionStart, functionEnd);
    for (const service of [
      "provision_auth_worker_role",
      "migrate",
      "reconcile_runtime_grants",
      "reconcile_auth_worker_grants",
      "reconcile_backup_grants",
      "verify_database_contract",
      "bootstrap_demo",
    ]) {
      expect(chain).toContain(service);
    }
    expect(chain).toContain('compose rm --force --stop "${mutation_services[@]}"');
    expect(chain).toContain("compose up --detach --no-build bootstrap_demo");
    expect(chain).toContain('.State.Status == "exited" and .[0].State.ExitCode == 0');
    expect(chain).toContain(
      'Config.Labels["org.opencontainers.image.revision"] == $revision',
    );

    const chainStage = deployDevelopment.indexOf("deployment_stage=database-mutation-chain");
    const chainRun = deployDevelopment.indexOf(
      'run_candidate_database_chain "$candidate_revision"',
      chainStage,
    );
    const liveApply = deployDevelopment.indexOf("deployment_stage=live-apply", chainRun);
    const appStart = deployDevelopment.indexOf(
      "compose up --detach --wait --no-deps --no-build app",
      liveApply,
    );
    expect(chainStage).toBeGreaterThan(0);
    expect(chainRun).toBeGreaterThan(chainStage);
    expect(liveApply).toBeGreaterThan(chainRun);
    expect(appStart).toBeGreaterThan(liveApply);
  });

  it("commits development active mode only after external and final acceptance", () => {
    const candidateProof = deployDevelopment.indexOf("deployment_stage=candidate-verification");
    const liveActivation = deployDevelopment.indexOf(
      "reload_release_router_live active",
      candidateProof,
    );
    const externalProof = deployDevelopment.indexOf(
      'verify_external_edge_if_selected "$candidate_revision" live-uncommitted',
      liveActivation,
    );
    const finalProof = deployDevelopment.indexOf("deployment_stage=final-verification", externalProof);
    const acceptedRecord = deployDevelopment.indexOf(
      'commit_release_router_acceptance "$candidate_revision" "$accepted_revision"',
      finalProof,
    );
    expect(candidateProof).toBeGreaterThan(0);
    expect(liveActivation).toBeGreaterThan(candidateProof);
    expect(externalProof).toBeGreaterThan(liveActivation);
    expect(finalProof).toBeGreaterThan(externalProof);
    expect(acceptedRecord).toBeGreaterThan(finalProof);

    const commitStart = deployDevelopment.indexOf("commit_release_router_acceptance() {");
    const commitEnd = deployDevelopment.indexOf("\nwrite_failure_state() {", commitStart);
    const commit = deployDevelopment.slice(commitStart, commitEnd);
    const publish = commit.indexOf('write_accepted_revision "$revision"');
    const durableCommit = commit.indexOf("persist_release_router_mode active", publish);
    const containment = commit.indexOf("contain_development_router_on_failure", durableCommit);
    const pointerRestore = commit.indexOf(
      'restore_accepted_revision_pointer "$prior_accepted_revision"',
      containment,
    );
    expect(commitStart).toBeGreaterThan(0);
    expect(commitEnd).toBeGreaterThan(commitStart);
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(durableCommit).toBeGreaterThan(publish);
    expect(containment).toBeGreaterThan(durableCommit);
    expect(pointerRestore).toBeGreaterThan(containment);
    expect(deployDevelopment).toContain("sync -f /state 2>/dev/null || sync");
  });

  it("re-proves live-active routing before interrupted or same-revision finalization", () => {
    const interruptedStart = deployDevelopment.indexOf(
      'elif [[ "$source_revision" != "$accepted_revision" ]]; then',
    );
    const interruptedEnd = deployDevelopment.indexOf(
      '\n# Recovery must establish a healthy accepted source first.',
      interruptedStart,
    );
    const interrupted = deployDevelopment.slice(interruptedStart, interruptedEnd);
    const interruptedPrivateProof = interrupted.indexOf(
      'release_is_accepted "$source_revision" private',
    );
    const interruptedReload = interrupted.indexOf("reload_release_router_live active");
    const interruptedProof = interrupted.indexOf(
      'release_is_accepted "$source_revision"',
      interruptedReload,
    );
    const interruptedExternal = interrupted.indexOf(
      'verify_external_edge_if_selected "$source_revision" live-uncommitted',
      interruptedProof,
    );
    const interruptedCommit = interrupted.indexOf(
      'commit_release_router_acceptance "$source_revision" "$accepted_revision"',
      interruptedExternal,
    );
    expect(interruptedPrivateProof).toBeGreaterThanOrEqual(0);
    expect(interruptedReload).toBeGreaterThan(interruptedPrivateProof);
    expect(interruptedProof).toBeGreaterThan(interruptedReload);
    expect(interruptedExternal).toBeGreaterThan(interruptedProof);
    expect(interruptedCommit).toBeGreaterThan(interruptedExternal);

    const sameRevisionStart = deployDevelopment.indexOf(
      'if [[ "$source_revision" == "$candidate_revision" ]]; then',
      interruptedEnd,
    );
    const sameRevisionEnd = deployDevelopment.indexOf("\nmutated=false", sameRevisionStart);
    const sameRevision = deployDevelopment.slice(sameRevisionStart, sameRevisionEnd);
    const samePrivateProof = sameRevision.indexOf(
      'release_is_accepted "$candidate_revision" private',
    );
    const sameReload = sameRevision.indexOf("reload_release_router_live active");
    const samePublic = sameRevision.indexOf("run_public_acceptance", sameReload);
    const sameProof = sameRevision.indexOf(
      'release_is_accepted "$candidate_revision"',
      samePublic,
    );
    const sameCommit = sameRevision.indexOf(
      'commit_release_router_acceptance "$candidate_revision" "$accepted_revision"',
      sameProof,
    );
    expect(samePrivateProof).toBeGreaterThanOrEqual(0);
    expect(sameReload).toBeGreaterThan(samePrivateProof);
    expect(samePublic).toBeGreaterThan(sameReload);
    expect(sameProof).toBeGreaterThan(samePublic);
    expect(sameCommit).toBeGreaterThan(sameProof);
  });

  it("preflights router-aware upgrades but defers the first router verifier until bootstrap", () => {
    const acceptedRecovery = deployDevelopment.indexOf(
      'elif [[ "$source_revision" != "$accepted_revision" ]]; then',
    );
    const preflight = deployDevelopment.indexOf(
      'if [[ "$source_revision" != "$candidate_revision" ]]; then\n' +
        '  require_public_acceptance="$(read_environment_value DEVELOPMENT_REQUIRE_PUBLIC_ACCEPTANCE)"',
    );
    const quarantine = deployDevelopment.indexOf(
      'if [[ -e "$quarantine_file" || -L "$quarantine_file" ]]; then',
    );
    const mutation = deployDevelopment.indexOf("mutated=true");
    const preflightBlock = deployDevelopment.slice(preflight, quarantine);

    expect(acceptedRecovery).toBeGreaterThan(0);
    expect(preflight).toBeGreaterThan(acceptedRecovery);
    expect(preflight).toBeGreaterThan(0);
    expect(quarantine).toBeGreaterThan(preflight);
    expect(mutation).toBeGreaterThan(quarantine);
    expect(preflightBlock).toContain(
      '[[ "$require_public_acceptance" == true || "$require_public_acceptance" == false ]]',
    );
    expect(preflightBlock).toContain(
      '&& "$(revision_release_topology "$source_revision")" == router',
    );
    expect(preflightBlock).toContain(
      'verify_external_edge_if_selected "$candidate_revision"',
    );
    expect(preflightBlock).toContain(
      "Deferring candidate external-edge verification until the first release router is live.",
    );
    const liveApply = deployDevelopment.indexOf("deployment_stage=live-apply", mutation);
    const postBootstrapVerifier = deployDevelopment.indexOf(
      'verify_external_edge_if_selected "$candidate_revision"',
      liveApply,
    );
    expect(postBootstrapVerifier).toBeGreaterThan(liveApply);
  });

  it("automatically restores dev and quarantines only the failed candidate", () => {
    expect(deployDevelopment).toContain(
      'readonly accepted_revision_file="$state_directory/accepted-revision"',
    );
    expect(deployDevelopment).toContain(
      'readonly quarantine_file="$state_directory/quarantined-candidate"',
    );
    expect(deployDevelopment).toContain(
      'readonly hard_failure_latch="$state_directory/deployment-hard-failed"',
    );
    expect(deployDevelopment).toContain(
      'restore_accepted_revision "$candidate_revision" "$accepted_revision"',
    );
    expect(deployDevelopment).toContain(
      'restore_accepted_revision "$legacy_candidate" "$legacy_source"',
    );
    expect(deployDevelopment).toContain(
      'write_failure_state "$quarantine_file" quarantine "$legacy_source" "$legacy_candidate"',
    );
    expect(deployDevelopment).toContain(
      'git_as_deploy reset --hard "$recovery_revision"',
    );
    expect(deployDevelopment).toContain(
      'write_failure_state "$quarantine_file" quarantine "$accepted_revision"',
    );
    expect(deployDevelopment).toContain(
      'release_is_accepted "$recovery_revision"',
    );
    expect(deployDevelopment).toContain(
      'ensure_revision_runtime_images "$recovery_revision"',
    );
    expect(deployDevelopment).toContain(
      'remove_failed_router_for_legacy_recovery "$failed_revision" "$recovery_revision"',
    );
    const recoveryImages = deployDevelopment.indexOf(
      'ensure_revision_runtime_images "$recovery_revision"',
    );
    const legacyRouterRemoval = deployDevelopment.indexOf(
      'remove_failed_router_for_legacy_recovery "$failed_revision" "$recovery_revision"',
      recoveryImages,
    );
    const recoveryStart = deployDevelopment.indexOf(
      'start_revision_runtime "$recovery_revision"',
      legacyRouterRemoval,
    );
    expect(recoveryImages).toBeGreaterThan(0);
    expect(legacyRouterRemoval).toBeGreaterThan(recoveryImages);
    expect(recoveryStart).toBeGreaterThan(legacyRouterRemoval);
    const recoveryFunctionStart = deployDevelopment.indexOf("restore_accepted_revision() {");
    const recoveryMaintenance = deployDevelopment.indexOf(
      "reload_release_router maintenance",
      recoveryFunctionStart,
    );
    const recoveryReset = deployDevelopment.indexOf(
      'git_as_deploy reset --hard "$recovery_revision"',
      recoveryFunctionStart,
    );
    const recoveryActive = deployDevelopment.indexOf(
      "reload_release_router_live active",
      recoveryStart,
    );
    const recoveryPrivateProof = deployDevelopment.indexOf(
      'release_is_accepted "$recovery_revision" private',
      recoveryStart,
    );
    const recoveryProof = deployDevelopment.indexOf(
      'release_is_accepted "$recovery_revision"',
      recoveryActive,
    );
    const recoveryDurableActive = deployDevelopment.indexOf(
      "persist_release_router_mode active",
      recoveryProof,
    );
    expect(recoveryMaintenance).toBeGreaterThan(recoveryFunctionStart);
    expect(recoveryReset).toBeGreaterThan(recoveryMaintenance);
    expect(recoveryPrivateProof).toBeGreaterThan(recoveryStart);
    expect(recoveryActive).toBeGreaterThan(recoveryPrivateProof);
    expect(recoveryActive).toBeGreaterThan(recoveryStart);
    expect(recoveryProof).toBeGreaterThan(recoveryActive);
    expect(recoveryDurableActive).toBeGreaterThan(recoveryProof);
    expect(deployDevelopment).toContain(
      '[[ "$(revision_release_topology "$failed_revision")" == router ]]',
    );
    expect(deployDevelopment).toContain("release_router_runtime_is_accepted || return 1");
    expect(deployDevelopment).toContain('services=(database app)');
    expect(deployDevelopment).not.toContain("business-finlynq-release-router:$revision");
    expect(deployDevelopment).toContain('compose build "${services[@]}"');
    expect(deployDevelopment).toContain(
      "a newer CI-approved revision is required",
    );
    expect(deployDevelopment).toContain(
      'write_failure_state "$hard_failure_latch" hard',
    );
  });

  it("contains any development live route that exits before durable acceptance", () => {
    const trapInstall = deployDevelopment.indexOf(
      "trap contain_uncommitted_development_router_on_exit EXIT",
    );
    const firstRecoveryBranch = deployDevelopment.indexOf(
      'if [[ -e "$legacy_failure_latch" || -L "$legacy_failure_latch" ]]; then',
    );
    const interruptTrap = deployDevelopment.indexOf("trap 'exit 130' INT", trapInstall);
    const terminateTrap = deployDevelopment.indexOf("trap 'exit 143' TERM", interruptTrap);
    expect(trapInstall).toBeGreaterThan(0);
    expect(interruptTrap).toBeGreaterThan(trapInstall);
    expect(terminateTrap).toBeGreaterThan(interruptTrap);
    expect(terminateTrap).toBeLessThan(firstRecoveryBranch);
    expect(deployDevelopment).toContain(
      '[[ "$status" != 0 && "$development_router_live_uncommitted" == true ]]',
    );
    expect(deployDevelopment).toContain("contain_development_router_on_failure");
    expect(deployDevelopment).toContain("trap 'exit 130' INT");
    expect(deployDevelopment).toContain("trap 'exit 143' TERM");
    expect(deployDevelopment).not.toContain(
      "trap contain_uncommitted_development_router_on_exit EXIT INT TERM",
    );
    expect(deployDevelopment).not.toContain("trap cleanup EXIT INT TERM");
    expect(deployDevelopment.indexOf("trap cleanup EXIT", firstRecoveryBranch))
      .toBeGreaterThan(firstRecoveryBranch);

    for (const failureMessage of [
      "interrupted development finalization could not restore active live routing",
      "same-revision development finalization could not restore active live routing",
      "development release router could not expose the verified candidate",
    ]) {
      const failure = deployDevelopment.indexOf(failureMessage);
      expect(failure).toBeGreaterThan(0);
      const activation = deployDevelopment.lastIndexOf(
        "reload_release_router_live active",
        failure,
      );
      expect(activation).toBeGreaterThan(0);
      expect(
        deployDevelopment.lastIndexOf(
          'development_router_live_uncommitted="true"',
          activation,
        ),
      ).toBeGreaterThan(0);
    }
  });

  it("removes only exact failed-dev artifacts and never the persistent volume", () => {
    expect(deployDevelopment).toContain(
      '--filter label=com.docker.compose.project="$project"',
    );
    expect(deployDevelopment).toContain('docker rm --force -- "${container_ids[@]}"');
    expect(deployDevelopment).toContain('docker image rm -- "$reference"');
    expect(deployDevelopment).toContain(
      '--filter "label=org.opencontainers.image.revision=$revision"',
    );
    expect(deployDevelopment).toContain(
      'docker builder prune --force --max-used-space "$build_cache_limit"',
    );
    expect(deployDevelopment).toContain(
      'revision_is_used_outside_project "$revision"',
    );
    expect(deployDevelopment).not.toContain("docker volume rm");
    expect(deployDevelopment).not.toContain("down --volumes");
    expect(deployDevelopment).not.toContain("docker system prune");
  });

  it("updates recovery trust before mutation and latches any failed release", () => {
    const receiverIndex = deployMain.indexOf('"allow $backup_source_revision $candidate_revision"');
    const mutationIndex = deployMain.indexOf('mutated="true"');
    expect(receiverIndex).toBeGreaterThan(0);
    expect(mutationIndex).toBeGreaterThan(receiverIndex);
    expect(deployMain).toContain("docker ps --all --no-trunc --quiet");
    expect(deployMain).toContain(
      'git_as_deploy merge-base --is-ancestor "$backup_source_revision" "$candidate_revision"',
    );
    expect(deployMain).toContain(
      'readonly failure_latch="/var/lib/business-finlynq/continuous-deployment-failed"',
    );
    expect(deployMain).toContain("CONTINUOUS_DEPLOYMENT_FAILURE_ACK");
  });

  it("lets the receiver move trust only from an already trusted source", () => {
    expect(allowRevisions).toContain(
      'grep -Fxq "$source_revision" "$allowed_revisions"',
    );
    expect(allowRevisions).toContain(
      "printf '%s\\n%s\\n' \"$source_revision\" \"$candidate_revision\" | sort -u",
    );
    expect(receiverInstaller).toContain('from="%s",restrict,command="%s"');
    expect(receiverInstaller).toContain("NOPASSWD:");
    expect(receiverInstaller).toContain("PermitTTY no");
    expect(receiverInstaller).toContain("DisableForwarding yes");
  });
});
