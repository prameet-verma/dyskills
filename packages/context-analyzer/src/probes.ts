import type { Gap } from "@dynamic-skills/core";
import type { RepoFileIndex } from "@dynamic-skills/discovery";

/** A bounded investigation the agent should perform to close an `inspect` gap (PRD §6.3). */
export interface SemanticProbe {
  /** Id of the requirement being investigated. */
  requirement: string;
  /** Short instruction for the agent. */
  question: string;
  /** Up to 5 sorted repo-relative files, all present in the index, worth reading first. */
  suggestedFiles: string[];
}

const MAX_FILES = 5;

const QUESTIONS: Record<string, string> = {
  architecture: "Identify the module boundaries and data-access layer relevant to the task",
  conventions: "Summarise the coding conventions and contribution rules that apply to the task",
};

/** File-name matchers per category; the default matches files named after the category. */
function matcher(category: string): (f: string) => boolean {
  const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);
  switch (category) {
    case "architecture":
      return (f) =>
        /(^|\/)src\/(.*\/)?index\.[^/]+$/.test(f) || f === "main.py" || f === "app/main.py";
    case "conventions":
      return (f) => /^(readme|contributing)(\.[^/]+)?$/i.test(f) || /^docs\/adr\/[^/]+$/.test(f);
    default: {
      const word = category.replace(/-/g, "");
      return (f) => base(f).toLowerCase().replace(/-/g, "").startsWith(word);
    }
  }
}

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
      suggestedFiles: files.files.filter(matcher(g.category)).sort().slice(0, MAX_FILES),
    }));
}
