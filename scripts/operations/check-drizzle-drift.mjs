import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function normalizeCliPath(path) {
  return path.split(sep).join("/");
}

export function summarizeGeneratedMigration(sql) {
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  return statements.slice(0, 8).join("\n--> statement-breakpoint\n");
}

export function driftMessage(generatedFiles, generatedSql) {
  const preview = summarizeGeneratedMigration(generatedSql);
  return [
    "Drizzle schema drift detected.",
    `Generated files: ${generatedFiles.join(", ")}`,
    preview ? `First generated statements:\n${preview}` : "The generated snapshot changed without SQL output.",
    "Update the Drizzle declarations and reviewed forward migration together; see docs/operations/migrations.md.",
  ].join("\n");
}

export function runDrizzleDriftCheck({
  root = projectRoot,
  schemaPath = process.env.BUSINESS_FINLYNQ_DRIZZLE_SCHEMA ?? "./src/db/schema/index.ts",
} = {}) {
  const migrationRoot = join(root, "migrations", "drizzle");
  const metadataRoot = join(migrationRoot, "meta");
  const journal = JSON.parse(readFileSync(join(metadataRoot, "_journal.json"), "utf8"));
  const latest = journal.entries.at(-1);
  if (!latest || !Number.isInteger(latest.idx)) {
    throw new Error("Drizzle journal has no valid latest entry");
  }
  const latestSnapshot = join(metadataRoot, `${String(latest.idx).padStart(4, "0")}_snapshot.json`);
  if (!existsSync(latestSnapshot)) {
    throw new Error(
      `Drizzle journal ends at ${latest.tag}, but ${relative(root, latestSnapshot)} is missing`,
    );
  }

  const temporaryParent = join(root, ".tmp");
  mkdirSync(temporaryParent, { recursive: true });
  const temporaryRoot = mkdtempSync(join(temporaryParent, "drizzle-drift-"));
  try {
    cpSync(metadataRoot, join(temporaryRoot, "meta"), { recursive: true });
    const outputPath = normalizeCliPath(relative(root, temporaryRoot));
    const cliPath = join(root, "node_modules", "drizzle-kit", "bin.cjs");
    if (!existsSync(cliPath)) {
      throw new Error("drizzle-kit is not installed; run npm ci before checking schema drift");
    }
    const generated = spawnSync(
      process.execPath,
      [
        cliPath,
        "generate",
        "--dialect",
        "postgresql",
        "--schema",
        schemaPath,
        "--out",
        outputPath,
        "--name",
        "schema_drift_check",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: "true" },
        timeout: 120_000,
      },
    );
    if (generated.error) throw generated.error;
    if (generated.status !== 0) {
      throw new Error(
        [
          "drizzle-kit could not evaluate schema drift.",
          generated.stdout?.trim(),
          generated.stderr?.trim(),
        ].filter(Boolean).join("\n"),
      );
    }

    const generatedFiles = readdirSync(temporaryRoot)
      .filter((name) => name !== "meta")
      .sort();
    const latestTemporaryJournal = readFileSync(
      join(temporaryRoot, "meta", "_journal.json"),
      "utf8",
    );
    const journalChanged = latestTemporaryJournal !== readFileSync(join(metadataRoot, "_journal.json"), "utf8");
    if (generatedFiles.length > 0 || journalChanged) {
      const sqlFile = generatedFiles.find((name) => name.endsWith(".sql"));
      const generatedSql = sqlFile ? readFileSync(join(temporaryRoot, sqlFile), "utf8") : "";
      throw new Error(driftMessage(generatedFiles, generatedSql));
    }
  } finally {
    const resolvedTemporaryRoot = resolve(temporaryRoot);
    const resolvedTemporaryParent = `${resolve(temporaryParent)}${sep}`;
    if (!resolvedTemporaryRoot.startsWith(resolvedTemporaryParent)) {
      throw new Error("Refusing to remove a schema-drift directory outside the project temporary root");
    }
    rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runDrizzleDriftCheck();
    console.log("Drizzle declarations match the latest generated snapshot.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unknown Drizzle schema-drift failure");
    process.exitCode = 1;
  }
}
