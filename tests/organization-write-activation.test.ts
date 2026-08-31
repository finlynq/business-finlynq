import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  inspectOrganizationWriteStatus,
  organizationWritesAreEffective,
  setOrganizationWrites,
} from "@/modules/operations/organization-write-activation";
import {
  executeOrganizationWriteCommand,
  executeOrganizationWriteOperatorPool,
  formatOrganizationWriteFailure,
  ORGANIZATION_WRITE_FAILURE_MESSAGE,
  parseGlobalBusinessWriteGate,
  parseOrganizationWriteCommand,
} from "../scripts/organization-writes-command";

const organizationId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";

function fakeClient(
  implementation: (sql: string, values?: readonly unknown[]) => Promise<unknown>,
): PoolClient {
  return {
    query: vi.fn(implementation),
  } as unknown as PoolClient;
}

describe("organization write activation operator boundary", () => {
  it("keeps the documented CLI failure stream to one redacted line", () => {
    const suppliedOperator = "operator:private-release";
    const suppliedReason = "Approved private change CHG-9999";
    const child = spawnSync(process.execPath, [
      "--require",
      join(process.cwd(), "tests", "fixtures", "tsx-process-identity.cjs"),
      "--import",
      "tsx",
      join(process.cwd(), "scripts", "organization-writes.ts"),
      "enable",
      "--organization", organizationId,
      "--operator-id", suppliedOperator,
      "--reason", suppliedReason,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BUSINESS_FINLYNQ_MIGRATION_DB_HOST: "",
        DATABASE_MIGRATION_URL: "",
        BUSINESS_WRITES_ENABLED: "false",
      },
    });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr.trim()).toBe(ORGANIZATION_WRITE_FAILURE_MESSAGE);
    expect(child.stderr).not.toContain(organizationId);
    expect(child.stderr).not.toContain(suppliedOperator);
    expect(child.stderr).not.toContain(suppliedReason);

    const runbook = readFileSync(
      join(process.cwd(), "docs", "operations", "real-account-activation.md"),
      "utf8",
    );
    expect(runbook).not.toContain("npm run org:writes");
    expect(runbook).toContain("npm run --silent org:writes");
  });

  it("parses only UUID-targeted commands and requires non-PII mutation metadata", () => {
    expect(parseOrganizationWriteCommand([
      "enable",
      "--organization", organizationId,
      "--operator-id", "operator:release-1",
      "--reason", "Approved change CHG-1042",
    ])).toEqual({
      action: "enable",
      organizationId,
      operatorId: "operator:release-1",
      reason: "Approved change CHG-1042",
    });
    expect(parseOrganizationWriteCommand(["status", "--organization", organizationId])).toEqual({
      action: "status",
      organizationId,
    });
    expect(parseOrganizationWriteCommand([
      "status", "--organization", organizationId.toUpperCase(),
    ])).toEqual({
      action: "status",
      organizationId,
    });
    expect(() => parseOrganizationWriteCommand([
      "enable", "--organization", "northstar", "--operator-id", "operator:release-1",
      "--reason", "Approved change CHG-1042",
    ])).toThrow(/UUID/);
    expect(() => parseOrganizationWriteCommand([
      "enable", "--organization", organizationId, "--operator-id", "person@example.com",
      "--reason", "Approved change CHG-1042",
    ])).toThrow(/Operator ID/);
    expect(() => parseOrganizationWriteCommand([
      "disable", "--organization", organizationId, "--operator-id", "operator:incident-1",
      "--reason", "Contact person@example.com for incident approval",
    ])).toThrow(/Reason/);
    expect(() => parseOrganizationWriteCommand([
      "status", "--organization", organizationId, "--operator-id", "operator:release-1",
    ])).toThrow(/does not accept/);
  });

  it("interprets the global gate strictly and fails closed when it is absent", () => {
    expect(parseGlobalBusinessWriteGate(undefined)).toBe(false);
    expect(parseGlobalBusinessWriteGate("")).toBe(false);
    expect(parseGlobalBusinessWriteGate("false")).toBe(false);
    expect(parseGlobalBusinessWriteGate("true")).toBe(true);
    expect(() => parseGlobalBusinessWriteGate("TRUE")).toThrow(/exactly true or false/);
    expect(() => parseGlobalBusinessWriteGate(" true")).toThrow(/exactly true or false/);
  });

  it("inspects only activation metadata and requires both activation layers", async () => {
    const client = fakeClient(async () => ({ rows: [{
      organization_id: organizationId,
      active: true,
      organization_mode: "REAL",
      writes_enabled_at: "2026-08-31T12:00:00.000Z",
    }] }));
    const status = await inspectOrganizationWriteStatus(client, organizationId);
    expect(status).toEqual({
      organizationId,
      active: true,
      organizationMode: "REAL",
      writesEnabledAt: new Date("2026-08-31T12:00:00.000Z"),
    });
    expect(organizationWritesAreEffective(status, false)).toBe(false);
    expect(organizationWritesAreEffective(status, true)).toBe(true);
    await expect(inspectOrganizationWriteStatus(client, organizationId.toUpperCase())).resolves
      .toMatchObject({ organizationId });
    expect(vi.mocked(client.query).mock.calls[0]).toEqual([
      expect.stringContaining("FROM organizations"),
      [organizationId],
    ]);
    expect(vi.mocked(client.query).mock.calls[1]?.[1]).toEqual([organizationId]);
  });

  it("calls the exact owner-only mutation function and reports an idempotent result", async () => {
    const client = fakeClient(async () => ({ rows: [{
      organization_id: organizationId,
      active: true,
      organization_mode: "REAL",
      writes_enabled_at: "2026-08-31T12:00:00.000Z",
      changed: false,
    }] }));
    await expect(setOrganizationWrites(client, {
      organizationId,
      enabled: true,
      operatorId: "operator:release-1",
      reason: "Approved change CHG-1042",
      requestId,
    })).resolves.toMatchObject({
      organizationId,
      enabled: true,
      changed: false,
    });
    expect(vi.mocked(client.query).mock.calls[0]).toEqual([
      expect.stringContaining("app.operator_set_organization_writes($1,$2,$3,$4,$5)"),
      [organizationId, true, "operator:release-1", "Approved change CHG-1042", requestId],
    ]);
  });

  it("uses a read-committed bounded transaction and exposes staged versus effective state", async () => {
    const client = fakeClient(async (sql) => {
      if (sql.includes("operator_set_organization_writes")) {
        return { rows: [{
          organization_id: organizationId,
          active: true,
          organization_mode: "REAL",
          writes_enabled_at: "2026-08-31T12:00:00.000Z",
          changed: false,
        }] };
      }
      return { rows: [] };
    });
    await expect(executeOrganizationWriteCommand(client, {
      action: "enable",
      organizationId,
      operatorId: "operator:release-1",
      reason: "Approved change CHG-1042",
    }, { globalGateEnabled: false, requestId })).resolves.toEqual({
      action: "enable",
      outcome: "already_enabled",
      organizationId,
      active: true,
      organizationMode: "REAL",
      writesEnabledAt: "2026-08-31T12:00:00.000Z",
      organizationWritesEnabled: true,
      globalGateEnabled: false,
      effectiveWritesEnabled: false,
    });
    const calls = vi.mocked(client.query).mock.calls.map(([sql]) => sql);
    expect(calls).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "SET LOCAL statement_timeout = '15s'",
      "SET LOCAL lock_timeout = '5s'",
      expect.stringContaining("app.operator_set_organization_writes"),
      "COMMIT",
    ]);
  });

  it("rolls back and replaces database detail with a constant redacted failure", async () => {
    const client = fakeClient(async (sql) => {
      if (sql.includes("operator_set_organization_writes")) {
        throw new Error("owner@example.com violated secret table detail");
      }
      return { rows: [] };
    });
    const command = {
      action: "disable" as const,
      organizationId,
      operatorId: "operator:incident-1",
      reason: "Incident INC-204 emergency disable",
    };
    await expect(executeOrganizationWriteCommand(
      client,
      command,
      { globalGateEnabled: true, requestId },
    )).rejects.toThrow(ORGANIZATION_WRITE_FAILURE_MESSAGE);
    expect(JSON.stringify(vi.mocked(client.query).mock.calls)).toContain("ROLLBACK");
    expect(ORGANIZATION_WRITE_FAILURE_MESSAGE).not.toContain("example.com");
    expect(ORGANIZATION_WRITE_FAILURE_MESSAGE).not.toContain(organizationId);
  });

  it("preserves only the audit request UUID when commit outcome is uncertain", async () => {
    const client = fakeClient(async (sql) => {
      if (sql.includes("operator_set_organization_writes")) {
        return { rows: [{
          organization_id: organizationId,
          active: true,
          organization_mode: "REAL",
          writes_enabled_at: "2026-08-31T12:00:00.000Z",
          changed: true,
        }] };
      }
      if (sql === "COMMIT") throw new Error("connection lost after commit was sent");
      return { rows: [] };
    });

    let failure: unknown;
    try {
      await executeOrganizationWriteCommand(client, {
        action: "enable",
        organizationId,
        operatorId: "operator:release-1",
        reason: "Approved change CHG-1042",
      }, { globalGateEnabled: true, requestId });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: ORGANIZATION_WRITE_FAILURE_MESSAGE,
      requestId,
    });
    expect(formatOrganizationWriteFailure(failure)).toBe(
      `${ORGANIZATION_WRITE_FAILURE_MESSAGE}; requestId=${requestId}`,
    );
    expect(formatOrganizationWriteFailure(new Error("private detail"))).toBe(
      ORGANIZATION_WRITE_FAILURE_MESSAGE,
    );
  });

  it("does not let connection cleanup replace a committed result or primary correlated failure", async () => {
    const successfulClient = fakeClient(async (sql) => {
      if (sql.includes("operator_set_organization_writes")) {
        return { rows: [{
          organization_id: organizationId,
          active: true,
          organization_mode: "REAL",
          writes_enabled_at: "2026-08-31T12:00:00.000Z",
          changed: false,
        }] };
      }
      return { rows: [] };
    });
    successfulClient.release = vi.fn(() => {
      throw new Error("private release failure");
    });
    const successfulPool = {
      connect: vi.fn(async () => successfulClient),
      end: vi.fn(async () => { throw new Error("private pool cleanup failure"); }),
    };
    await expect(executeOrganizationWriteOperatorPool(successfulPool, {
      action: "enable",
      organizationId,
      operatorId: "operator:release-1",
      reason: "Approved change CHG-1042",
    }, { globalGateEnabled: false, requestId })).resolves.toMatchObject({
      outcome: "already_enabled",
      organizationId,
    });

    const uncertainClient = fakeClient(async (sql) => {
      if (sql.includes("operator_set_organization_writes")) {
        return { rows: [{
          organization_id: organizationId,
          active: true,
          organization_mode: "REAL",
          writes_enabled_at: "2026-08-31T12:00:00.000Z",
          changed: true,
        }] };
      }
      if (sql === "COMMIT") throw new Error("private uncertain commit detail");
      return { rows: [] };
    });
    uncertainClient.release = vi.fn(() => {
      throw new Error("private release failure");
    });
    const uncertainPool = {
      connect: vi.fn(async () => uncertainClient),
      end: vi.fn(async () => { throw new Error("private pool cleanup failure"); }),
    };
    let failure: unknown;
    try {
      await executeOrganizationWriteOperatorPool(uncertainPool, {
        action: "enable",
        organizationId,
        operatorId: "operator:release-1",
        reason: "Approved change CHG-1042",
      }, { globalGateEnabled: true, requestId });
    } catch (error) {
      failure = error;
    }
    expect(formatOrganizationWriteFailure(failure)).toBe(
      `${ORGANIZATION_WRITE_FAILURE_MESSAGE}; requestId=${requestId}`,
    );
  });

  it("fails closed when the database result is bound to another organization", async () => {
    const client = fakeClient(async () => ({ rows: [{
      organization_id: "10000000-0000-4000-8000-000000000002",
      active: true,
      organization_mode: "REAL",
      writes_enabled_at: "2026-08-31T12:00:00.000Z",
      changed: true,
    }] }));
    await expect(setOrganizationWrites(client, {
      organizationId,
      enabled: true,
      operatorId: "operator:release-1",
      reason: "Approved change CHG-1042",
      requestId,
    })).rejects.toThrow(/invalid organization binding/);
  });
});
