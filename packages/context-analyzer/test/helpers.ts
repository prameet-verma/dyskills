import { resolve } from "node:path";

/** Absolute path of a fixture repository under `fixtures/repos`. */
export const fixture = (name: string): string =>
  resolve(import.meta.dirname, "../../../fixtures/repos", name);
