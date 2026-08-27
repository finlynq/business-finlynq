export type DemoResetMode = "incremental" | "nightly";

export function parseDemoResetMode(
  argv: readonly string[],
  rawMode: string | undefined,
): Readonly<{ nightly: boolean; mode: DemoResetMode }> {
  if (argv.length !== 0) {
    throw new Error("demo:reset accepts no tenant, sandbox, slot, or other command-line arguments");
  }
  if (rawMode !== "incremental" && rawMode !== "nightly") {
    throw new Error("DEMO_RESET_MODE must be exactly incremental or nightly");
  }
  return { mode: rawMode, nightly: rawMode === "nightly" };
}
