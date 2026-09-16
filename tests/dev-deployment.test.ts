import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const deployer = read("deploy/dev/deploy-dev.sh");
const installer = read("deploy/dev/install-dev.sh");
const verifier = read("deploy/dev/verify-dev-finalized.sh");
const service = read("deploy/dev/business-finlynq-dev-deployment.service");
const timer = read("deploy/dev/business-finlynq-dev-deployment.timer");
const composeOverride = read("deploy/dev/docker-compose.dev.yml");
const edgeVerifier = read("deploy/edge/verify-external-edge.sh");
const workflow = read(".github/workflows/ci.yml");

describe("isolated hosted-development deployment", () => {
  it("uses an exact namespace disjoint from staging and production", () => {
    for (const exact of [
      'readonly repository="/home/deploy/business-finlynq-dev"',
      'readonly compose_environment="/etc/business-finlynq-dev/compose.env"',
      'readonly project="business-finlynq-dev"',
      'readonly state_directory="/var/lib/business-finlynq-dev"',
      'readonly installed_deployer="/usr/local/sbin/business-finlynq-deploy-dev"',
      'readonly release_router_state_volume="business_finlynq_dev_private-release-router-state-v2"',
      'candidate_revision="$(git_as_deploy rev-parse refs/remotes/origin/dev)"',
      'signal_tag="deploy-development-$candidate_revision"',
      "http://127.0.0.1:3201/api/health",
    ]) {
      expect(deployer).toContain(exact);
    }

    expect(deployer).not.toContain("/etc/business-finlynq-development/compose.env");
    expect(deployer).not.toContain("/var/lib/business-finlynq-development");
    expect(deployer).not.toContain("refs/remotes/origin/stage");
    expect(deployer).not.toContain("refs/remotes/origin/main");
    expect(installer).toContain("BUSINESS_FINLYNQ_HOSTNAME=dev.business.finlynq.com");
    expect(installer).toContain("BUSINESS_FINLYNQ_APP_PORT=3201");
    expect(installer).toContain("BUSINESS_FINLYNQ_APP_NETWORK_ALIAS=dev-app");
    expect(installer).toContain("BUSINESS_FINLYNQ_EDGE_NETWORK=business_finlynq_dev_edge");
    expect(installer).toContain("SESSION_COOKIE_NAME=__Host-business_finlynq_dev_session");
  });

  it("uses reviewed explicit subnets instead of the exhausted default pools", () => {
    for (const subnet of [
      "10.240.11.0/27",
      "10.240.11.32/28",
      "10.240.11.48/28",
      "10.240.11.64/28",
      "10.240.11.80/28",
      "10.240.11.96/28",
      "10.240.11.112/28",
    ]) {
      expect(installer).toContain(subnet);
    }
    expect(deployer.match(/-f "\$compose_override"/gu)).toHaveLength(3);
    expect(
      new Set(composeOverride.match(/BUSINESS_FINLYNQ_[A-Z_]+_SUBNET/gu)).size,
    ).toBe(7);
    expect(installer).not.toContain("docker network create");
    expect(installer).toContain('.[0].IPAM.Config[0].Subnet == "10.240.10.112/28"');
  });

  it("publishes and consumes only the exact CI-approved dev revision", () => {
    expect(workflow).toContain("signal-development:");
    expect(workflow).toContain("github.ref == 'refs/heads/dev'");
    expect(workflow).toContain("group: development-deployment-signal");
    expect(workflow).toContain("'+refs/heads/dev:refs/remotes/origin/dev'");
    expect(workflow).toContain('tag="deploy-development-$CANDIDATE_REVISION"');
    expect(deployer).toContain(
      'git_as_deploy merge-base --is-ancestor "$source_revision" "$candidate_revision"',
    );
    expect(deployer).toContain(
      '[[ "$signal_revision" == "$candidate_revision" ]]',
    );
    expect(deployer.indexOf('refresh_installed_deployer_if_needed "$candidate_revision"'))
      .toBeLessThan(deployer.indexOf('git_as_deploy merge --ff-only "$candidate_revision"'));
  });

  it("has an independent service and root-owned finalization verifier", () => {
    expect(service).toContain("ConditionPathExists=/etc/business-finlynq-dev/compose.env");
    expect(service).toContain("ExecStart=/usr/local/sbin/business-finlynq-deploy-dev");
    expect(timer).toContain("Unit=business-finlynq-dev-deployment.service");
    expect(installer).toContain(
      'readonly external_edge_verifier_target="$installed_verifier_directory/verify-external-edge-dev.sh"',
    );
    expect(verifier).toContain(
      'readonly external_edge_verifier="/usr/local/libexec/business-finlynq/verify-external-edge-dev.sh"',
    );
    expect(verifier).toContain(
      '"$finalization_verifier" deploy/dev/verify-dev-finalized.sh',
    );
    expect(verifier).toContain("--scope dev");
    expect(verifier).toContain("--warmup-host dev");
    expect(verifier).toContain("FINALIZED revision=%s");
  });

  it("extends shared-edge verification without letting the app mutate the edge", () => {
    for (const exact of [
      'readonly dev_environment="/etc/business-finlynq-dev/compose.env"',
      'readonly dev_project="business-finlynq-dev"',
      'readonly dev_network="business_finlynq_dev_edge"',
      'readonly dev_alias="dev-app"',
      'readonly dev_loopback_port="3201"',
      'readonly dev_hostname="dev.business.finlynq.com"',
      "--allow-dev-router-maintenance",
      "--expect-dev-live-uncommitted",
    ]) {
      expect(edgeVerifier).toContain(exact);
    }
    expect(deployer).toContain('bash "$verifier_path" --scope dev --warmup-host dev');
    expect(edgeVerifier).not.toContain("caddy reload");
    expect(edgeVerifier).not.toContain("docker compose up");
  });

  it("keeps all deployment shell entrypoints syntactically valid", () => {
    for (const path of [
      "deploy/dev/deploy-dev.sh",
      "deploy/dev/install-dev.sh",
      "deploy/dev/verify-dev-finalized.sh",
      "deploy/edge/verify-external-edge.sh",
      "deploy/development/deploy-development.sh",
    ]) {
      const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
  });
});
