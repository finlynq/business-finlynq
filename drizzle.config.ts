import { defineConfig } from "drizzle-kit";

// Schema generation is offline. Migration execution must still provide the
// real DATABASE_MIGRATION_URL; the fallback must never be a valid deployment.
function migrationConnectionUrl(): string {
  if (process.env.DATABASE_MIGRATION_URL) return process.env.DATABASE_MIGRATION_URL;

  const host = process.env.BUSINESS_FINLYNQ_MIGRATION_DB_HOST;
  if (!host) {
    return "postgresql://offline-generation:offline-generation@127.0.0.1:1/offline-generation";
  }

  const url = new URL("postgresql://placeholder/placeholder");
  url.hostname = host;
  url.port = process.env.BUSINESS_FINLYNQ_MIGRATION_DB_PORT ?? "5432";
  url.pathname = `/${process.env.BUSINESS_FINLYNQ_MIGRATION_DB_NAME ?? "business_finlynq"}`;
  url.username = process.env.BUSINESS_FINLYNQ_MIGRATION_DB_USER ?? "business_finlynq_owner";
  url.password = process.env.BUSINESS_FINLYNQ_MIGRATION_DB_PASSWORD ?? "";
  return url.toString();
}

const migrationUrl = migrationConnectionUrl();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./migrations/drizzle",
  dbCredentials: {
    url: migrationUrl,
  },
  strict: true,
  verbose: true,
});
