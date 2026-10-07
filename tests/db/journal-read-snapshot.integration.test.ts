import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabasePool, type TenantTransactionContext } from "@/db/transaction";
import type { SessionPrincipal } from "@/modules/identity/session";

const mocks = vi.hoisted(() => ({ read: vi.fn(), stop: new Error("Stop at the journal read boundary") }));
vi.mock("@/modules/workspace/tenant-read", () => ({ withWorkspaceTenantRead: mocks.read }));
import { loadTenantJournalDetail, loadTenantJournalWorkspace } from "@/modules/ledger/tenant-workspace";

const principal: SessionPrincipal = {
  sessionId: randomUUID(), userId: randomUUID(), organizationId: randomUUID(), membershipId: randomUUID(),
  organizationName: "Snapshot regression", roleLabel: "Accountant", displayName: "Snapshot reader", initials: "SR",
  sessionMode: "real", authMethod: "PASSWORD", expiresAt: new Date("2099-01-01T00:00:00Z"),
  mfaVerifiedAt: null, stepUpExpiresAt: null,
};

// These boundary assertions join the concurrency regression below to the actual
// loaders, so removing either loader's opt-in cannot silently reintroduce mixed versions.
describe("journal loader snapshot selection", () => {
  beforeEach(() => { mocks.read.mockReset().mockRejectedValue(mocks.stop); });
  it.each(["register", "detail"] as const)("requests one repeatable snapshot for the %s", async (kind) => {
    const request = kind === "register" ? loadTenantJournalWorkspace(principal) : loadTenantJournalDetail(principal, randomUUID());
    await expect(request).rejects.toBe(mocks.stop);
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ organizationId: principal.organizationId }),
      expect.stringContaining("/app/journals"), expect.any(Function), { isolationLevel: "REPEATABLE READ" });
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTests = databaseUrl ? describe : describe.skip;

databaseTests("journal read snapshots across concurrent resubmission", () => {
  const writer = new Client({ connectionString: databaseUrl });
  const schema = `journal_snapshot_${randomUUID().replaceAll("-", "")}`;
  const journalId = randomUUID();
  const context: TenantTransactionContext = {
    organizationId: principal.organizationId, actorId: principal.userId, sessionId: principal.sessionId,
    sessionMode: "real", requestId: `journal-snapshot:${randomUUID()}`, authMethod: "password", sourceSurface: "UI",
  };
  let tenantRead: typeof import("@/modules/workspace/tenant-read");

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    await closeDatabasePool();
    tenantRead = await vi.importActual<typeof import("@/modules/workspace/tenant-read")>("@/modules/workspace/tenant-read");
    await writer.connect();
    // A dedicated schema is visible to both connections and dropped after the
    // test. No production accounting tables, policies, or triggers are changed.
    await writer.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.journal_header (id uuid PRIMARY KEY, description text, status text, content_hash text, approval_version integer);
      CREATE TABLE ${schema}.journal_lines (journal_id uuid, debit numeric(18,2), credit numeric(18,2));`);
  });
  beforeEach(async () => {
    await writer.query(`TRUNCATE ${schema}.journal_header, ${schema}.journal_lines`);
    await writer.query(`INSERT INTO ${schema}.journal_header VALUES ($1,'Reviewed January depreciation','SUBMITTED',$2,1)`, [journalId, "a".repeat(64)]);
    await writer.query(`INSERT INTO ${schema}.journal_lines VALUES ($1,10,0),($1,0,10)`, [journalId]);
  });
  afterAll(async () => {
    await closeDatabasePool();
    await writer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await writer.end();
    vi.unstubAllEnvs();
  });

  async function readWhileAnotherConnectionResubmits(client: PoolClient) {
    const header = await client.query<{ description: string; status: string }>(
      `SELECT description, status FROM ${schema}.journal_header WHERE id = $1`, [journalId]);
    // This separate connection commits a complete new submission after the
    // header read and before the token/lines reads; no timing-based sleeps.
    await writer.query(`WITH revised_header AS (
      UPDATE ${schema}.journal_header SET description = 'Revised January depreciation', content_hash = $2, approval_version = 2 WHERE id = $1
    ) UPDATE ${schema}.journal_lines SET debit = debit * 2, credit = credit * 2 WHERE journal_id = $1`, [journalId, "b".repeat(64)]);
    const workflow = await client.query<{ content_hash: string; approval_version: number }>(
      `SELECT content_hash, approval_version FROM ${schema}.journal_header WHERE id = $1`, [journalId]);
    const lines = await client.query<{ debit: string; credit: string }>(
      `SELECT sum(debit)::text AS debit, sum(credit)::text AS credit FROM ${schema}.journal_lines WHERE journal_id = $1`, [journalId]);
    return { header: header.rows[0], workflow: workflow.rows[0], totals: lines.rows[0] };
  }

  it("keeps reviewed header, frozen version and lines together when another connection commits a resubmission", async () => {
    const result = await tenantRead.withWorkspaceTenantRead(context, "/app/journals/snapshot", readWhileAnotherConnectionResubmits,
      { isolationLevel: "REPEATABLE READ" });
    expect(result).toEqual({
      header: { description: "Reviewed January depreciation", status: "SUBMITTED" },
      workflow: { content_hash: "a".repeat(64), approval_version: 1 },
      totals: { debit: "10.00", credit: "10.00" },
    });
    const latest = await writer.query(`SELECT description, approval_version FROM ${schema}.journal_header WHERE id = $1`, [journalId]);
    expect(latest.rows[0]).toEqual({ description: "Revised January depreciation", approval_version: 2 });
  });

  it("preserves READ COMMITTED by default for other workspace transactions", async () => {
    const result = await tenantRead.withWorkspaceTenantRead(context, "/app/other", readWhileAnotherConnectionResubmits);
    expect(result.header.description).toBe("Reviewed January depreciation");
    expect(result.workflow).toEqual({ content_hash: "b".repeat(64), approval_version: 2 });
    expect(result.totals).toEqual({ debit: "20.00", credit: "20.00" });
  });
});
