import type { Gap } from "@dynamic-skills/core";
import type { RepoFileIndex } from "@dynamic-skills/discovery";

/** A bounded investigation the agent should perform to close an `inspect` gap (PRD §6.3, FR-15). */
export interface SemanticProbe {
  /** Id of the requirement being investigated. */
  requirement: string;
  /** Short instruction for the agent. */
  question: string;
  /** Up to 5 repo-relative (shallowest first, then alphabetical) files, all present in the index, worth reading first. */
  suggestedFiles: string[];
}

const MAX_FILES = 5;

const QUESTIONS: Record<string, string> = {
  architecture: "Identify the module boundaries and data-access layer relevant to the task",
  conventions: "Summarise the coding conventions and contribution rules that apply to the task",
};

/** Well-known files that answer each category, matched by basename at any depth. */
const KNOWN_FILES: Record<string, RegExp> = {
  "package-manager":
    /^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|pnpm-workspace\.yaml|pyproject\.toml|poetry\.lock|uv\.lock)$/,
  runtime:
    /^(\.nvmrc|\.node-version|\.python-version|\.tool-versions|package\.json|pyproject\.toml)$/,
  language: /^(package\.json|tsconfig\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/,
  testing: /^(vitest\.config\..+|jest\.config\..+|pytest\.ini|pyproject\.toml|package\.json)$/,
  build: /^(package\.json|Makefile|turbo\.json|nx\.json)$/,
  monorepo: /^(pnpm-workspace\.yaml|nx\.json|turbo\.json|lerna\.json|package\.json)$/,
};

/** File matchers per category; unknown categories match files named after the category. */
function matcher(category: string): (f: string) => boolean {
  const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);
  switch (category) {
    case "architecture":
      return (f) =>
        /(^|\/)src\/(.*\/)?index\.[^/]+$/.test(f) || f === "main.py" || f === "app/main.py";
    case "conventions":
      return (f) => /^(readme|contributing)(\.[^/]+)?$/i.test(f) || /^docs\/adr\/[^/]+$/.test(f);
    case "ci":
      return (f) => /(^|\/)\.github\/workflows\/[^/]+$/.test(f) || base(f) === ".gitlab-ci.yml";
    case "database":
      return (f) =>
        base(f) === "schema.prisma" || base(f) === "alembic.ini" || /(^|\/)migrations\//.test(f);
    default: {
      const known = KNOWN_FILES[category];
      if (known) return (f) => known.test(base(f));
      const word = category.replace(/-/g, "");
      return (f) => base(f).toLowerCase().replace(/-/g, "").startsWith(word);
    }
  }
}

/** Orders shallower paths first so root manifests win when capping at {@link MAX_FILES}. */
const byDepthThenPath = (a: string, b: string): number =>
  a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Plans one probe per gap that needs repository inspection.
 *
 * @param gaps - Output of `analyzeGaps`; only `resolution === "inspect"` gaps produce probes.
 * @param files - File index; suggestions are drawn only from it so the agent never chases
 *   nonexistent paths.
 * @returns Probes in gap order.
 */
export function planSemanticProbes(gaps: Gap[], files: RepoFileIndex): SemanticProbe[] {
  return gaps
    .filter((g) => g.resolution === "inspect")
    .map((g) => ({
      requirement: g.requirement,
      question:
        QUESTIONS[g.category] ??
        `Find how the repository handles ${g.requirement} and confirm the existing evidence`,
      suggestedFiles: files.files
        .filter(matcher(g.category))
        .sort(byDepthThenPath)
        .slice(0, MAX_FILES),
    }));
}
