export function setup(): void {
  const missing = [
    "TEST_DATABASE_URL",
    "TEST_APP_DATABASE_URL",
    "TEST_AUTH_WORKER_DATABASE_URL",
  ].filter((name) => !process.env[name]?.trim());

  if (missing.length === 0) return;

  process.stderr.write(
    `\n[DATABASE INTEGRATION TESTS SKIPPED] Missing ${missing.join(", ")}. ` +
      "PostgreSQL/RLS/grant behavior has not been verified in this run. " +
      "See README.md#database-integration-tests.\n\n",
  );
}
