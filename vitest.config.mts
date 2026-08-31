import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["./tests/db-integration-warning.global.ts"],
    // Integration files share one disposable PostgreSQL database in CI. Running
    // files serially prevents one suite from leasing or cleaning up another
    // suite's rows while preserving parallel work inside application code.
    fileParallelism: false,
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
