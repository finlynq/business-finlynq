import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantTransactionContext } from "@/db/transaction";

const mocks = vi.hoisted(() => ({
  assertTenantWritesEnabled: vi.fn(),
  assertWritableOrganization: vi.fn(async () => ({ isDemo: false })),
  query: vi.fn(async () => ({ rows: [{ version: 2 }] })),
  withTenantTransaction: vi.fn(async (_context, work) => work({ query: mocks.query })),
}));

vi.mock("@/db/transaction", () => ({
  withTenantTransaction: mocks.withTenantTransaction,
}));

vi.mock("@/modules/workspace/write-policy", () => ({
  assertTenantWritesEnabled: mocks.assertTenantWritesEnabled,
  assertWritableOrganization: mocks.assertWritableOrganization,
}));

import {
  readOrganizationSettingsRecord,
  updateOrganizationSettingsRecord,
} from "@/modules/identity/member-access-store";

const context: TenantTransactionContext = {
  actorId: "10000000-0000-4000-8000-000000000001",
  authMethod: "PASSWORD_MFA",
  organizationId: "10000000-0000-4000-8000-000000000002",
  requestId: "member-access-request",
  sessionId: "10000000-0000-4000-8000-000000000003",
  sessionMode: "real",
  sourceSurface: "UI",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [{ version: 2 }] });
});

describe("organization member-access persistence boundary", () => {
  it("checks both deployment and organization write policy inside the mutation transaction", async () => {
    await expect(updateOrganizationSettingsRecord(context, {
      displayName: "Updated organization",
      expectedVersion: 1,
    })).resolves.toBe(2);

    expect(mocks.assertTenantWritesEnabled).toHaveBeenCalledWith(context);
    expect(mocks.assertWritableOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.query }),
      context,
    );
    expect(mocks.query).toHaveBeenCalledWith(
      "SELECT app.organization_update_settings($1,$2) AS version",
      ["Updated organization", 1],
    );
  });

  it("does not enter a transaction after the deployment write gate rejects the command", async () => {
    mocks.assertTenantWritesEnabled.mockImplementationOnce(() => {
      throw new Error("Business writes are disabled");
    });

    await expect(updateOrganizationSettingsRecord(context, {
      displayName: "Blocked organization",
      expectedVersion: 1,
    })).rejects.toThrow("Business writes are disabled");

    expect(mocks.withTenantTransaction).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("keeps reads available without applying mutation write gates", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await expect(readOrganizationSettingsRecord(context)).resolves.toBeNull();

    expect(mocks.assertTenantWritesEnabled).not.toHaveBeenCalled();
    expect(mocks.assertWritableOrganization).not.toHaveBeenCalled();
  });
});
