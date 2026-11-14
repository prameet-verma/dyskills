import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "./run";

export { runCli } from "./run";
export type { CliOutcome } from "./run";
export type { CliEnv } from "./io";

/** True when this module is the process entry point (also through an npm bin symlink). */
function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  const out = await runCli(process.argv.slice(2));
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}
