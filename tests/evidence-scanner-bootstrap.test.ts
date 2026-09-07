import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("disposable CI evidence scanner bootstrap", () => {
  const bootstrap = readFileSync("deploy/evidence/start-test-scanner.sh", "utf8");
  const freshclam = readFileSync("deploy/evidence/freshclam-ci.conf", "utf8");
  const compose = readFileSync("docker-compose.yml", "utf8").replaceAll("\r\n", "\n");
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

  it("uses the production scanner image and exact ClamD policy", () => {
    const scannerStart = compose.indexOf("  evidence_scanner:\n");
    const scannerEnd = compose.indexOf("\n  app:\n", scannerStart);
    const scannerService = compose.slice(scannerStart, scannerEnd);
    const productionImage = scannerService.match(/^    image: (\S+)$/m)?.[1];
    const embeddedConfig = scannerService.match(
      /^      CLAMD_CONFIG: \|\n([\s\S]*?)^    volumes:$/m,
    )?.[1]
      .split("\n")
      .map((line) => line.replace(/^        /, ""))
      .join("\n");
    const checkedInConfig = readFileSync("deploy/evidence/clamd.conf", "utf8").trimEnd();

    expect(productionImage).toMatch(/^clamav\/clamav@sha256:[a-f0-9]{64}$/);
    expect(bootstrap).toContain('scanner_image="' + productionImage + '"');
    expect(
      bootstrap.match(/clamav\/clamav(?:[^@"\s]*)?@sha256:[a-f0-9]{64}/g),
    ).toEqual([productionImage]);
    expect(embeddedConfig?.trimEnd()).toBe(checkedInConfig);
    expect(checkedInConfig).toContain("FailIfCvdOlderThan 7");
  });

  it("finishes a bounded signature refresh before starting ClamD", () => {
    const trap = bootstrap.indexOf("trap cleanup_failed_bootstrap EXIT");
    const create = bootstrap.indexOf('docker volume create "$signature_volume"');
    const refresh = bootstrap.indexOf("timeout --signal=TERM --kill-after=30s 10m");
    const daemon = bootstrap.indexOf('docker run --detach --name "$scanner_container"');
    const health = bootstrap.indexOf('until docker exec "$scanner_container" clamdcheck.sh');
    const updater = bootstrap.slice(refresh, daemon);
    const scanner = bootstrap.slice(daemon, health);

    expect(trap).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(trap);
    expect(refresh).toBeGreaterThan(create);
    expect(daemon).toBeGreaterThan(refresh);
    expect(health).toBeGreaterThan(daemon);

    expect(updater).toContain('--name "$updater_container"');
    expect(updater).toContain("--user 100:101");
    expect(updater).toContain("--entrypoint freshclam");
    expect(updater).toContain("--read-only");
    expect(updater).toContain("--cap-drop ALL");
    expect(updater).toContain("--security-opt no-new-privileges");
    expect(updater).toContain(
      '--mount "type=volume,source=$signature_volume,target=/var/lib/clamav"',
    );
    expect(updater).toContain(
      '--mount "type=bind,source=$script_directory/freshclam-ci.conf,target=/etc/clamav/freshclam-finlynq.conf,readonly"',
    );
    expect(updater).toContain("--foreground --stdout --user=clamav");
    expect(updater).toContain("--config-file=/etc/clamav/freshclam-finlynq.conf");
    expect(updater).not.toContain("--daemon");
    expect(updater).not.toMatch(/(?:^|\s)(?:-p|--publish)(?:\s|=)/m);

    expect(scanner).toContain("--user 100:101");
    expect(scanner).toContain("--read-only");
    expect(scanner).toContain("--env CLAMAV_NO_FRESHCLAMD=true");
    expect(scanner).toContain("--cap-drop ALL");
    expect(scanner).toContain("--security-opt no-new-privileges");
    expect(scanner).toContain(
      '--mount "type=volume,source=$signature_volume,target=/var/lib/clamav,readonly"',
    );
    expect(scanner).toContain(
      '--mount "type=bind,source=$script_directory/clamd.conf,target=/etc/clamav/clamd.conf,readonly"',
    );
    expect(scanner).toContain("-p 127.0.0.1:53310:3310");
  });

  it("uses a credential-free one-shot FreshClam policy", () => {
    expect(freshclam).toContain("DatabaseDirectory /var/lib/clamav");
    expect(freshclam).toContain("DatabaseOwner clamav");
    expect(freshclam).toContain("DatabaseMirror database.clamav.net");
    expect(freshclam).toContain("TestDatabases yes");
    expect(freshclam).toContain("Bytecode yes");
    expect(freshclam).not.toMatch(
      /HTTPProxy|DatabaseCustomURL|PrivateMirror|NotifyClamd|UpdateLogFile/,
    );
  });

  it("cleans up only owned bootstrap resources and always tears down CI resources", () => {
    const collisionGuard = bootstrap.indexOf('docker container inspect "$updater_container"');
    const ownership = bootstrap.indexOf("resources_owned=true");
    const cleanupGuard = bootstrap.indexOf(
      'if [ "$resources_owned" = true ] && [ "$bootstrap_complete" != true ]',
    );
    const cleanupContainers = bootstrap.indexOf(
      'docker rm --force "$updater_container" "$scanner_container"',
    );
    const cleanupVolume = bootstrap.indexOf('docker volume rm "$signature_volume"');
    const success = bootstrap.indexOf("bootstrap_complete=true");
    const audit = workflow.indexOf("- run: npm audit --omit=dev --audit-level=high");
    const workflowCleanup = workflow.indexOf("- name: Remove disposable evidence scanner");

    expect(collisionGuard).toBeGreaterThan(cleanupGuard);
    expect(ownership).toBeGreaterThan(collisionGuard);
    expect(cleanupContainers).toBeGreaterThan(cleanupGuard);
    expect(cleanupVolume).toBeGreaterThan(cleanupContainers);
    expect(success).toBeGreaterThan(cleanupVolume);
    expect(bootstrap).not.toMatch(/docker (?:system|volume|container) prune/);

    expect(workflowCleanup).toBeGreaterThan(audit);
    expect(workflow.slice(workflowCleanup)).toContain("if: always()");
    expect(workflow.slice(workflowCleanup)).toContain(
      "docker rm --force \\\n            finlynq-ci-evidence-scanner-update \\\n            finlynq-ci-evidence-scanner",
    );
    expect(workflow.slice(workflowCleanup)).toContain(
      "docker volume rm finlynq-ci-evidence-scanner-signatures",
    );
    expect(workflow.slice(workflowCleanup)).toContain(
      "! docker volume inspect finlynq-ci-evidence-scanner-signatures",
    );
  });
});
