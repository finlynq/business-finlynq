import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const release = readFileSync(new URL("../deploy/release/run-release.sh", import.meta.url), "utf8");
const start = release.indexOf("verify_previous_auth_worker_artifact() {");
const end = release.indexOf("\n}\n", start);
if (start < 0 || end < 0) throw new Error("Missing source-worker recovery check");
const verifyArtifact = release.slice(start, end + 3);
const revision = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;

function check(environment: Record<string, string | undefined> = {}) {
  return spawnSync("/bin/bash", ["-c", `
set -Eeuo pipefail
fail() { printf '%s\\n' "$*" >&2; exit 1; }
docker() {
  if [[ "$1 $2" == 'image inspect' ]]; then
    [[ "$ARTIFACT_PRESENT" == true ]] || return 1
    printf '%s\\n' "$INSPECTED_IMAGE"
  elif [[ "$1" == ps ]]; then
    [[ "$*" == *'label=com.docker.compose.project=business-finlynq'* &&
       "$*" == *'label=com.docker.compose.service=auth_email_worker'* ]] || return 2
    [[ "$INVENTORY_ERROR" == false ]] || return 1
    printf '%s' "$WORKER_INVENTORY"
  else
    printf 'Unexpected Docker command: %s\\n' "$*" >&2
    return 2
  fi
}
${verifyArtifact}
verify_previous_auth_worker_artifact
printf 'retained=%s\\n' "$previous_auth_worker_image_retained"
`], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      previous_auth_worker_was_running: "true",
      previous_auth_worker_image_id: imageId,
      previous_auth_worker_revision: revision,
      previous_app_revision: revision,
      previous_auth_worker_image_retained: "true",
      first_router_forward_repair_resume: "true",
      database_mutation_started: "true",
      first_router_recovery_journal_sha256: "c".repeat(64),
      ARTIFACT_PRESENT: "false",
      INSPECTED_IMAGE: imageId,
      INVENTORY_ERROR: "false",
      WORKER_INVENTORY: "",
      ...environment,
    },
  });
}

describe.skipIf(process.platform === "win32")("forward repair with a lost source email-worker image", () => {
  it("records the missing artifact only after journaled database mutation and an empty worker inventory", () => {
    const result = check();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("retained=false");
  });

  it.each([
    { first_router_forward_repair_resume: "false" },
    { database_mutation_started: "false" },
    { first_router_recovery_journal_sha256: "" },
  ])("refuses missing artifacts outside a journaled forward repair: %j", (environment) => {
    const result = check(environment);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not the retained immutable release");
  });

  it("refuses any retained worker, including a stopped container with a missing image", () => {
    const result = check({ WORKER_INVENTORY: "d".repeat(64) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires an empty worker inventory");
  });

  it("does not confuse an inventory-query failure with an empty inventory", () => {
    const result = check({ INVENTORY_ERROR: "true" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("inventory could not be read");
  });

  it.each([
    { previous_auth_worker_image_id: "mutable:latest" },
    { previous_auth_worker_revision: "e".repeat(40) },
  ])("rejects invalid historical identities: %j", (environment) => {
    const result = check(environment);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid journaled identity");
  });

  it("retains the strict normal-release path when the exact artifact exists", () => {
    const result = check({
      ARTIFACT_PRESENT: "true",
      first_router_forward_repair_resume: "false",
      database_mutation_started: "false",
      INVENTORY_ERROR: "true",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("retained=true");
  });

  it.each(["true", "false"])("rejects a different returned artifact during forward repair=%s", (forwardRepair) => {
    const result = check({
      ARTIFACT_PRESENT: "true",
      INSPECTED_IMAGE: `sha256:${"f".repeat(64)}`,
      first_router_forward_repair_resume: forwardRepair,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("image identity changed");
  });
});
