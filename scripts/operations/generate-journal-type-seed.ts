import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderJournalTypeSeedSql } from "../../src/modules/ledger/journal-type-registry-contract";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifactPath = resolve(
  repositoryRoot,
  "migrations",
  "generated",
  "journal-type-definitions.sql",
);

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "--check" && mode !== "--write") {
    throw new Error("Use --check to verify or --write to update the generated journal-type seed");
  }

  const generated = renderJournalTypeSeedSql();
  if (mode === "--write") {
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, generated, "utf8");
    console.log(`Wrote ${artifactPath}`);
    return;
  }

  let current: string;
  try {
    current = await readFile(artifactPath, "utf8");
  } catch (error) {
    throw new Error(
      "The generated journal-type seed is missing; run npm run journal-types:generate-seed",
      { cause: error },
    );
  }
  if (current !== generated) {
    throw new Error(
      "The generated journal-type seed does not match the module manifests; run npm run journal-types:generate-seed and review the result",
    );
  }
  console.log("Generated journal-type seed matches the enabled module manifests.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Journal-type seed generation failed");
  process.exitCode = 1;
});
