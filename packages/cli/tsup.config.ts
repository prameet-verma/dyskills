import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

/**
 * Bundles the CLI into a single ESM file with a node shebang. The workspace packages ship as
 * TypeScript source, so they are inlined (`noExternal`); third-party packages stay external and
 * are declared in this package's `dependencies`.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  clean: true,
  // The version is inlined; package.json itself never ends up in the bundle.
  define: { __CLI_VERSION__: JSON.stringify(version) },
  noExternal: [/^@dynamic-skills\//],
  banner: { js: "#!/usr/bin/env node" },
});
