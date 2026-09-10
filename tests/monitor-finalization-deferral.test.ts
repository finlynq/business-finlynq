import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const monitor = readFileSync("deploy/monitoring/check-production.sh", "utf8").replaceAll(
  "\r\n",
  "\n",
);
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const bashExecutable =
  process.platform === "win32" ? (existsSync(gitBash) ? gitBash : null) : "/bin/bash";

const extractFunction = (name: string, closing: "}" | ")" = "}") => {
  const start = monitor.indexOf(`${name}() ${closing === ")" ? "(" : "{"}`);
  expect(start, `missing ${name}`).toBeGreaterThanOrEqual(0);
  const endMarker = `\n${closing}\n`;
  const end = monitor.indexOf(endMarker, start);
  expect(end, `unterminated ${name}`).toBeGreaterThan(start);
  return monitor.slice(start, end + endMarker.length);
};

const releaseLockCheck = extractFunction("production_release_lock_is_held", ")");
const markerCheck = extractFunction("active_finalization_marker_allows_scheduled_deferral");

type FixtureOptions = {
  createdEpoch?: number;
  now?: number;
  lockHeld?: boolean;
  markerSchemaValid?: boolean;
  badContract?: "marker" | "recovery" | "lock" | "lock-directory";
};

const runFixture = (options: FixtureOptions = {}) => {
  if (!bashExecutable) return null;
  const root = mkdtempSync(join(tmpdir(), "business-finlynq-monitor-deferral-"));
  const recovery = join(root, "release-recovery");
  const lockDirectory = join(root, "release-locks");
  const marker = join(recovery, "active-finalization.json");
  const lock = join(lockDirectory, "production-release-rollback.lock");
  mkdirSync(recovery);
  mkdirSync(lockDirectory);
  writeFileSync(marker, "{}\n");
  writeFileSync(lock, "");
  const unixPath = (value: string) => value.replaceAll("\\", "/");

  try {
    return spawnSync(
      bashExecutable,
      [
        "-c",
        `
set -Eeuo pipefail
release_recovery_state_directory="$FIXTURE_RECOVERY"
active_finalization_marker="$FIXTURE_MARKER"
production_release_lock_directory="$FIXTURE_LOCK_DIRECTORY"
production_release_lock="$FIXTURE_LOCK"
active_finalization_max_age_seconds=1800

id() {
  case "\${1:-}:\${2:-}" in
    -u:deploy|-g:deploy) printf '1001\n' ;;
    *) return 1 ;;
  esac
}
readlink() {
  local target="\${!#}"
  printf '%s\n' "$target"
}
stat() {
  local format="\${2:-}" target="\${!#}"
  case "$format" in
    %u:%g:%a)
      if [[ "$target" == "$release_recovery_state_directory" ]]; then
        [[ "$FAKE_BAD_CONTRACT" == recovery ]] && printf '0:0:755\n' || printf '0:0:700\n'
      elif [[ "$target" == "$production_release_lock_directory" ]]; then
        [[ "$FAKE_BAD_CONTRACT" == lock-directory ]] \
          && printf '1001:1001:755\n' || printf '1001:1001:700\n'
      else
        return 1
      fi
      ;;
    %u:%g:%a:%h)
      if [[ "$target" == "$active_finalization_marker" ]]; then
        [[ "$FAKE_BAD_CONTRACT" == marker ]] && printf '0:0:644:1\n' || printf '0:0:600:1\n'
      else return 1
      fi
      ;;
    %u:%a:%h)
      [[ "$FAKE_BAD_CONTRACT" == lock ]] \
        && printf '1001:644:1\n' || printf '1001:600:1\n'
      ;;
    %d:%i) printf '7:42\n' ;;
    *) return 1 ;;
  esac
}
jq() {
  if [[ "\${1:-}" == -er ]]; then
    printf '2026-09-09T12:00:00Z\n'
  else
    [[ "$FAKE_MARKER_SCHEMA_VALID" == true ]]
  fi
}
date() {
  if [[ "\${1:-}" == --date=* ]]; then
    printf '%s\n' "$FAKE_CREATED_EPOCH"
  else
    printf '%s\n' "$FAKE_NOW"
  fi
}
flock() {
  [[ "$FAKE_LOCK_HELD" == true ]] && return 75
  return 0
}

${releaseLockCheck}
${markerCheck}
if active_finalization_marker_allows_scheduled_deferral; then
  printf 'allowed\n'
else
  printf 'rejected\n'
fi
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_BAD_CONTRACT: options.badContract ?? "",
          FAKE_CREATED_EPOCH: String(options.createdEpoch ?? 2_000_000_000),
          FAKE_LOCK_HELD: String(options.lockHeld ?? true),
          FAKE_MARKER_SCHEMA_VALID: String(options.markerSchemaValid ?? true),
          FAKE_NOW: String(options.now ?? 2_000_000_120),
          FIXTURE_LOCK: unixPath(lock),
          FIXTURE_LOCK_DIRECTORY: unixPath(lockDirectory),
          FIXTURE_MARKER: unixPath(marker),
          FIXTURE_RECOVERY: unixPath(recovery),
        },
      },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("scheduled monitor active-finalization deferral", () => {
  it("requires an exact protected marker schema and bounded age", () => {
    expect(monitor).toContain("readonly active_finalization_max_age_seconds=1800");
    expect(markerCheck).toContain(
      '(.phase == "terminal-evidence-pending" and',
    );
    expect(markerCheck).toContain('(.phase == "active-commit-authorized" and');
    expect(markerCheck).toContain('"terminalEvidenceSha256"] | sort)');
    expect(markerCheck).toContain('.terminalEvidenceSha256 | type == "string"');
    expect(markerCheck).toContain('.kind == "active-finalization"');
    expect(markerCheck).toContain('keys == ["containerId", "imageId"]');
    expect(markerCheck).toContain("== 0:0:700");
    expect(markerCheck).toContain("== 0:0:600:1");
    expect(markerCheck).toContain('"$created_epoch" -le "$now"');
    expect(markerCheck).toContain("marker_age <= active_finalization_max_age_seconds");
  });

  it("proves the exact deploy-owned production lock is held through its opened inode", () => {
    expect(monitor).toContain(
      'readonly production_release_lock="$production_release_lock_directory/production-release-rollback.lock"',
    );
    expect(releaseLockCheck).toContain('== "$deploy_uid:$deploy_gid:700"');
    expect(releaseLockCheck).toContain('== "$deploy_uid:600:1"');
    expect(releaseLockCheck).toContain('descriptor_path="/proc/$BASHPID/fd/$lock_fd"');
    expect(releaseLockCheck).toContain('"$descriptor_identity" == "$path_identity"');
    expect(releaseLockCheck).toContain("--conflict-exit-code 75");
    expect(releaseLockCheck).toContain('[[ "$lock_status" == 75 ]]');
  });

  it.skipIf(!bashExecutable)("allows only a fresh valid marker with the live release lock", () => {
    const accepted = runFixture();
    expect(accepted?.status, accepted?.stderr).toBe(0);
    expect(accepted?.stdout).toBe("allowed\n");

    for (const options of [
      { lockHeld: false },
      { markerSchemaValid: false },
      { createdEpoch: 2_000_000_000, now: 2_000_001_801 },
      { createdEpoch: 2_000_000_121, now: 2_000_000_120 },
      { badContract: "marker" as const },
      { badContract: "recovery" as const },
      { badContract: "lock" as const },
      { badContract: "lock-directory" as const },
    ]) {
      const rejected = runFixture(options);
      expect(rejected?.status, rejected?.stderr).toBe(0);
      expect(rejected?.stdout, JSON.stringify(options)).toBe("rejected\n");
    }
  }, 15_000);

  it("does not defer on marker presence alone and preserves the explicit transitional bypass", () => {
    expect(monitor).not.toContain(
      '( -e "$active_finalization_marker" || -L "$active_finalization_marker" ) ]]; then',
    );
    expect(monitor).toContain(
      '|| -L "$active_finalization_marker" ) ]] \\\n  && active_finalization_marker_allows_scheduled_deferral; then',
    );
    expect(monitor).toContain('monitor_router_mode="active-or-maintenance"');
    expect(monitor).toContain(
      "A stale, malformed, or orphaned marker therefore cannot suppress the",
    );
  });

  it("preserves signal exit status while cleanup is signal-safe", () => {
    const cleanup = extractFunction("cleanup");
    expect(cleanup).toContain("trap - EXIT");
    expect(cleanup).toContain("trap '' HUP INT TERM");
    expect(monitor).toContain("trap cleanup EXIT");
    expect(monitor).toContain("trap 'exit 129' HUP");
    expect(monitor).toContain("trap 'exit 130' INT");
    expect(monitor).toContain("trap 'exit 143' TERM");
    expect(monitor).not.toContain("trap cleanup EXIT INT TERM");
  });

  it.skipIf(!bashExecutable)("returns the conventional status for each termination signal", () => {
    const executable = bashExecutable;
    if (!executable) return;
    const cleanup = extractFunction("cleanup");
    for (const [signal, expected] of [
      ["HUP", 129],
      ["INT", 130],
      ["TERM", 143],
    ] as const) {
      const result = spawnSync(
        executable,
        [
          "-c",
          `
set -Eeuo pipefail
response_body=/tmp/business-finlynq-monitor-test-body
response_headers=/tmp/business-finlynq-monitor-test-headers
backup_verification_output=/tmp/business-finlynq-monitor-test-backup
backup_schedule_verification_output=/tmp/business-finlynq-monitor-test-schedule
deploy_crontab_output=/tmp/business-finlynq-monitor-test-crontab
deploy_crontab_error=/tmp/business-finlynq-monitor-test-crontab-error
write_host_metrics() { return 0; }
${cleanup}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
kill -${signal} $$
exit 99
`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(expected);
    }
  });
});
