import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

const workflow = read(".github", "workflows", "signal-production-deployment.yml");
const qualityGateWorkflow = read(".github", "workflows", "ci.yml");
const deployMain = read("deploy", "continuous-deployment", "deploy-main.sh");
const reconcileSharedEdge = read("deploy", "edge", "reconcile-shared-edge.sh");
const deployDevelopment = read("deploy", "development", "deploy-development.sh");
const installDevelopment = read("deploy", "development", "install-development.sh");
const compose = read("docker-compose.yml");
const caddy = read("deploy", "Caddyfile.container");
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
  it("signals only a successful same-repository main quality gate", () => {
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("- quality-gate");
    expect(workflow).toContain("workflow_run.conclusion == 'success'");
    expect(workflow).toContain("workflow_run.event == 'push'");
    expect(workflow).toContain("workflow_run.head_branch == 'main'");
    expect(workflow).toContain(
      "workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain('tag="deploy-production-$CANDIDATE_REVISION"');
  });

  it("deploys only the signalled fast-forward origin/main commit", () => {
    expect(deployMain).toContain(
      'candidate_revision="$(git_as_deploy rev-parse refs/remotes/origin/main)"',
    );
    expect(deployMain).toContain(
      'git_as_deploy merge-base --is-ancestor "$source_revision" "$candidate_revision"',
    );
    expect(deployMain).toContain('signal_tag="deploy-production-$candidate_revision"');
    expect(deployMain).toContain('git_as_deploy merge --ff-only "$candidate_revision"');
    expect(deployMain).toContain('bash "$repository/deploy/release/run-release.sh"');
    expect(deployMain).toContain("--scheduler systemd");
    const releaseAccepted = deployMain.lastIndexOf(
      'release_is_accepted || fail "the release runner returned without an accepted live revision"',
    );
    const edgeReconciled = deployMain.lastIndexOf(
      'bash "$repository/deploy/edge/reconcile-shared-edge.sh"',
    );
    expect(edgeReconciled).toBeGreaterThan(releaseAccepted);
    expect(deployMain.indexOf('mutated="false"', edgeReconciled)).toBeGreaterThan(edgeReconciled);
  });

  it("signals dev only after its complete quality gate succeeds", () => {
    expect(qualityGateWorkflow).toContain("signal-development:");
    expect(qualityGateWorkflow).toContain("github.ref == 'refs/heads/dev'");
    expect(qualityGateWorkflow).toContain("needs: verify");
    expect(qualityGateWorkflow).toContain('tag="deploy-development-$CANDIDATE_REVISION"');
    expect(qualityGateWorkflow).toContain("'+refs/heads/dev:refs/remotes/origin/dev'");
  });

  it("deploys dev through a disjoint checkout, state tree, port, and resource namespace", () => {
    expect(deployDevelopment).toContain(
      'readonly repository="/home/deploy/business-finlynq-development"',
    );
    expect(deployDevelopment).toContain(
      'readonly compose_environment="/etc/business-finlynq-development/compose.env"',
    );
    expect(deployDevelopment).toContain(
      'readonly state_directory="/var/lib/business-finlynq-development"',
    );
    expect(deployDevelopment).toContain(
      'candidate_revision="$(git_as_deploy rev-parse refs/remotes/origin/dev)"',
    );
    expect(deployDevelopment).toContain('signal_tag="deploy-development-$candidate_revision"');
    expect(deployDevelopment).toContain("http://127.0.0.1:3200/api/health");
    expect(deployDevelopment).not.toContain("/etc/business-finlynq/compose.env");
    expect(deployDevelopment).not.toContain("refs/remotes/origin/main");
    for (const resource of [
      "pgdata",
      "caddy_data",
      "caddy_config",
      "private",
      "egress",
      "edge",
      "restore_drill",
    ]) {
      expect(installDevelopment).toContain(`business_finlynq_development_${resource}`);
    }
  });

  it("serializes production and development deployments and keeps the public routes separate", () => {
    const sharedLock = 'readonly host_deployment_lock="/var/lib/business-finlynq/deployment-host.lock"';
    expect(deployMain).toContain(sharedLock);
    expect(deployDevelopment).toContain(sharedLock);
    expect(compose).toContain("BUSINESS_FINLYNQ_APP_NETWORK_ALIAS:-production-app");
    expect(compose).toContain("business_finlynq_development_edge:");
    expect(caddy).toContain("BUSINESS_FINLYNQ_DEVELOPMENT_HOSTNAME:dev.business.finlynq.com");
    expect(caddy).toContain("reverse_proxy development-app:3000");
    expect(reconcileSharedEdge).toContain(sharedLock);
  });

  it("reconciles only the shared edge after validating every attached deployment", () => {
    expect(reconcileSharedEdge).toContain('[[ "$(id -u)" == 0 ]]');
    expect(reconcileSharedEdge).toContain('stat -c \'%U:%G:%a\' -- "$external_basic_auth"');
    expect(reconcileSharedEdge).toContain('== "root:root:400"');
    expect(reconcileSharedEdge).toContain("/config/epm-basic-auth");
    expect(reconcileSharedEdge).toContain("--project-name business-finlynq");
    for (const network of [
      "business_finlynq_edge",
      "business_finlynq_development_edge",
      "epm_finlynq_edge",
      "consult_finlynq_edge",
    ]) {
      expect(reconcileSharedEdge).toContain(network);
    }
    for (const backend of [
      "production-app:3000/api/health",
      "development-app:3000/api/health",
      "epm-finlynq-api:7100/health",
      "epm-finlynq-console:7090/api/health",
      "consult-finlynq-app:8080/",
    ]) {
      expect(reconcileSharedEdge).toContain(backend);
    }
    expect(reconcileSharedEdge).toContain("caddy validate --config /etc/caddy/Caddyfile");
    expect(reconcileSharedEdge).toContain("up --detach --no-deps --no-build");
    expect(reconcileSharedEdge).toContain("--wait --wait-timeout 120 edge");
    expect(reconcileSharedEdge).not.toMatch(/^[ \t]*(?!#)[^\n]*--force-recreate/mu);
    expect(reconcileSharedEdge).not.toMatch(/^[ \t]*(?!#)[^\n]*\bdown\b/mu);
    expect(reconcileSharedEdge).toContain("https://business.finlynq.com/api/health");
    expect(reconcileSharedEdge).toContain("https://dev.business.finlynq.com/api/health");
    expect(reconcileSharedEdge).toContain("https://epm.finlynq.com/");
    expect(reconcileSharedEdge).toContain('[[ "$epm_status" == "401" ]]');
    expect(reconcileSharedEdge).toContain("https://consult.finlynq.com/");
  });

  it("starts development with external identity integrations disabled", () => {
    expect(installDevelopment).toContain("ACCOUNT_LOGIN_ENABLED=false");
    expect(installDevelopment).toContain("ACCOUNT_SIGNUP_ENABLED=false");
    expect(installDevelopment).toContain("AUTH_EMAIL_DELIVERY_ENABLED=false");
    expect(installDevelopment).toContain("SIGNUP_TURNSTILE_ENABLED=false");
    expect(installDevelopment).toContain("BUSINESS_WRITES_ENABLED=true");
    expect(installDevelopment).toContain("BANK_FEEDS_ENABLED=false");
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
