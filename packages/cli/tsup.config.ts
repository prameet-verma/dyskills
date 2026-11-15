import { defineConfig } from "tsup";

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
  noExternal: [/^@dynamic-skills\//],
  banner: { js: "#!/usr/bin/env node" },
});
