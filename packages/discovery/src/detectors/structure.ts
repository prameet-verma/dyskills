import type { EvidenceInput } from "@dynamic-skills/evidence-registry";
import type { Detector, DetectorContext } from "./types";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Extension (without dot) to language name; the only languages Phase 1 reports. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  cs: "csharp",
  php: "php",
};

const MAX_LANGUAGES = 5;
const MAX_HEADINGS = 10;
/** Most entrypoint candidates reported (also bounded by a character budget); the rest are
 * summarised as "(+N more)". Priority order: package.json main/bin, root src/index.*, then by path. */
export const MAX_ENTRYPOINTS = 20;
/** Characters of entrypoint paths allowed, leaving room for "(+N more)" under the 500-char evidence limit. */
const ENTRYPOINT_VALUE_BUDGET = 470;

/** Builds an observation that is read directly from the repository (hence `verified`). */
function observe(ctx: DetectorContext, key: string, value: string, source: string): EvidenceInput {
  return {
    key,
    value,
    category: key.split(".")[0] as EvidenceInput["category"],
    source,
    confidence: "verified",
    revision: ctx.revision,
  };
}

const languageDetector: Detector = {
  id: "language",
  categories: ["language"],
  always: true,
  run(ctx) {
    const counts = new Map<string, number>();
    for (const file of ctx.files.files) {
      const dot = file.lastIndexOf(".");
      const lang = dot < 0 ? undefined : LANGUAGES[file.slice(dot + 1).toLowerCase()];
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    // Count descending, name ascending so ties are deterministic.
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return Promise.resolve(
      top
        .slice(0, MAX_LANGUAGES)
        .map(([name, n]) => observe(ctx, `language.${name}`, `${n} files`, "file index")),
    );
  },
};

const ciDetector: Detector = {
  id: "ci",
  categories: ["ci"],
  always: true,
  run(ctx) {
    const out: EvidenceInput[] = [];
    const prefix = ".github/workflows/";
    const workflows = ctx.files.files
      .filter(
        (f) => f.startsWith(prefix) && /\.ya?ml$/.test(f) && !f.slice(prefix.length).includes("/"),
      )
      .map((f) => f.slice(prefix.length))
      .sort();
    if (workflows.length > 0) {
      out.push(observe(ctx, "ci.github-actions", workflows.join(", "), ".github/workflows"));
    }
    if (ctx.files.files.includes(".gitlab-ci.yml")) {
      out.push(observe(ctx, "ci.gitlab", ".gitlab-ci.yml", ".gitlab-ci.yml"));
    }
    return Promise.resolve(out);
  },
};

/** Collects `main` and `bin` (string or name-to-path object) paths from package.json. */
async function packageEntrypoints(ctx: DetectorContext): Promise<string[]> {
  const text = await ctx.readText("package.json");
  if (text === null) return [];
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(pkg)) return [];
  const raw: unknown[] = [pkg["main"]];
  const bin = pkg["bin"];
  if (typeof bin === "string") raw.push(bin);
  else if (isObject(bin)) raw.push(...Object.values(bin));
  return raw.filter((p): p is string => typeof p === "string").map((p) => p.replace(/^\.\//, ""));
}

const architectureDetector: Detector = {
  id: "architecture",
  categories: ["architecture"],
  always: true,
  async run(ctx) {
    const out: EvidenceInput[] = [];
    const dirs = new Set<string>();
    for (const f of ctx.files.files) {
      const slash = f.indexOf("/");
      if (slash > 0) dirs.add(f.slice(0, slash));
    }
    if (dirs.size > 0) {
      out.push(
        observe(ctx, "architecture.top-level-dirs", [...dirs].sort().join(", "), "file index"),
      );
    }

    const present = new Set(ctx.files.files);
    // Most relevant first: package.json main/bin targets, root src/index.*, then the rest by path.
    const ordered: string[] = [];
    const seen = new Set<string>();
    const add = (p: string): void => {
      if (!seen.has(p)) {
        seen.add(p);
        ordered.push(p);
      }
    };
    for (const p of await packageEntrypoints(ctx)) if (present.has(p)) add(p);
    const rest = new Set<string>();
    for (const f of ctx.files.files) {
      if (/^src\/index\.[^/]+$/.test(f)) add(f);
      else if (/(?:^|\/)src\/index\.[^/]+$/.test(f)) rest.add(f);
    }
    for (const f of ["main.py", "app/main.py"]) if (present.has(f)) rest.add(f);
    for (const f of [...rest].sort()) add(f);
    if (ordered.length > 0) {
      const kept: string[] = [];
      let length = 0;
      for (const p of ordered) {
        const next = length + p.length + 2;
        if (kept.length >= MAX_ENTRYPOINTS) break;
        // A path too long for the remaining budget is skipped (and counted in "more").
        if (next > ENTRYPOINT_VALUE_BUDGET) continue;
        kept.push(p);
        length = next;
      }
      const more = ordered.length - kept.length;
      const suffix = more > 0 ? `(+${more} more)` : "";
      const value = kept.length > 0 ? [kept.join(", "), suffix].filter(Boolean).join(" ") : suffix;
      out.push(observe(ctx, "architecture.entrypoints", value, "file index"));
    }
    return out;
  },
};

/**
 * Extracts ATX headings from markdown, skipping fenced code blocks so shell comments in
 * examples are not mistaken for headings.
 */
function headings(markdown: string, limit: number): string[] {
  const found: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0] as string;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    const text = m?.[1]?.trim();
    if (text) found.push(text);
    if (found.length >= limit) break;
  }
  return found;
}

const conventionsDetector: Detector = {
  id: "conventions",
  categories: ["conventions"],
  always: true,
  async run(ctx) {
    const out: EvidenceInput[] = [];
    const present = new Set(ctx.files.files);

    // README headings are untrusted repo text: the registry sanitises the value and Task 10
    // fences it, so it is deliberately reported rather than filtered here (PRD §7).
    // The index omits symlinks and may be truncated, so fall back to the canonical name; the
    // safe reader still applies its secret, containment and size checks.
    const readmePath =
      ctx.files.files.filter((f) => f.toLowerCase() === "readme.md").sort()[0] ?? "README.md";
    const readme = await ctx.readText(readmePath);
    const hs = readme === null ? [] : headings(readme, MAX_HEADINGS);
    if (hs.length > 0) {
      out.push(observe(ctx, "conventions.readme", hs.join(" | "), readmePath));
    }

    if (present.has("CONTRIBUTING.md")) {
      out.push(observe(ctx, "conventions.contributing", "CONTRIBUTING.md", "CONTRIBUTING.md"));
    }
    const adrs = ctx.files.files.filter(
      (f) => /^(docs\/)?adr\/[^/]+$/.test(f) && /\.(md|markdown)$/i.test(f),
    );
    if (adrs.length > 0) {
      out.push(observe(ctx, "conventions.adr", `${adrs.length} ADRs`, "docs/adr"));
    }
    // Instruction files are discovery inputs, never evidence content: path only.
    if (present.has("AGENTS.md")) {
      out.push(observe(ctx, "conventions.agents-md", "AGENTS.md", "AGENTS.md"));
    }
    if (present.has("CLAUDE.md")) {
      out.push(observe(ctx, "conventions.claude-md", "CLAUDE.md", "CLAUDE.md"));
    }
    return out;
  },
};

/** Detectors that describe repository structure and conventions from the file index. */
export const STRUCTURE_DETECTORS: Detector[] = [
  languageDetector,
  ciDetector,
  architectureDetector,
  conventionsDetector,
];
