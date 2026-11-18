import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

const ADRS = [
  "docs/adr/0007-harness-adapter-interface.md",
  "docs/adr/0008-read-first-activation.md",
  "docs/adr/0009-opencode-dual-line.md",
  "docs/adr/0010-structured-question-options.md",
  "docs/adr/0011-npm-distribution.md",
];
const GUIDE = "docs/adapters/authoring.md";

describe("Phase 2 documentation", () => {
  it("ships ADRs 0007 to 0011 and the adapter authoring guide", () => {
    for (const f of [...ADRS, GUIDE]) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });

  it("gives every Phase 2 ADR the four headings", () => {
    for (const f of ADRS) {
      const text = readFileSync(join(ROOT, f), "utf8");
      for (const heading of ["Status", "Context", "Decision", "Consequences"]) {
        expect(text, `${f} ${heading}`).toMatch(new RegExp(`^## ${heading}\\s*$`, "m"));
      }
    }
  });

  it("never invokes the CLI through a package runner in the new files (Ruling R19)", () => {
    for (const f of [...ADRS, GUIDE, "docs/architecture.md"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(
        /\b(?:npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec)\s+dynamic-skills\b/,
      );
    }
  });
});
