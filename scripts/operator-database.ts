import type { PoolConfig } from "pg";

export function operatorDatabaseConfig(): PoolConfig {
  const host = process.env.BUSINESS_FINLYNQ_MIGRATION_DB_HOST?.trim();
  if (host) {
    const database = process.env.BUSINESS_FINLYNQ_MIGRATION_DB_NAME?.trim();
    const user = process.env.BUSINESS_FINLYNQ_MIGRATION_DB_USER?.trim();
    const password = process.env.BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD;
    const port = Number(process.env.BUSINESS_FINLYNQ_MIGRATION_DB_PORT ?? "5432");
    if (!database || !user || password === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Complete and valid BUSINESS_FINLYNQ_MIGRATION_DB_* settings are required");
    }
    return { host, port, database, user, password };
  }

  const connectionString = process.env.DATABASE_MIGRATION_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_MIGRATION_URL or BUSINESS_FINLYNQ_MIGRATION_DB_* settings are required");
  }
  return { connectionString };
}
