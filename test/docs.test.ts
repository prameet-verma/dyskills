import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../packages/cli/src/commands/index";

const ROOT = resolve(import.meta.dirname, "..");

/** Every registered CLI command, as the command table in `docs/cli-reference.md` must name it. */
const COMMAND_NAMES = COMMANDS.map((c) => c.name);

/** Markdown files under `dir`, recursively. */
function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return markdownFiles(full);
    return name.endsWith(".md") ? [full] : [];
  });
}

/** Adapter directories under `adapters/`. */
function adapterDirs(): string[] {
  return readdirSync(join(ROOT, "adapters")).filter((d) =>
    statSync(join(ROOT, "adapters", d)).isDirectory(),
  );
}

/** Relative link targets (fragment removed) in a markdown text; external and anchor links skipped. */
function relativeLinks(markdown: string): string[] {
  // Links inside fenced code blocks and inline code spans are examples, not links.
  const text = markdown
    .replace(/^( {0,3})(```|~~~)[^\n]*\n[\s\S]*?^\1?\2[^\n]*$/gm, "")
    // A span may wrap onto following lines (never across a blank line).
    .replace(/`[^`\n]*(?:\n[^`\n]+)*`/g, "");
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

  it("gives every adapter a README with an API section", () => {
    const dirs = adapterDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    for (const dir of dirs) {
      const readme = join(ROOT, "adapters", dir, "README.md");
      expect(existsSync(readme), `${dir} README`).toBe(true);
      expect(readFileSync(readme, "utf8"), `${dir} API heading`).toMatch(/^## API\s*$/m);
    }
  });

  it("ships a guide for every adapter", () => {
    for (const dir of adapterDirs()) {
      expect(existsSync(join(ROOT, "docs/harnesses", `${dir}.md`)), `${dir} guide`).toBe(true);
    }
  });

  it("documents every CLI command and no `evidence add`", () => {
    const text = readFileSync(join(ROOT, "docs/cli-reference.md"), "utf8");
    expect(COMMAND_NAMES.length).toBeGreaterThan(10);
    for (const command of COMMAND_NAMES) expect(text, command).toContain(`\`${command}`);
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
      ...["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "CODE_OF_CONDUCT.md"].map(
        (f) => join(ROOT, f),
      ),
      ...markdownFiles(join(ROOT, "docs")),
      ...readdirSync(join(ROOT, "packages")).map((d) => join(ROOT, "packages", d, "README.md")),
      ...adapterDirs().map((d) => join(ROOT, "adapters", d, "README.md")),
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

  it("never invokes the CLI through a package runner (Ruling R19)", () => {
    const files = [
      "skills/dynamic-skill-bootstrap/SKILL.md",
      "scripts/live-smoke.sh",
      "README.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "docs/superpowers/plans/2026-11-14-phase-1-jit-core-engine.md",
      ...markdownFiles(join(ROOT, "docs"))
        .map((f) => relative(ROOT, f))
        .filter((f) => !f.startsWith(`docs${sep}superpowers${sep}`)),
      ...readdirSync(join(ROOT, "packages")).map((d) => `packages/${d}/README.md`),
      ...adapterDirs().map((d) => `adapters/${d}/README.md`),
      ...readdirSync(join(ROOT, "scripts/live-smoke"))
        .filter((f) => f.endsWith(".sh"))
        .map((f) => `scripts/live-smoke/${f}`),
    ];
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect(text, f).not.toMatch(
        /\b(?:npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec)\s+dynamic-skills\b/,
      );
    }
  });

  it("keeps a code span that wraps a line from hiding a prose link", () => {
    const text = "Use `a\nb` then [guide](docs/x.md) and `c` and [other](y.md).";
    expect(relativeLinks(text)).toEqual(["docs/x.md", "y.md"]);
  });
});
