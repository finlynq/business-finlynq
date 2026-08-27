import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { isDemoTransactionAuthMethod } from "@/modules/identity/auth-provenance";
import { DemoSessionLeaseLostError } from "./errors";

export { DemoSessionLeaseLostError, isDemoSessionLeaseLostError } from "./errors";

const tenantContextInputSchema = z.object({
  organizationId: z.uuid(),
  actorId: z.uuid(),
  sessionId: z.uuid().optional(),
  sessionMode: z.enum(["real", "demo"]).optional(),
  requestId: z.string().trim().min(1).max(200),
  authMethod: z.string().trim().min(1).max(100),
  sourceSurface: z.enum(["UI", "API", "IMPORT", "WORKER", "MCP"]),
  reason: z.string().trim().min(1).max(500).optional(),
  demoWriteAuthorized: z.boolean().optional(),
});

const tenantContextSchema = tenantContextInputSchema.transform((context, issueContext) => {
  const sessionMode = context.sessionMode ??
    (isDemoTransactionAuthMethod(context.authMethod) ? "demo" : "real");
  const usesDemoAuthentication = isDemoTransactionAuthMethod(context.authMethod);

  if ((sessionMode === "demo") !== usesDemoAuthentication) {
    issueContext.addIssue({
      code: "custom",
      message: "Transaction session mode does not match its authentication method",
      path: ["sessionMode"],
    });
  }
  if (sessionMode === "demo" && !context.sessionId) {
    issueContext.addIssue({
      code: "custom",
      message: "Demo transactions require a session identifier",
      path: ["sessionId"],
    });
  }
  if (sessionMode !== "demo" && context.demoWriteAuthorized === true) {
    issueContext.addIssue({
      code: "custom",
      message: "Only demo transactions can carry demo-write authorization",
      path: ["demoWriteAuthorized"],
    });
  }

  return { ...context, sessionMode };
});

export type TenantTransactionContext = z.input<typeof tenantContextSchema>;

function isRevokedDemoLeaseDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "28000" && candidate.message === "Demo session claim is not live";
}

export function validateTenantTransactionContext(context: TenantTransactionContext) {
  return tenantContextSchema.parse(context);
}

let pool: Pool | undefined;

function databasePassword(): string | undefined {
  const passwordFile = process.env.BUSINESS_FINLYNQ_DB_PASSWORD_FILE?.trim();
  const inlinePassword = process.env.BUSINESS_FINLYNQ_DB_PASSWORD;
  if (passwordFile && inlinePassword) throw new Error("Configure only one application database-password source");
  if (!passwordFile) {
    if (inlinePassword && process.env.NODE_ENV === "production") {
      throw new Error("Production requires BUSINESS_FINLYNQ_DB_PASSWORD_FILE");
    }
    return inlinePassword;
  }

  let raw: string;
  try {
    raw = readFileSync(passwordFile, "utf8");
  } catch (error) {
    throw new Error("Unable to read the application database-password file", { cause: error });
  }
  const password = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (password.length < 24 || password.length > 1024 || /[\r\n]/.test(password) || (raw !== password && raw !== `${password}\n`)) {
    throw new Error("Application database-password file must contain one value of 24 to 1024 characters");
  }
  return password;
}

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  const host = process.env.BUSINESS_FINLYNQ_DB_HOST;

  if (!connectionString && !host) {
    throw new Error(
      "DATABASE_URL or BUSINESS_FINLYNQ_DB_HOST settings are required for database operations",
    );
  }

  pool = new Pool({
    ...(connectionString
      ? { connectionString }
      : {
          host,
          port: Number(process.env.BUSINESS_FINLYNQ_DB_PORT ?? "5432"),
          database: process.env.BUSINESS_FINLYNQ_DB_NAME,
          user: process.env.BUSINESS_FINLYNQ_DB_USER,
          password: databasePassword(),
        }),
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "business-finlynq",
  });

  return pool;
}

export async function queryDatabase<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<Row>> {
  return getPool().query<Row>(text, [...values]);
}

export async function withTenantTransaction<T>(
  untrustedContext: TenantTransactionContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const context = validateTenantTransactionContext(untrustedContext);
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SELECT set_config('app.organization_id', $1, true)", [context.organizationId]);
    await client.query("SELECT set_config('app.actor_id', $1, true)", [context.actorId]);
    await client.query("SELECT set_config('app.session_id', $1, true)", [context.sessionId ?? ""]);
    await client.query("SELECT set_config('app.session_mode', $1, true)", [context.sessionMode]);
    await client.query("SELECT set_config('app.request_id', $1, true)", [context.requestId]);
    await client.query("SELECT set_config('app.auth_method', $1, true)", [context.authMethod]);
    await client.query("SELECT set_config('app.source_surface', $1, true)", [context.sourceSurface]);
    await client.query("SELECT set_config('app.reason', $1, true)", [context.reason ?? ""]);
    await client.query("SELECT set_config('app.demo_write_authorized', $1, true)", [
      context.demoWriteAuthorized === true ? "true" : "false",
    ]);
    if (context.sessionMode === "demo") {
      // The SECURITY DEFINER assertion locks the authentication row first and
      // its sandbox slot second for this transaction's full lifetime. Reset,
      // logout, and lease handoff take those rows in the same order.
      try {
        await client.query("SELECT app.assert_current_demo_session_lease()");
      } catch (error) {
        // Translate only the assertion's exact revoked-lease result. Other
        // SQLSTATE 28000 failures (invalid context, reset due, MFA, etc.) must
        // retain their original fail-closed behavior.
        if (isRevokedDemoLeaseDatabaseError(error)) {
          throw new DemoSessionLeaseLostError({ cause: error });
        }
        throw error;
      }
    }

    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabasePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
