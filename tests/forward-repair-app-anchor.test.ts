import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deploy = readFileSync(new URL("../deploy/continuous-deployment/deploy-main.sh", import.meta.url), "utf8");
const start = deploy.indexOf("attest_forward_repair_application() {");
const end = deploy.indexOf("\n}\n", start);
if (start < 0 || end < 0) throw new Error("Missing forward-repair application attestation");
const attest = deploy.slice(start, end + 3);
const sourceRevision = "a".repeat(40);
const candidateRevision = "b".repeat(40);
const sourceImage = `sha256:${"c".repeat(64)}`;
const candidateImage = `sha256:${"d".repeat(64)}`;
const sourceContainer = {
  Image: sourceImage,
  State: { Running: false },
  Config: { Labels: {
    "com.docker.compose.project": "business-finlynq",
    "com.docker.compose.service": "app",
    "org.opencontainers.image.revision": sourceRevision,
  } },
  HostConfig: {
    ReadonlyRootfs: true,
    Privileged: false,
    RestartPolicy: { Name: "unless-stopped" },
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
  },
};

function check(environment: Record<string, string> = {}, container = sourceContainer) {
  return spawnSync("/bin/bash", ["-c", `
set -Eeuo pipefail
fail() { printf '%s\\n' "$*" >&2; exit 1; }
docker() {
  if [[ "$1 $2" == 'image inspect' ]]; then
    [[ "$CANDIDATE_AVAILABLE" == true ]] || return 1
    [[ "\${!#}" == "business-finlynq-app:$candidate_revision" ]] || return 2
    printf '%s\\n' "$CANDIDATE_IMAGE"
  elif [[ "$1 $2" == 'inspect --format' ]]; then
    [[ "$INSPECTION_AVAILABLE" == true ]] || return 1
    if [[ "$3" == '{{.Image}}' ]]; then
      printf '%s\\n' "$CURRENT_IMAGE"
    else
      printf '%s' "$PUBLIC_EDGE"
    fi
  elif [[ "$1" == inspect ]]; then
    [[ "$INSPECTION_AVAILABLE" == true ]] || return 1
    printf '%s\\n' "$CONTAINER_JSON"
  else
    return 2
  fi
}
network_alias_has_exact_owner() { [[ "$PRIVATE_ALIAS_VALID" == true ]]; }
${attest}
attest_forward_repair_application
printf 'accepted\\n'
`], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      retained_app_container: "e".repeat(64),
      retained_app_image_id: sourceImage,
      backup_source_revision: sourceRevision,
      candidate_revision: candidateRevision,
      release_transition_candidate_revision: "f".repeat(40),
      release_forward_repair_superseded: "true",
      release_transition_router_was_preexisting: "true",
      legacy_f8485_revision: "0".repeat(40),
      CURRENT_IMAGE: container.Image,
      CONTAINER_JSON: JSON.stringify([container]),
      CANDIDATE_IMAGE: candidateImage,
      CANDIDATE_AVAILABLE: "false",
      INSPECTION_AVAILABLE: "true",
      PRIVATE_ALIAS_VALID: "true",
      PUBLIC_EDGE: "",
      ...environment,
    },
  });
}

const retainedCandidate = {
  ...sourceContainer,
  Image: candidateImage,
  Config: { Labels: {
    ...sourceContainer.Config.Labels,
    "org.opencontainers.image.revision": candidateRevision,
  } },
};

describe.skipIf(process.platform === "win32")("forward-repair application anchor", () => {
  it.each(["true", "false"])("accepts the exact source without a candidate image when superseded=%s", (superseded) => {
    const result = check({ release_forward_repair_superseded: superseded });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("accepted");
  });

  it("requires the exact candidate image when a candidate container is retained", () => {
    const result = check({ release_forward_repair_superseded: "false" }, retainedCandidate);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lost the exact prior candidate application image");
  });

  it("accepts a matching retained candidate only for the same candidate revision", () => {
    const result = check({ release_forward_repair_superseded: "false", CANDIDATE_AVAILABLE: "true" }, retainedCandidate);
    expect(result.status, result.stderr).toBe(0);
  });

  it("refuses a candidate anchor when superseding the failed release", () => {
    const result = check({ CANDIDATE_AVAILABLE: "true" }, retainedCandidate);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires the exact source application anchor");
  });

  it("refuses a candidate image that does not match the retained container", () => {
    const result = check({ release_forward_repair_superseded: "false", CANDIDATE_AVAILABLE: "true", CANDIDATE_IMAGE: sourceImage }, retainedCandidate);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected application image");
  });

  it.each([
    { ...sourceContainer, State: { Running: true } },
    { ...sourceContainer, HostConfig: { ...sourceContainer.HostConfig, ReadonlyRootfs: false } },
    { ...sourceContainer, HostConfig: { ...sourceContainer.HostConfig, Privileged: true } },
    { ...sourceContainer, Config: { Labels: { ...sourceContainer.Config.Labels, "org.opencontainers.image.revision": candidateRevision } } },
  ])("rejects an unsafe or incorrectly labeled source container: %j", (container) => {
    const result = check({}, container);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected application container");
  });

  it("refuses failed container inspection", () => {
    const result = check({ INSPECTION_AVAILABLE: "false" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not be inspected");
  });

  it("requires the private upstream alias when the router existed before cutover", () => {
    const result = check({ PRIVATE_ALIAS_VALID: "false" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unique private upstream");
  });

  it("refuses a first-router source anchor that is still on the public edge", () => {
    const result = check({ release_transition_router_was_preexisting: "false", PUBLIC_EDGE: "attached" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("retained the public edge");
  });
});
