import type { Evidence } from "@dynamic-skills/core";
import { KNOWN_FRAMEWORKS } from "@dynamic-skills/discovery";
import {
  AUGMENTATION_OPTIONAL_SECTIONS,
  AUGMENTATION_REQUIRED_SECTIONS,
  PROJECT_CONTEXT_SECTION,
  REQUIRED_SECTIONS,
} from "@dynamic-skills/skill-compiler";
import type { EvalContext, EvalRun, GenerationEval } from "../types";

/** Builds the result: `fail` if any failure, else `warning` if any warning, else `pass`. */
function result(failures: string[], warnings: string[] = []): EvalRun {
  const outcome = failures.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass";
  return { outcome, messages: [...failures, ...warnings] };
}

/** The three citation kinds a skill body may carry (PRD §6.6). */
interface Citations {
  evidence: string[];
  inferred: string[];
  assumption: string[];
}

/**
 * Citation scanner. The shared `CITATION_PATTERN` family allows unbounded whitespace before the
 * reference, which backtracks quadratically on agent-written text such as `[evidence:` followed
 * by a long run of spaces. This pattern has no nested quantifier and caps the reference at 200
 * characters, so a scan is linear in the text length.
 */
const CITATION_SCAN = /\[(evidence|inferred|assumption):([^\]\n]{1,200})\]/g;

/** Extracts every citation in `text`, trimmed, in document order (duplicates kept). */
function citationsIn(text: string): Citations {
  const out: Citations = { evidence: [], inferred: [], assumption: [] };
  for (const m of text.matchAll(CITATION_SCAN)) {
    const ref = (m[2] ?? "").trim();
    if (ref !== "") out[m[1] as keyof Citations].push(ref);
  }
  return out;
}

/** True when `text` holds at least one citation of any kind. */
function hasCitation(text: string): boolean {
  const c = citationsIn(text);
  return c.evidence.length + c.inferred.length + c.assumption.length > 0;
}

/** Evidence indexed by key. */
function byKey(evidence: Evidence[]): Map<string, Evidence> {
  return new Map(evidence.map((e) => [e.key, e]));
}

/** A `## ` section of a Markdown body. */
interface Section {
  heading: string;
  lines: string[];
}

/**
 * Splits a body into its `## ` sections, ignoring headings inside fenced code blocks. Lines
 * before the first `## ` heading are dropped.
 */
function sectionsOf(body: string): Section[] {
  const sections: Section[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^##[ \t]+(\S.*?)[ \t]*$/.exec(line);
    if (heading) sections.push({ heading: heading[1] ?? "", lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  return sections;
}

/** True when a section has at least one non-empty line. */
function nonEmpty(section: Section | undefined): boolean {
  return section !== undefined && section.lines.some((l) => l.trim() !== "");
}

/** First section with the given heading (case-insensitive), or undefined. */
function findSection(sections: Section[], heading: string): Section | undefined {
  return sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase());
}

/**
 * Grounding (PRD §6.6, §9.1, mandatory): every citation resolves to existing, non-conflicting
 * evidence or a recorded assumption, and every `## Project context` bullet carries a citation.
 * Whether a tag matches the evidence confidence is left to {@link evidenceClassificationEval}.
 */
export const groundingEval: GenerationEval = {
  id: "grounding",
  mandatory: true,
  async run(ctx) {
    const failures: string[] = [];
    const evidence = byKey(ctx.evidence);
    const cites = citationsIn(ctx.skill.body);
    for (const key of new Set([...cites.evidence, ...cites.inferred])) {
      const found = evidence.get(key);
      if (!found) failures.push(`unknown evidence ${key}`);
      else if (found.confidence === "conflicting")
        failures.push(`cites conflicting evidence ${key}`);
    }
    const ids = new Set(ctx.assumptions.map((a) => a.questionId));
    for (const id of new Set(cites.assumption)) {
      if (!ids.has(id)) failures.push(`unknown assumption ${id}`);
    }
    const section = findSection(sectionsOf(ctx.skill.body), PROJECT_CONTEXT_SECTION);
    for (const line of section?.lines ?? []) {
      if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line) && !hasCitation(line)) {
        failures.push(`uncited project claim: ${line.trim().slice(0, 80)}`);
      }
    }
    return result(failures);
  },
};

/**
 * Evidence classification (PRD §6.6, mandatory): an inference or assumption must not be stated
 * as an established repository fact. Tags on unknown or conflicting keys are ignored here
 * because grounding already fails them.
 */
