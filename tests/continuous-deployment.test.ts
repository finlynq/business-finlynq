import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

const workflow = read(".github", "workflows", "signal-production-deployment.yml");
const qualityGateWorkflow = read(".github", "workflows", "ci.yml");
const deployMain = read("deploy", "continuous-deployment", "deploy-main.sh");
const deployDevelopment = read("deploy", "development", "deploy-development.sh");
const installDevelopment = read("deploy", "development", "install-development.sh");
const playwrightConfig = read("playwright.config.ts");
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
    expect(caddy).toContain("reverse_proxy production-app:3000");
    expect(caddy).toContain("BUSINESS_FINLYNQ_DEVELOPMENT_HOSTNAME:dev.business.finlynq.com");
    expect(caddy).toContain("reverse_proxy development-app:3000");
    expect(caddy).not.toContain("reverse_proxy app:3000");
  });

  it("starts development with external identity integrations disabled", () => {
    expect(installDevelopment).toContain("ACCOUNT_LOGIN_ENABLED=false");
    expect(installDevelopment).toContain("ACCOUNT_SIGNUP_ENABLED=false");
    expect(installDevelopment).toContain("AUTH_EMAIL_DELIVERY_ENABLED=false");
    expect(installDevelopment).toContain("SIGNUP_TURNSTILE_ENABLED=false");
    expect(installDevelopment).toContain("BUSINESS_WRITES_ENABLED=true");
    expect(installDevelopment).toContain("BANK_FEEDS_ENABLED=false");
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
      "a newer CI-approved revision is required",
    );
    expect(deployDevelopment).toContain(
      'write_failure_state "$hard_failure_latch" hard',
    );
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
