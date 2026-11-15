import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

/** Every CLI command, as the command table in `docs/cli-reference.md` must name it. */
const COMMANDS = [
  "assess",
  "discover",
  "context request",
  "context submit",
  "sufficiency submit",
  "sufficiency approve",
  "clarify ask",
  "clarify answer",
  "compile",
  "evaluate",
  "eval record",
  "activate",
  "status",
  "clean",
  "report perf",
];

/**
 * Markdown files under `dir`, recursively. `docs/superpowers` (planning documents that quote
 * example links in code samples) is not product documentation and is skipped.
 */
function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "superpowers" ? [] : markdownFiles(full);
    return name.endsWith(".md") ? [full] : [];
  });
}

/** Relative link targets (fragment removed) in a markdown text; external and anchor links skipped. */
function relativeLinks(text: string): string[] {
  const targets: string[] = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1] as string;
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split("#")[0] as string;
    if (path !== "") targets.push(path);
  }
  return targets;
}

describe("documentation set", () => {
  it("gives every package a README with an API section", () => {
    const dirs = readdirSync(join(ROOT, "packages")).filter((d) =>
      statSync(join(ROOT, "packages", d)).isDirectory(),
    );
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const readme = join(ROOT, "packages", dir, "README.md");
      expect(existsSync(readme), `${dir} README`).toBe(true);
      expect(readFileSync(readme, "utf8"), `${dir} API heading`).toMatch(/^## API\s*$/m);
    }
  });

  it("documents every CLI command and no `evidence add`", () => {
    const text = readFileSync(join(ROOT, "docs/cli-reference.md"), "utf8");
    for (const command of COMMANDS) expect(text, command).toContain(`\`${command}`);
    expect(text).not.toContain("evidence add");
  });

  it("ships ADRs 0004 and 0005", () => {
    for (const f of [
      "docs/adr/0004-hybrid-discovery-contracts.md",
      "docs/adr/0005-sufficiency-and-augmentation.md",
    ]) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
    }
  });

  it("keeps every relative markdown link resolvable", () => {
    const files = [
      join(ROOT, "README.md"),
      join(ROOT, "CONTRIBUTING.md"),
      ...markdownFiles(join(ROOT, "docs")),
    ];
    const broken: string[] = [];
    for (const file of files) {
      for (const target of relativeLinks(readFileSync(file, "utf8"))) {
        if (!existsSync(resolve(dirname(file), target))) broken.push(`${file}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("indexes every ADR in docs/adr/README.md", () => {
    const index = readFileSync(join(ROOT, "docs/adr/README.md"), "utf8");
    const adrs = readdirSync(join(ROOT, "docs/adr")).filter((f) => /^\d{4}-.*\.md$/.test(f));
    expect(adrs.length).toBeGreaterThanOrEqual(5);
    for (const adr of adrs) expect(index, adr).toContain(adr);
  });
});
