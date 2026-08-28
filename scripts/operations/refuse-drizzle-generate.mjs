console.error(
  [
    "Automatic Drizzle migration generation is disabled for this repository.",
    "The canonical journal contains reviewed hand-authored migrations newer than the last generated snapshot.",
    "Create a forward-only SQL migration and matching monotonic journal entry, then verify fresh and upgrade replay on a disposable PostgreSQL database.",
  ].join("\n"),
);
process.exitCode = 1;
