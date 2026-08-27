export type DemoResetMode = "nightly";

export function parseDemoResetMode(
  argv: readonly string[],
  rawMode: string | undefined,
): Readonly<{ mode: DemoResetMode }> {
  if (argv.length !== 0) {
    throw new Error("demo:reset accepts no tenant, sandbox, slot, or other command-line arguments");
  }
  if (rawMode !== "nightly") {
    throw new Error("DEMO_RESET_MODE must be exactly nightly");
  }
  return { mode: rawMode };
}
