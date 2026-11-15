import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSchemas } from "../packages/core/src/index";

/** Re-exported so existing callers and tests keep a stable import path. */
export { generateSchemas };

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
  mkdirSync(outDir, { recursive: true });
  for (const [file, schema] of Object.entries(generateSchemas())) {
    writeFileSync(resolve(outDir, file), JSON.stringify(schema, null, 2) + "\n");
  }
}
