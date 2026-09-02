import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

const workflow = read(".github", "workflows", "signal-production-deployment.yml");
const deployMain = read("deploy", "continuous-deployment", "deploy-main.sh");
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
