import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const source = readFileSync("deploy/development/deploy-development.sh", "utf8");
const helper = source.slice(source.indexOf("document_provider_configuration_matches() {"), source.indexOf("\nrelease_is_accepted() {"));
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "finlynq-provider-deployment-")); directories.push(directory);
  const runtime = join(directory, "runtime"); mkdirSync(runtime);
  const environment: Record<string, string> = {};
  const secrets: Record<string, { file: string }> = {};
  const mounts: { Source: string; Destination: string; RW: boolean }[] = [];
  const appSecrets: { source: string; target?: string }[] = [];
  for (const provider of ["GOOGLE", "MICROSOFT"]) {
    const name = provider.toLowerCase(); const target = `/run/secrets/${name}`; const file = join(directory, name);
    writeFileSync(file, `${name}-synthetic-secret\n`, { mode: 0o600 });
    writeFileSync(join(runtime, name), readFileSync(file), { mode: 0o600 });
    environment[`DOCUMENT_${provider}_CLIENT_ID`] = `${name}-synthetic-id`;
    environment[`DOCUMENT_${provider}_CLIENT_SECRET_FILE`] = target;
    secrets[name] = { file }; appSecrets.push({ source: name, target });
    mounts.push({ Source: file, Destination: target, RW: false });
  }
  const config = { services: { app: { environment, secrets: appSecrets } }, secrets };
  const running = { ...environment };
  function run(failRead = false) {
    writeFileSync(join(directory, "config.json"), JSON.stringify(config));
    writeFileSync(join(directory, "env.json"), JSON.stringify(Object.entries(running).map(([k, v]) => `${k}=${v}`)));
    writeFileSync(join(directory, "mounts.json"), JSON.stringify(mounts));
    const script = `set -eu
docker() {
  if [ "$1" = inspect ]; then
    if [ "$3" = '{{json .Mounts}}' ]; then cat "$FIXTURE/mounts.json"; else cat "$FIXTURE/env.json"; fi
  elif [ "$1" = exec ]; then
    [ "$FAIL_READ" = false ] || return 1
    target="\${@: -1}"
    sha256sum -- "$FIXTURE/runtime/\${target##*/}" | cut -d ' ' -f 1
  else return 1
  fi
}
${helper}
document_provider_configuration_matches app "$(cat "$FIXTURE/config.json")"
`;
    return spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, FIXTURE: directory, FAIL_READ: String(failRead) } });
  }
  return { directory, runtime, environment, running, mounts, config, run };
}

describe("development document-provider configuration drift", () => {
  it("accepts matching credentials without leaking values or hashes", () => {
    const result = fixture().run(); expect(result.status).toBe(0); expect(result.stdout + result.stderr).toBe("");
  });
  it.each(["absolute", "relative", "default"])("accepts %s Compose secret targets", (format) => {
    const f = fixture();
    for (const secret of f.config.services.app.secrets) {
      if (format === "relative") secret.target = secret.source;
      if (format === "default") delete secret.target;
    }
    const result = f.run(); expect(result.status).toBe(0); expect(result.stdout + result.stderr).toBe("");
  });
  it("rejects an unrelated absolute target with the same filename", () => {
    const f = fixture(); f.config.services.app.secrets[0].target = "/different/google";
    expect(f.run().status).toBe(1);
  });
  it("detects enablement, disabling, and rotation of client IDs at the same revision", () => {
    for (const value of ["", "new-client-id"]) {
      const f = fixture(); f.environment.DOCUMENT_MICROSOFT_CLIENT_ID = value;
      expect(f.run().status).toBe(1);
      f.running.DOCUMENT_MICROSOFT_CLIENT_ID = value; expect(f.run().status).toBe(0);
    }
  });
  it("detects changed secret paths and writable or absent mounts", () => {
    const f = fixture(); f.mounts[0].Source += "-old"; expect(f.run().status).toBe(1);
    f.mounts[0].Source = f.config.secrets.google.file; f.mounts[0].RW = true; expect(f.run().status).toBe(1);
    f.mounts.splice(0, 1); expect(f.run().status).toBe(1);
  });
  it("detects same-path secret replacement until the app sees the new contents", () => {
    const f = fixture(); writeFileSync(f.config.secrets.microsoft.file, "rotated-synthetic-value\n");
    const stale = f.run(); expect(stale.status).toBe(1); expect(stale.stdout + stale.stderr).toBe("");
    writeFileSync(join(f.runtime, "microsoft"), readFileSync(f.config.secrets.microsoft.file));
    expect(f.run().status).toBe(0);
    expect(f.run(true).status).toBe(1);
  });
  it("supports recovery to a revision that predates cloud-provider configuration", () => {
    const f = fixture();
    for (const key of Object.keys(f.environment)) { delete f.environment[key]; delete f.running[key]; }
    f.config.services.app.secrets.length = 0; f.mounts.length = 0;
    expect(f.run().status).toBe(0);
  });
});
