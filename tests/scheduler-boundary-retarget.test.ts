import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bootstrap = readFileSync(
  resolve(process.cwd(), "deploy/release/bootstrap-scheduler-boundary.sh"),
  "utf8",
);

describe("scheduler-boundary superseded-candidate retarget", () => {
  it("validates the protected prior state under the production coordination lock", () => {
    const lockIndex = bootstrap.indexOf("flock --exclusive --nonblock 9");
    const boundaryIndex = bootstrap.indexOf(
      '[[ ! -e "$installed_boundary_file" && ! -L "$installed_boundary_file" ]]',
    );
    const receiptValidationIndex = bootstrap.indexOf(
      'validate_protected_state_file "$receipt_file"',
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(boundaryIndex).toBeGreaterThan(lockIndex);
    expect(receiptValidationIndex).toBeGreaterThan(boundaryIndex);
    expect(bootstrap).toContain(
      '"$(stat -c \'%u:%a\' -- "$selected_file")" == "$deploy_uid:600"',
    );
    expect(bootstrap).toContain(
      "a superseded-candidate retarget requires both the protected receipt and maintenance marker",
    );
  });

  it("accepts only the exact receipt schema for the unchanged source and scheduler", () => {
    for (const key of [
      "candidateRevision",
      "pausedAt",
      "product",
      "scheduler",
      "schemaVersion",
      "sourceRevision",
    ]) {
      expect(bootstrap).toContain(`"${key}"`);
    }
    expect(bootstrap).toContain("length == 1");
    expect(bootstrap).toContain('.sourceRevision == $sourceRevision');
    expect(bootstrap).toContain('.scheduler == $scheduler');
    expect(bootstrap).toContain('.candidateRevision != $sourceRevision');
    expect(bootstrap).toContain('.candidateRevision != $candidateRevision');
    expect(bootstrap).toContain(
      'merge-base --is-ancestor "$existing_candidate_revision" "$candidate_revision"',
    );
  });

  it("requires the exact two-line marker for the selected scheduler", () => {
    expect(bootstrap).toContain('mapfile -t marker_lines <"$marker_file"');
    expect(bootstrap).toContain('"${#marker_lines[@]}" -eq 2');
    expect(bootstrap).toContain(
      '"${marker_lines[1]}" == "mode=$scheduler_mode"',
    );
  });

  it("uses allow-already-paused only for a validated retarget and never resumes cron", () => {
    const validationIndex = bootstrap.indexOf('retarget_existing_receipt="true"');
    const conditionalIndex = bootstrap.indexOf(
      'if [[ "$retarget_existing_receipt" == "true" ]]; then\n  pause_arguments+=(--allow-already-paused)',
    );
    const pauseIndex = bootstrap.indexOf(
      'pause-schedulers.sh" "${pause_arguments[@]}"',
    );

    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(conditionalIndex).toBeGreaterThan(validationIndex);
    expect(pauseIndex).toBeGreaterThan(conditionalIndex);
    expect(bootstrap).not.toContain("resume-schedulers.sh");
    expect(bootstrap).not.toContain("deploy/cron/install.sh");
    expect(bootstrap).toContain(
      "the deployed source checkout changed while establishing the scheduler boundary",
    );
  });

  it("keeps the old receipt until a complete replacement is atomically renamed", () => {
    const pauseIndex = bootstrap.indexOf(
      'pause-schedulers.sh" "${pause_arguments[@]}"',
    );
    const temporaryIndex = bootstrap.indexOf(
      'temporary_receipt="$(mktemp "$state_directory/.scheduler-boundary-bootstrap.XXXXXX")"',
    );
    const syncIndex = bootstrap.indexOf('sync -f -- "$temporary_receipt"');
    const renameIndex = bootstrap.indexOf(
      'mv -f -- "$temporary_receipt" "$receipt_file"',
    );

    expect(temporaryIndex).toBeGreaterThan(pauseIndex);
    expect(syncIndex).toBeGreaterThan(temporaryIndex);
    expect(renameIndex).toBeGreaterThan(syncIndex);
    expect(bootstrap).toContain('temporary_receipt=""');
  });
});
