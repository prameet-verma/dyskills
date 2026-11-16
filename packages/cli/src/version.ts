import { readFileSync } from "node:fs";

/** Replaced by the build (`tsup` `define`) with the package version; undefined when run from source. */
declare const __CLI_VERSION__: string | undefined;

/** Reads the version from `package.json` next to `src/` (source runs, i.e. tests). */
function readPackageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

/** The CLI's published version: injected at build time, read from `package.json` from source. */
export const CLI_VERSION: string =
  typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : readPackageVersion();
