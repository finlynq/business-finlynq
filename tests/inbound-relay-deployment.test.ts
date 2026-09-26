import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const deployers = ["deploy/dev/deploy-dev.sh", "deploy/development/deploy-development.sh"];
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const target = "/run/secrets/business_finlynq_accounting_email_inbound_relay_secret";

function fixture(path: string) {
  const source = readFileSync(path, "utf8");
  const helper = source.slice(source.indexOf("inbound_relay_configuration_matches() {"), source.indexOf("\nnetwork_alias_has_exact_owner() {"));
  const directory = mkdtempSync(join(tmpdir(), "finlynq-inbound-drift-")); directories.push(directory);
  const file = join(directory, "relay-key");
  const runtimeFile = join(directory, "mounted-key");
  const value = "synthetic-inbound-relay-secret-000000000000\n";
  writeFileSync(file, value, { mode: 0o600 });
  writeFileSync(runtimeFile, value, { mode: 0o600 });
  const environment: Record<string, string> = {
    BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN: "mail.finlynq.com",
    BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX: "businessdev-",
    ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET_FILE: target,
  };
  const running: Record<string, string> = { ...environment };
  const mounts = [{ Source: file, Destination: target, RW: false }];
  const appSecrets: { source: string; target?: string }[] = [{ source: target.split("/").at(-1)!, target }];
  const secret = { file };
  const config = { services: { app: { environment, secrets: appSecrets } }, secrets: { [appSecrets[0].source]: secret } };
  function run(duplicateEnvironment = false) {
    writeFileSync(join(directory, "config.json"), JSON.stringify(config));
    writeFileSync(join(directory, "mounts.json"), JSON.stringify(mounts));
    writeFileSync(join(directory, "env.json"), JSON.stringify([
      ...Object.entries(running).map(([key, val]) => `${key}=${val}`),
      ...(duplicateEnvironment ? [`ACCOUNTING_EMAIL_INBOUND_RELAY_SECRET_FILE=${target}`] : []),
    ]));
    return spawnSync("bash", ["-c", `set -eu
docker() {
  if [ "$1" = inspect ]; then
    if [ "$3" = '{{json .Mounts}}' ]; then cat "$FIXTURE/mounts.json"; else cat "$FIXTURE/env.json"; fi
  elif [ "$1" = exec ]; then
    sha256sum -- "$FIXTURE/mounted-key" | cut -d ' ' -f 1
  else return 1
  fi
}
${helper}
inbound_relay_configuration_matches app "$(cat "$FIXTURE/config.json")"
`], { encoding: "utf8", env: { ...process.env, FIXTURE: directory } });
  }
  return { source, directory, file, runtimeFile, environment, running, mounts, appSecrets, secret, run };
}

describe.each(deployers)("inbound relay configuration drift: %s", (path) => {
  it.skipIf(process.platform === "win32")("is wired into the existing acceptance/recreation contract and accepts matching files silently", () => {
    const f = fixture(path);
    expect(f.source).toContain('inbound_relay_configuration_matches "$container" "$rendered"');
    expect(f.source).toContain('if ! document_provider_configuration_matches');
    const result = f.run(); expect(result.status).toBe(0); expect(result.stdout + result.stderr).toBe("");
  });
  it.skipIf(process.platform === "win32").each(["absolute", "relative", "default"])("accepts %s Compose targets", (form) => {
    const f = fixture(path);
    if (form === "relative") f.appSecrets[0].target = f.appSecrets[0].source;
    if (form === "default") delete f.appSecrets[0].target;
    expect(f.run().status).toBe(0);
  });
  it.skipIf(process.platform === "win32")("detects the old inert mount even with equal placeholder bytes", () => {
    const f = fixture(path);
    f.mounts[0].Source = join(f.directory, "not-configured");
    expect(f.run().status).toBe(1);
  });
  it.skipIf(process.platform === "win32")("detects enabling/disabling and namespace drift without logging values", () => {
    for (const key of ["BUSINESS_FINLYNQ_INBOUND_EMAIL_DOMAIN", "BUSINESS_FINLYNQ_INBOUND_EMAIL_PREFIX"]) {
      const f = fixture(path);
      f.running[key] = "";
      let result = f.run(); expect(result.status).toBe(1); expect(result.stdout + result.stderr).toBe("");
      f.running[key] = f.environment[key]; f.environment[key] = "";
      result = f.run(); expect(result.status).toBe(1); expect(result.stdout + result.stderr).toBe("");
      f.running[key] = ""; expect(f.run().status).toBe(0);
    }
  });
  it.skipIf(process.platform === "win32")("detects same-path rotation until mounted bytes agree", () => {
    const f = fixture(path);
    writeFileSync(f.file, "rotated-synthetic-inbound-relay-secret-00000\n");
    const stale = f.run(); expect(stale.status).toBe(1); expect(stale.stdout + stale.stderr).toBe("");
    writeFileSync(f.runtimeFile, readFileSync(f.file)); expect(f.run().status).toBe(0);
  });
  it.skipIf(process.platform === "win32")("rejects writable, absent, duplicate and wrong-destination mounts", () => {
    const f = fixture(path);
    f.mounts[0].RW = true; expect(f.run().status).toBe(1);
    f.mounts[0].RW = false; f.mounts.push({ ...f.mounts[0] }); expect(f.run().status).toBe(1);
    f.mounts.pop(); f.mounts[0].Destination = `/different/${target.split("/").at(-1)}`; expect(f.run().status).toBe(1);
    f.mounts.length = 0; expect(f.run().status).toBe(1);
  });
  it.skipIf(process.platform === "win32")("rejects missing/symlink sources and ambiguous environment/Compose secrets", () => {
    const f = fixture(path);
    expect(f.run(true).status).toBe(1);
    f.appSecrets.push({ ...f.appSecrets[0] }); expect(f.run().status).toBe(1); f.appSecrets.pop();
    f.secret.file = join(f.directory, "missing"); expect(f.run().status).toBe(1);
    symlinkSync(f.file, f.secret.file); expect(f.run().status).toBe(1);
  });
  it.skipIf(process.platform === "win32")("supports a pre-relay revision only when running settings are also absent", () => {
    const f = fixture(path);
    for (const key of Object.keys(f.environment)) delete f.environment[key];
    expect(f.run().status).toBe(1);
    for (const key of Object.keys(f.running)) delete f.running[key];
    f.mounts.length = 0; f.appSecrets.length = 0;
    expect(f.run().status).toBe(0);
  });
});
