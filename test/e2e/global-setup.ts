import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Epoch ms at which global setup started building the CLI. */
    buildStartedAt: number;
  }
}

/** Builds the CLI once so the e2e tests can spawn `packages/cli/dist/index.js`. */
export default function setup(project: TestProject): void {
  project.provide("buildStartedAt", Date.now());
  execFileSync("pnpm", ["build"], {
    cwd: resolve(import.meta.dirname, "../.."),
    stdio: "pipe",
    timeout: 120_000,
  });
}
