import type { Evidence } from "@dynamic-skills/core";
import { KNOWN_FRAMEWORKS } from "@dynamic-skills/discovery";
import {
  ASSUMPTION_PATTERN,
  AUGMENTATION_OPTIONAL_SECTIONS,
  AUGMENTATION_REQUIRED_SECTIONS,
  CITATION_PATTERN,
  INFERENCE_PATTERN,
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

/** Extracts every well-formed citation in `text`, in document order (duplicates kept). */
function citationsIn(text: string): Citations {
  const grab = (re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1] ?? "");
  return {
    evidence: grab(CITATION_PATTERN),
    inferred: grab(INFERENCE_PATTERN),
    assumption: grab(ASSUMPTION_PATTERN),
  };
}

/** True when `text` holds at least one well-formed citation of any kind. */
function hasCitation(text: string): boolean {
  const c = citationsIn(text);
  return c.evidence.length + c.inferred.length + c.assumption.length > 0;
}

/** Anything that opens like a citation, tolerating case and padding; linear (bounded `\s`). */
const OPENER = /\[\s{0,8}(?:evidence|inferred|assumption)\s{0,8}:/gi;

/**
 * Openers that are not the start of a well-formed citation (wrong case, padding, several keys,
 * oversized key, missing `]`). Without this, a malformed tag would be silently uncited and could
 * smuggle a claim past grounding (PRD §6.6). Returns up to 40 sanitised characters of each.
 */
function malformedCitations(text: string): string[] {
  const starts = new Set<number>();
  for (const re of [CITATION_PATTERN, INFERENCE_PATTERN, ASSUMPTION_PATTERN]) {
    for (const m of text.matchAll(re)) starts.add(m.index);
  }
  // Zero-width characters and emphasis markers are stripped only for opener detection, so
  // `[**evidence**: k]` or a zero-width-split tag is seen as an opener but is never well-formed.
  let flat = "";
  const origin: number[] = [];
  let at = 0;
  for (const ch of text) {
    if (!/[\p{Cf}*_]/u.test(ch)) {
      for (let i = 0; i < ch.length; i++) origin.push(at + i);
      flat += ch;
    }
    at += ch.length;
  }
  const out: string[] = [];
  for (const m of flat.matchAll(OPENER)) {
    const from = origin[m.index] ?? 0;
    if (!starts.has(from)) {
      out.push(text.slice(from, from + 40).replace(/[^\x20-\x7e]/g, " "));
    }
  }
  return out;
}

/** Evidence indexed by key. */
function byKey(evidence: Evidence[]): Map<string, Evidence> {
  return new Map(evidence.map((e) => [e.key, e]));
}

/** One body line and whether it sits inside a closed fenced code block. */
interface Line {
  text: string;
  fenced: boolean;
}

/**
 * A level-1 or level-2 section of a Markdown body; `heading` is normalised (see
 * {@link normaliseHeading}). Level 3-6 headings stay inside their parent section as lines (so
 * grounding still sees the bullets under them) and are also listed in `subheadings`.
 */
interface Section {
  heading: string;
  lines: Line[];
  subheadings: string[];
}

/** Heading comparison form: trimmed, lowercase, trailing `:` removed (PRD §8.1). */
function normaliseHeading(h: string): string {
  // A loop, not `/:+$/`: that regex is quadratic on a long colon run that does not end the heading.
  let s = h.trim().toLowerCase();
  while (s.endsWith(":")) s = s.slice(0, -1);
  return s.trim();
}

/**
 * Splits a body into sections at every heading CommonMark accepts: ATX (`#` to `######`, up to
 * three spaces of indent) and setext (a paragraph underlined by `===` or `---`), so no heading
 * form can slip past the augmentation allow-list. The one exemption is a leading level-1 heading
 * (the document title), which opens no section. Headings inside fenced code blocks do not count.
 * Fence rules are stricter than skill-compiler's `stripFences`: at most three spaces of indent,
 * no backtick in a backtick fence's info string, and closing on the same character with at least
 * the opening length. A fence still open at the end of the text is treated as not fenced so it
 * cannot hide later sections. Lines before the first section are dropped.
 */
function sectionsOf(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const fenced: boolean[] = new Array<boolean>(lines.length).fill(false);
  let open: { run: string; at: number } | null = null;
  lines.forEach((line, i) => {
    // CommonMark: at most three spaces of indent; only an opening fence may carry an info
    // string, and a backtick fence's info string may not contain a backtick.
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const run = m?.[1] ?? "";
    const rest = m === null ? "" : line.slice(m[0].length);
    const bare = m !== null && rest.trim() === "";
    if (open === null) {
      if (run !== "" && !(run.startsWith("`") && rest.includes("`"))) open = { run, at: i };
    } else if (bare && run[0] === open.run[0] && run.length >= open.run.length) {
      for (let j = open.at; j <= i; j++) fenced[j] = true;
      open = null;
    }
  });
  // A setext heading is a run of contiguous paragraph lines underlined by `===` or `---`; its
  // text is the run joined with spaces. Both underline kinds count, so a setext heading cannot
  // slip a section past the augmentation allow-list. One forward pass: `start` is the first line
  // of the current paragraph run, so each line is looked at a constant number of times.
  const setextText = new Map<number, { text: string; level: number }>(); // first line -> heading
  const consumed = new Set<number>(); // every line of a setext heading, underline included
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const underline = /^ {0,3}(?:=+|-+)[ \t]*$/.test(line);
    if (fenced[i] === true) {
      start = -1;
    } else if (underline && start >= 0) {
      const text = lines
        .slice(start, i)
        .map((l) => l.trim())
        .join(" ");
      setextText.set(start, { text, level: line.trimStart().startsWith("=") ? 1 : 2 });
      for (let j = start; j <= i; j++) consumed.add(j);
      start = -1;
    } else if (
      line.trim() === "" ||
      underline ||
      // Only a non-empty bullet or an ordered item starting at 1 may interrupt a paragraph.
      /^ {0,3}(?:>|#{1,6}(?:[ \t]|$)|(?:[-*+]|1[.)])[ \t]+\S|(?:[-*_][ \t]*){3,}$)/.test(line)
    ) {
      start = -1;
    } else if (start < 0 && /^ {0,3}\S/.test(line)) {
      start = i;
    }
  }
  const sections: Section[] = [];
  let titled = false; // a leading level-1 heading is the title and opens no section
  const openSection = (heading: string, level: number): void => {
    if (level === 1 && sections.length === 0 && !titled) titled = true;
    else sections.push({ heading: normaliseHeading(heading), lines: [], subheadings: [] });
  };
  lines.forEach((text, i) => {
    const setext = setextText.get(i);
    if (setext !== undefined) {
      openSection(setext.text, setext.level);
      return;
    }
    if (consumed.has(i)) return;
    const isFenced = fenced[i] === true;
    const atx = isFenced ? null : /^ {0,3}(#{1,6})(?:[ \t]+([\s\S]*))?$/.exec(text);
    const level = (atx?.[1] ?? "").length;
    const current = sections.at(-1);
    if (atx && level >= 3 && current !== undefined) {
      // A subheading belongs to its parent section; it is still checked by the allow-list.
      current.subheadings.push(normaliseHeading(atxText(atx[2] ?? "")));
      current.lines.push({ text, fenced: false });
    } else if (atx) openSection(atxText(atx[2] ?? ""), level);
    else current?.lines.push({ text, fenced: isFenced });
  });
  return sections;
}

/** ATX heading text: trimmed, without a closing `#` run (which must follow a space). */
function atxText(raw: string): string {
  let t = raw.trim();
  let end = t.length;
  while (end > 0 && t[end - 1] === "#") end--;
  if (end === 0 || t[end - 1] === " " || t[end - 1] === "\t") t = t.slice(0, end).trim();
  return t;
}

/** Every section with the given heading (any case, optional trailing colon). */
function findSections(sections: Section[], heading: string): Section[] {
  const want = normaliseHeading(heading);
  return sections.filter((s) => s.heading === want);
}

/** True when some section with that heading has at least one non-empty line. */
function hasContent(sections: Section[], heading: string): boolean {
  return findSections(sections, heading).some((s) => s.lines.some((l) => l.text.trim() !== ""));
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
    for (const bad of malformedCitations(ctx.skill.body)) {
      failures.push(`malformed citation near: ${bad}`);
    }
    // Every Project context section counts, so a second one cannot hold uncited claims.
    for (const section of findSections(sectionsOf(ctx.skill.body), PROJECT_CONTEXT_SECTION)) {
      for (const { text, fenced } of section.lines) {
        if (!fenced && /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(text) && !hasCitation(text)) {
          failures.push(`uncited project claim: ${text.trim().slice(0, 80)}`);
        }
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

/**
 * Version-like token (PRD §9.1): `1.2` or `1.2.3`, optionally `v`-prefixed. Not preceded by a word
 * character, dot or `§` (so `§6.6` and the tail of `192.168.1.1` are skipped) and not followed by a
 * word character or another dotted number (so four-part quads are skipped; a sentence-ending dot is
 * fine). Any other dotted number such as `2.0 tokens` is still version-shaped and is flagged unless
 * evidence supports it.
 */
const VERSION = /(?<![\w.§])v?(\d+\.\d+(?:\.\d+)?)(?!\w|\.\d)/g;

/** Dotted numbers in support text; deliberately looser than {@link VERSION}. */
const SUPPORT_VERSION = /(?<!\d)\d+(?:\.\d+)+/g;

/**
 * Word patterns for framework names. Scoped packages use explicit aliases so the generic word
 * `core` never matches; `next` only counts as Next.js because the bare word is ordinary English.
 */
const FRAMEWORK_WORDS: Record<string, RegExp> = {
  next: /\bnext\.?js\b/i,
  "@angular/core": /\bangular\b/i,
  "@nestjs/core": /\bnest(?:js)?\b/i,
};

/** Word pattern for a known framework name. */
function frameworkPattern(name: string): RegExp {
  return (
    FRAMEWORK_WORDS[name] ?? new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
  );
}

/**
 * Assumptions (PRD §9.1): a version in the body must equal, or be a dotted prefix of (`20.11` for
 * `20.11.0`), a version in non-conflicting evidence or in a recorded assumption (fail); a known
 * framework named without exactly `framework.<name>` evidence is a warning. Assumption
 * `question` text is not support, because it may quote claims it asks about.
 */
export const assumptionsEval: GenerationEval = {
  id: "assumptions",
  mandatory: false,
  async run(ctx) {
    const failures: string[] = [];
    const warnings: string[] = [];
    const support = [
      ...ctx.evidence.filter((e) => e.confidence !== "conflicting").map((e) => e.value),
      ...ctx.assumptions.flatMap((a) => [a.assumption, a.basis, a.impact]),
    ].join("\n");
    // Every supported version plus each dotted prefix, so a lookup is O(1).
    const supported = new Set<string>();
    for (const k of support.match(SUPPORT_VERSION) ?? []) {
      supported.add(k);
      for (let i = k.indexOf("."); i !== -1; i = k.indexOf(".", i + 1))
        supported.add(k.slice(0, i));
    }
    const supports = (v: string): boolean => supported.has(v);
    const claimed = new Set([...ctx.skill.body.matchAll(VERSION)].map((m) => m[1] ?? ""));
    for (const v of claimed) {
      if (!supports(v)) failures.push(`unsupported version claim ${v}`);
    }
    const keys = new Set(ctx.evidence.map((e) => e.key));
    for (const name of KNOWN_FRAMEWORKS) {
      if (frameworkPattern(name).test(ctx.skill.body) && !keys.has(`framework.${name}`)) {
        warnings.push(`mentions framework ${name} without framework.${name} evidence`);
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
      const missing = REQUIRED_SECTIONS.filter((h) => !hasContent(sections, h));
      if (missing.length > 0) failures.push(`missing or empty sections: ${missing.join(", ")}`);
      return result(failures);
    }
    const allowed = [...AUGMENTATION_REQUIRED_SECTIONS, ...AUGMENTATION_OPTIONAL_SECTIONS];
    const missing = AUGMENTATION_REQUIRED_SECTIONS.filter((h) => !hasContent(sections, h));
    if (missing.length > 0) failures.push(`missing or empty sections: ${missing.join(", ")}`);
    const contract = findSections(sections, "Task contract").flatMap((s) => s.lines);
    const covered = `- Already covered by ${ctx.augmentation.baseName}:`;
    if (!contract.some((l) => l.text.trimStart().startsWith(covered))) {
      failures.push(`## Task contract needs a line starting "${covered}"`);
    }
    if (!contract.some((l) => l.text.trimStart().startsWith("- Adds:"))) {
      failures.push('## Task contract needs a line starting "- Adds:"');
    }
    const allowedNorm = new Set(allowed.map(normaliseHeading));
    const headings = sections.flatMap((s) => [s.heading, ...s.subheadings]);
    const extra = headings.filter((h) => !allowedNorm.has(h));
    if (extra.length > 0) {
      failures.push(
        `augmentation may only contain sections: ${allowed.join(", ")} (found: ${extra.join(", ")})`,
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
    // `skill.body` is already the post-frontmatter body; stripping again would let a pasted
    // `---` block hide copied text.
    const mine = shingles(ctx.skill.body);
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
