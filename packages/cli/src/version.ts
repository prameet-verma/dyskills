import pkg from "../package.json" with { type: "json" };

/** The CLI's published version, read from `package.json` at build time. */
export const CLI_VERSION: string = pkg.version;
