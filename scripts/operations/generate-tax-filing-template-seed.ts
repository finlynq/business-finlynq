import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderTaxFilingTemplateSeedSql } from "./tax-filing-template-seed-contract";

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  if (!manifestPath || process.argv.length !== 3) {
    throw new Error("Usage: npm run tax-templates:generate-seed -- <reviewed-template.json>");
  }
  const serialized = await readFile(resolve(manifestPath), "utf8");
  const manifest: unknown = JSON.parse(serialized);
  const generated = renderTaxFilingTemplateSeedSql(manifest);
  process.stdout.write(generated.sql);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Tax filing template generation failed");
  process.exitCode = 1;
});
