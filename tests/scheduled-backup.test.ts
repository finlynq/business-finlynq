import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backupScript = fileURLToPath(new URL("../deploy/backup/run-scheduled-backup.sh", import.meta.url));

function runBackup(provisionStatus = 0, backupStatus = 0) {
  const directory = mkdtempSync(join(tmpdir(), "scheduled-backup-test-"));
  try {
    writeFileSync(join(directory, "database-id"), "existing-healthy-database");
    writeFileSync(join(directory, "calls"), "");
    // Model Compose's dependency reconciliation: running a one-shot without
    // --no-deps replaces a database whose deployment configuration differs.
    writeFileSync(join(directory, "docker"), String.raw`#!/bin/bash
set -Eeuo pipefail
[[ "$1 $2 $3 $4" == "compose --profile operations run" ]] || exit 90
for argument in "$@"; do service="$argument"; done
[[ "$service" == provision_backup || "$service" == backup ]] || exit 91
if [[ " $* " != *" --no-deps "* ]]; then
  printf 'recreated-database' > "$BACKUP_TEST_DIRECTORY/database-id"
fi
printf '%s\n' "$service" >> "$BACKUP_TEST_DIRECTORY/calls"
if [[ "$service" == provision_backup ]]; then
  exit "$BACKUP_TEST_PROVISION_STATUS"
fi
exit "$BACKUP_TEST_BACKUP_STATUS"
`, { mode: 0o700 });
    const result = spawnSync("/bin/bash", [backupScript], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        NODE_ENV: "test",
        PATH: `${directory}:/usr/bin:/bin`,
        BUSINESS_FINLYNQ_IMAGE_REVISION: "a".repeat(40),
        SCHEDULED_BACKUP_TIMEOUT_SECONDS: "5",
        BACKUP_TEST_DIRECTORY: directory,
        BACKUP_TEST_PROVISION_STATUS: String(provisionStatus),
        BACKUP_TEST_BACKUP_STATUS: String(backupStatus),
      },
    });
    return {
      ...result,
      databaseId: readFileSync(join(directory, "database-id"), "utf8"),
      calls: readFileSync(join(directory, "calls"), "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("scheduled backup dependency isolation", () => {
  it("preserves the live database while provisioning and creating the backup", () => {
    const result = runBackup();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(["provision_backup", "backup"]);
    expect(result.databaseId).toBe("existing-healthy-database");
  });

  it("stops before backup when role provisioning fails", () => {
    const result = runBackup(19);
    expect(result.status, result.stderr).toBe(19);
    expect(result.calls).toEqual(["provision_backup"]);
  });

  it("propagates backup failure after successful provisioning", () => {
    const result = runBackup(0, 23);
    expect(result.status, result.stderr).toBe(23);
    expect(result.calls).toEqual(["provision_backup", "backup"]);
  });
});
