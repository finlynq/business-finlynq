import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = "deploy/demo-sandbox/reset-nonproduction-demo.sh";
const inspect = (...args: string[]) => spawnSync("bash", [script, ...args], { encoding: "utf8" });

describe("nonproduction shared-demo maintenance target boundary", () => {
  it.each([
    ["dev", "/home/deploy/business-finlynq-dev", "/etc/business-finlynq-dev/compose.env", "business-finlynq-dev"],
    ["stage", "/home/deploy/business-finlynq-stage", "/etc/business-finlynq-development/compose.env", "business-finlynq-development"],
  ])("resolves %s to its isolated installed deployment", (environment, repository, compose, project) => {
    const result = inspect(environment, "--check");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      `environment=${environment}`, `repository=${repository}`, `compose_environment=${compose}`,
      `project=${project}`, "service=reconcile_demo_sandboxes",
    ]);
  });

  it.each([[], ["production"], ["main", "--check"], ["../dev"], ["dev", "--organization", "anything"], ["stage", "--force"]])(
    "rejects unsupported targets and caller selectors (%j)", (...args) => {
      const result = inspect(...args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("maintenance refused");
    },
  );

  it("uses the same protected deployment lock and nightly boundary", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("/var/lib/business-finlynq/deployment-host.lock");
    expect(source.indexOf("flock --exclusive")).toBeLessThan(source.indexOf('env -i PATH="$clean_path" docker'));
    expect(source).toContain('--env-file "$environment"');
    expect(source).toContain('--profile demo-maintenance run --rm --no-deps reconcile_demo_sandboxes');
    const timer = readFileSync("deploy/systemd/business-finlynq-nonproduction-demo@.timer", "utf8");
    expect(timer).toContain("OnCalendar=*-*-* 04:15:00 America/Toronto");
    expect(timer).toContain("Persistent=true");
  });
});