export const evidenceClassificationEval: GenerationEval = {
  id: "evidence-classification",
  mandatory: true,
  async run(ctx) {
    const failures: string[] = [];
    const warnings: string[] = [];
    const evidence = byKey(ctx.evidence);
    const cites = citationsIn(ctx.skill.body);
    for (const key of new Set(cites.evidence)) {
      const c = evidence.get(key)?.confidence;
      if (c === "inferred" || c === "assumed") failures.push(`states inference ${key} as fact`);
    }
    for (const key of new Set(cites.inferred)) {
      if (evidence.get(key)?.confidence === "verified") {
        warnings.push(`${key} is verified; cite it as [evidence: ${key}]`);
      }
    }
    return result(failures, warnings);
  },
};

/** Version-like token (PRD §9.1). The optional group is bounded, so the scan is linear. */
const VERSION = /\b\d+\.\d+(?:\.\d+)?\b/g;

/**
 * Word-match patterns for framework names. `next` and `koa` are ordinary words or short, so
 * `next` only counts as `Next.js`/`nextjs`; scoped names match their scope-less spelling.
 */
function frameworkPattern(name: string): RegExp {
  if (name === "next") return /\bnext\.?js\b/i;
  const bare = name.replace(/^@[^/]+\//, "");
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

/**
 * Assumptions (PRD §9.1): version numbers must come from evidence or a recorded assumption
 * (fail); a known framework named without `framework.<name>` evidence is a warning.
 */
export const assumptionsEval: GenerationEval = {
  id: "assumptions",
  mandatory: false,
  async run(ctx) {
    const failures: string[] = [];
    const warnings: string[] = [];
    const support = [
      ...ctx.evidence.map((e) => e.value),
      ...ctx.assumptions.flatMap((a) => [a.assumption, a.basis, a.question]),
    ].join("\n");
    const supported = new Set(support.match(VERSION) ?? []);
    for (const v of new Set(ctx.skill.body.match(VERSION) ?? [])) {
      if (!supported.has(v)) failures.push(`unsupported version claim ${v}`);
    }
    const keys = new Set(ctx.evidence.map((e) => e.key));
    for (const name of KNOWN_FRAMEWORKS) {
      const bare = name.replace(/^@[^/]+\//, "");
      if (frameworkPattern(name).test(ctx.skill.body) && !keys.has(`framework.${bare}`)) {
        warnings.push(`mentions framework ${bare} without framework.${bare} evidence`);
      }
    }
    return result(failures, warnings);
  },
};

/**
 * Completeness (PRD §9.1): every gap the repository could answer is reflected in the skill, and
 * every user-supplied fact is used. Applies unchanged to an augmentation, whose `## Project
 * context` must hold the repository facts because the base carries none.
 */
export const completenessEval: GenerationEval = {
  id: "completeness",
  mandatory: false,
  async run(ctx) {
    const failures: string[] = [];
    const warnings: string[] = [];
    const evidence = byKey(ctx.evidence);
    const cites = citationsIn(ctx.skill.body);
    const cited = new Set([...cites.evidence, ...cites.inferred]);
    const citedCategories = new Set<string>();
    for (const key of cited) {
      const e = evidence.get(key);
      if (e) citedCategories.add(e.category);
    }
    const missing = new Set<string>();
    for (const gap of ctx.gaps) {
      if (
        (gap.status === "verified" || gap.status === "needs-investigation") &&
        !citedCategories.has(gap.category)
      ) {
        missing.add(gap.category);
      }
    }
    if (missing.size > 0) {
      warnings.push(`no evidence cited for categories: ${[...missing].join(", ")}`);
    }
    for (const e of ctx.evidence) {
      if (e.key.startsWith("user.") && !cited.has(e.key)) {
        failures.push(`user-supplied evidence ${e.key} is not cited`);
      }
    }
    return result(failures, warnings);
  },
};

/** Words too common to show that a description matches the task. */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "are",
  "was",
  "has",
  "have",
  "will",
  "all",
  "any",
  "can",
  "use",
  "uses",
  "using",
  "your",
  "its",
  "our",
  "their",
  "not",
  "but",
  "how",
  "what",
  "when",
  "where",
  "which",
  "implement",
  "implements",
  "add",
  "make",
  "skill",
  "task",
]);

/** Lowercase alphanumeric tokens of at least three characters that are not stopwords. */
function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** Scope (PRD §9.1): the description must share a content word with the task. */
export const scopeEval: GenerationEval = {
  id: "scope",
  mandatory: false,
  async run(ctx) {
    const task = contentTokens(ctx.task);
    const shared = [...contentTokens(ctx.skill.description)].some((t) => task.has(t));
    return shared ? result([]) : result(["description shares no meaningful term with the task"]);
  },
};

/**
 * Role (PRD §8.1, §5.5): a new skill carries the five role sections; an augmentation carries only
 * its task contract, project context and optional additions and defers the role to its base.
 */
export const roleEval: GenerationEval = {
  id: "role",
  mandatory: false,
  async run(ctx) {
    const sections = sectionsOf(ctx.skill.body);
    const failures: string[] = [];
    if (ctx.augmentation === null) {
      const missing = REQUIRED_SECTIONS.filter((h) => !nonEmpty(findSection(sections, h)));
      if (missing.length > 0) failures.push(`missing or empty sections: ${missing.join(", ")}`);
      return result(failures);
    }
    const allowed = [...AUGMENTATION_REQUIRED_SECTIONS, ...AUGMENTATION_OPTIONAL_SECTIONS];
    const missing = AUGMENTATION_REQUIRED_SECTIONS.filter(
      (h) => !nonEmpty(findSection(sections, h)),
    );
    if (missing.length > 0) failures.push(`missing or empty sections: ${missing.join(", ")}`);
    const contract = findSection(sections, "Task contract")?.lines ?? [];
    const covered = `- Already covered by ${ctx.augmentation.baseName}:`;
    if (!contract.some((l) => l.trimStart().startsWith(covered))) {
      failures.push(`## Task contract needs a line starting "${covered}"`);
    }
    if (!contract.some((l) => l.trimStart().startsWith("- Adds:"))) {
      failures.push('## Task contract needs a line starting "- Adds:"');
    }
    const extra = sections.filter(
      (s) => !allowed.some((h) => h.toLowerCase() === s.heading.toLowerCase()),
    );
    if (extra.length > 0) {
      failures.push(
        `augmentation may only contain sections: ${allowed.join(", ")} (found: ${extra.map((s) => s.heading).join(", ")})`,
      );
    }
    return result(failures);
  },
};

/** Words per shingle (PRD §9.1). */
const SHINGLE_WORDS = 8;
const GENERIC_FAIL = 0.6;
const GENERIC_WARN = 0.3;
// PRD §5.5: an augmentation "must be low" in overlap with its base.
const BASE_FAIL = 0.3;
const BASE_WARN = 0.15;

/** Removes a leading `---` frontmatter block, if any. */
function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** The set of 8-word shingles of the lowercased alphanumeric tokens of `text`. */
function shingles(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "");
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= tokens.length; i++) {
    out.add(tokens.slice(i, i + SHINGLE_WORDS).join(" "));
  }
  return out;
}

