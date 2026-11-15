import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Builds the CLI once so the e2e tests can spawn `packages/cli/dist/index.js`. */
export default function setup(): void {
  execFileSync("pnpm", ["build"], {
    cwd: resolve(import.meta.dirname, "../.."),
    stdio: "pipe",
    timeout: 120_000,
  });
}