/** |A ∩ B| / |denominator|, 0 when either set is empty. */
function containment(a: Set<string>, b: Set<string>, denominator: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const s of small) if (large.has(s)) shared++;
  return shared / denominator.size;
}

/**
 * Duplication (PRD §9.1, §5.5): the skill's shingles must not be largely contained in an existing
 * skill or instruction text (skill-side containment); an augmentation must additionally not copy
 * its base (base-side containment, since a small base pasted into a larger overlay scores low
 * skill-side).
 */
export const duplicationEval: GenerationEval = {
  id: "duplication",
  mandatory: false,
  async run(ctx) {
    const mine = shingles(stripFrontmatter(ctx.skill.body));
    const others = [
      ...ctx.existingSkills.map((s) => ({ label: `skill ${s.name}`, text: s.body })),
      ...ctx.instructionTexts.map((t, i) => ({ label: `instruction text ${i + 1}`, text: t })),
    ];
    if (others.length === 0 && ctx.augmentation === null) {
      return { outcome: "not-applicable", messages: ["nothing to compare against"] };
    }
    const failures: string[] = [];
    const warnings: string[] = [];
    for (const o of others) {
      const c = containment(mine, shingles(stripFrontmatter(o.text)), mine);
      const pct = `${Math.round(c * 100)}%`;
      if (c >= GENERIC_FAIL) failures.push(`${pct} of the skill duplicates ${o.label}`);
      else if (c >= GENERIC_WARN) warnings.push(`${pct} of the skill overlaps ${o.label}`);
    }
    if (ctx.augmentation !== null) {
      const base = shingles(stripFrontmatter(ctx.augmentation.baseBody));
      const c = containment(mine, base, base);
      const pct = `${Math.round(c * 100)}%`;
      const name = ctx.augmentation.baseName;
      if (c >= BASE_FAIL) failures.push(`copies the base skill ${name} (${pct} of it)`);
      else if (c >= BASE_WARN) warnings.push(`overlaps the base skill ${name} (${pct} of it)`);
    }
    return result(failures, warnings);
  },
};

/**
 * Behavioural definition (PRD §9.2, mandatory): a smoke eval must exist with at least one
 * prohibited behaviour and one assertion or rubric item, so activation can be tested later.
 */
export const behaviouralDefinitionEval: GenerationEval = {
  id: "behavioural-definition",
  mandatory: true,
  async run(ctx: EvalContext) {
    const smoke = ctx.smokeEval;
    if (smoke === null) return result(["no smoke eval defined"]);
    const failures: string[] = [];
    if (smoke.prohibited.length === 0) failures.push("smoke eval lists no prohibited behaviour");
    if (smoke.assertions.length + smoke.rubric.length === 0) {
      failures.push("smoke eval has no assertion or rubric item");
    }
    return result(failures);
  },
};
