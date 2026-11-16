import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  SKILL_TOKEN_HARD_LIMIT,
  SKILL_TOKEN_SOFT_LIMIT,
  SkillNameSchema,
  type EvalOutcome,
} from "@dynamic-skills/core";
import { augmentationName } from "@dynamic-skills/skill-compiler";
import type { EvalContext, EvalRun, GenerationEval } from "../types";

/** Agent Skills spec: the only frontmatter keys a skill may carry (PRD §9.1). */
const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const MAX_DESCRIPTION = 1024;
const MAX_COMPATIBILITY = 500;
const SHA256 = /^[0-9a-f]{64}$/;

/** Builds the result: `fail` if any failure, else `warning` if any warning, else `pass`. */
function result(failures: string[], warnings: string[] = []): EvalRun {
  const outcome: EvalOutcome =
    failures.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass";
  return { outcome, messages: [...failures, ...warnings] };
}

/** The `metadata` frontmatter value when it is a mapping, else `null`. */
function metadataOf(ctx: EvalContext): Record<string, unknown> | null {
  const meta = ctx.skill.frontmatter.metadata;
  return typeof meta === "object" && meta !== null && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : null;
}

/**
 * Agent Skills spec conformance (PRD §9.1): name and description limits, the name equals its
 * directory, and the body is non-empty. Mandatory.
 */
export const specEval: GenerationEval = {
  id: "spec",
  mandatory: true,
  async run(ctx) {
    const { skill } = ctx;
    const failures: string[] = [];
    if (!SkillNameSchema.safeParse(skill.name).success) {
      failures.push(`name "${skill.name}" must be 1-64 lowercase kebab-case characters`);
    }
    if (skill.name !== basename(skill.dir)) {
      failures.push(`name "${skill.name}" must equal its directory "${basename(skill.dir)}"`);
    }
    if (skill.description.length < 1 || skill.description.length > MAX_DESCRIPTION) {
      failures.push(`description must be 1-${MAX_DESCRIPTION} characters`);
    }
    if (skill.body.trim() === "") failures.push("SKILL.md body is empty");
    return result(failures);
  },
};

/**
 * Frontmatter metadata rules plus augmentation consistency (PRD §9.1, §5.5, FR-41, FR-42).
 * An augmentation must name the base it was assessed against and that base must be unchanged;
 * a new skill must carry no augmentation metadata. Mandatory.
 */
export const metadataEval: GenerationEval = {
  id: "metadata",
  mandatory: true,
  async run(ctx) {
    const fm = ctx.skill.frontmatter;
    const failures: string[] = [];
    for (const key of Object.keys(fm)) {
      if (!ALLOWED_KEYS.has(key)) failures.push(`unknown frontmatter key "${key}"`);
    }
    // A tool grant is honoured by some hosts and ignored by others, so a portable skill has none.
    if ("allowed-tools" in fm) failures.push("allowed-tools grants tool permissions on some hosts");
    const compat = fm.compatibility;
    if (compat !== undefined && (typeof compat !== "string" || compat.length > MAX_COMPATIBILITY)) {
      failures.push(`compatibility must be a string of at most ${MAX_COMPATIBILITY} characters`);
    }
    const metaRaw = fm.metadata;
    const meta = metadataOf(ctx);
    if (metaRaw !== undefined && meta === null) {
      failures.push("metadata must be a string-to-string map");
    }
    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        if (k.includes("/")) failures.push(`host-namespaced metadata key ${k}`);
        if (typeof v !== "string") failures.push(`metadata.${k} must be a string`);
      }
    }

    const hasAugments = meta !== null && ("augments" in meta || "augments-sha256" in meta);
    const aug = ctx.augmentation;
    if (aug === null) {
      if (hasAugments) failures.push("augmentation metadata without a partial verdict");
    } else {
      if (meta?.augments !== aug.baseName) {
        failures.push(`metadata.augments must be "${aug.baseName}"`);
      }
      const sha = meta?.["augments-sha256"];
      if (typeof sha !== "string" || !SHA256.test(sha) || sha !== aug.baseSha256) {
        failures.push("augments-sha256 does not match the assessed base");
      }
      if (aug.currentBaseSha256 !== aug.baseSha256) {
        failures.push("base skill changed since assessment");
      }
      if (ctx.skill.name !== augmentationName(aug.baseName)) {
        failures.push(`augmentation name must be "${augmentationName(aug.baseName)}"`);
      }
    }
    return result(failures);
  },
};

/**
 * Resolves a bundle-relative reference to a real regular file inside the skill directory.
 * The skill is untrusted, so `../` escapes and symlinks (including symlinked directory
 * components) that leave the directory are rejected; realpath makes the containment check hold
 * for those.
 *
 * @returns The real path, or a failure reason.
 */
async function resolveReference(
  dir: string,
  root: string,
  ref: string,
): Promise<{ real: string } | { problem: string }> {
  const target = resolve(dir, ref);
  const rel = relative(resolve(dir), target);
  if (rel === "") return { problem: `reference "${ref}" is not a file` };
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { problem: `reference "${ref}" escapes the skill directory` };
  }
  try {
    const real = await realpath(target);
    const realRel = relative(root, real);
    if (realRel.startsWith("..") || isAbsolute(realRel)) {
      return { problem: `reference "${ref}" escapes the skill directory` };
    }
    if (!(await lstat(real)).isFile()) return { problem: `reference "${ref}" is not a file` };
    return { real };
  } catch {
    return { problem: `reference "${ref}" does not exist` };
  }
}

/**
 * Every bundle-relative link must resolve to an existing regular file inside the skill
 * directory (PRD §9.1). Not mandatory: a skill with no references passes.
 */
export const referencesEval: GenerationEval = {
  id: "references",
  mandatory: false,
  async run(ctx) {
    let root: string;
    try {
      root = await realpath(ctx.skill.dir);
    } catch {
      return result(ctx.skill.references.map((r) => `reference "${r}" cannot be resolved`));
    }
    const failures: string[] = [];
    for (const ref of ctx.skill.references) {
      const r = await resolveReference(ctx.skill.dir, root, ref);
      if ("problem" in r) failures.push(r.problem);
    }
    return result(failures);
  },
};

/** Per-file read cap for bundle files; the bundle is agent-written (untrusted). */
const MAX_REFERENCED_BYTES = 50_000;
/** Bundle walk limits: entries (files, directories and links) and directory depth. */
const MAX_BUNDLE_ENTRIES = 200;
const MAX_BUNDLE_DEPTH = 6;

/** A piece of skill text to scan: `label` prefixes its messages ("" for SKILL.md itself). */
interface ScanUnit {
  label: string;
  text: string;
}

/** Names an operating system drops beside a bundle; siblings never ship, so they are ignored. */
const OS_JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** What the bundle walk found. */
interface BundleWalk {
  /** Regular files other than the root SKILL.md, with their bundle-relative `/` path. */
  files: { rel: string; abs: string }[];
  /** Every entry's bundle-relative path. */
  entries: string[];
  /** True when the entry or depth limit stopped the walk. */
  tooLarge: boolean;
}

/**
 * Walks the bundle with `lstat` (symlinks are recorded, never followed), visiting at most
 * {@link MAX_BUNDLE_ENTRIES} entries down to depth {@link MAX_BUNDLE_DEPTH}. Names are sorted so
 * the result is deterministic. An unreadable directory is skipped.
 */
async function walkBundle(root: string): Promise<BundleWalk> {
  const out: BundleWalk = { files: [], entries: [], tooLarge: false };
  async function visit(dir: string, prefix: string, depth: number): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.tooLarge) return;
      if (depth > MAX_BUNDLE_DEPTH || out.entries.length >= MAX_BUNDLE_ENTRIES) {
        out.tooLarge = true;
        return;
      }
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const abs = join(dir, name);
      out.entries.push(rel);
      let info;
      try {
        info = await lstat(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) await visit(abs, rel, depth + 1);
      else if (info.isFile() && rel !== "SKILL.md") out.files.push({ rel, abs });
    }
  }
  await visit(root, "", 1);
  return out;
}

/**
 * Collects SKILL.md plus every regular file in the skill directory (found by {@link walkBundle})
 * and every referenced file, because anything in the bundle can be loaded into the agent's
 * context just like SKILL.md (so portability and security rules apply to it). Missing, escaping
 * and non-file references are skipped here; {@link referencesEval} reports them. A file over the
 * cap yields a failure instead of a unit. `layout` holds the portability-only findings about
 * where entries sit (nested SKILL.md, dot-prefixed names, strays beside the bundle).
 */
async function collectScanUnits(
  ctx: EvalContext,
): Promise<{ units: ScanUnit[]; failures: string[]; layout: string[] }> {
  const units: ScanUnit[] = [{ label: "", text: ctx.skill.raw }];
  const failures: string[] = [];
  const layout: string[] = [];
  let root: string;
  let skillMd: string | null;
  try {
    root = await realpath(ctx.skill.dir);
    skillMd = await realpath(ctx.skill.skillMdPath).catch(() => null);
  } catch {
    return { units, failures, layout };
  }
  const seen = new Set<string>();
  const linked = new Set<string>();
  for (const ref of ctx.skill.references) {
    const r = await resolveReference(ctx.skill.dir, root, ref);
    if (!("problem" in r)) linked.add(r.real);
  }
  const add = async (label: string, real: string): Promise<void> => {
    // SKILL.md is already scanned; two links (or a symlink alias) to one file are scanned once.
    if (real === skillMd || seen.has(real)) return;
    seen.add(real);
    try {
      if ((await stat(real)).size > MAX_REFERENCED_BYTES) {
        failures.push(
          `${label}: ${linked.has(real) ? "referenced" : "bundle"} file too large to scan`,
        );
        return;
      }
      units.push({ label, text: await readFile(real, "utf8") });
    } catch {
      // Vanished between resolve and read: treat like a missing reference (reported elsewhere).
    }
  };
  const walk = await walkBundle(ctx.skill.dir);
  if (walk.tooLarge) failures.push("bundle too large to scan");
  for (const rel of walk.entries) {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (name === "SKILL.md" && rel !== "SKILL.md") layout.push(`nested SKILL.md at ${rel}`);
    if (name.startsWith(".")) layout.push(`dot-prefixed entry ${rel}`);
  }
  try {
    const own = basename(ctx.skill.dir);
    for (const name of (await readdir(dirname(ctx.skill.dir))).sort()) {
      if (name !== own && !OS_JUNK.has(name))
        layout.push(`stray entry ${name} in the skills directory`);
    }
  } catch {
    // An unreadable parent is not a finding; the bundle itself was already read.
  }
  for (const f of walk.files) await add(f.rel, await realpath(f.abs).catch(() => f.abs));
  for (const ref of ctx.skill.references) {
    const r = await resolveReference(ctx.skill.dir, root, ref);
    if (!("problem" in r)) await add(ref, r.real);
  }
  return { units, failures, layout };
}

/**
 * Longest line the pattern scan accepts. Several patterns relate two tokens on one line, which
 * costs time proportional to line length per anchor; bounding lines (and the gap inside each
 * pattern, see {@link GAP}) keeps the synchronous scan linear in practice, because the SLA
 * cannot preempt synchronous code. SKILL.md and referenced files are agent-written (untrusted).
 */
const MAX_LINE_CHARS = 2000;

/**
 * Bounded gap between two tokens of one prose-like pattern (see {@link MAX_LINE_CHARS}).
 * Shell-command patterns do not use it: a padded command must not slip through, so they use
 * {@link after} (anchor, then test the rest of the capped line), which is linear.
 */
const GAP = "[^\\n]{0,200}";

/**
 * Linear "anchor, then tail" match: finds the first `anchor` on the line and tests `tail` on the
 * text from there on. Unlike `anchor[^\n]*tail` it never re-scans to the end of the line per
 * anchor, and unlike a bounded gap it cannot be defeated by padding between the two parts. The
 * first anchor suffices because its slice contains every later anchor's tail.
 */
function after(line: string, anchor: RegExp, tail: RegExp): boolean {
  const i = line.search(anchor);
  return i >= 0 && tail.test(line.slice(i));
}

/**
 * Which lines of `lines` sit inside a fenced code block (opener and closer included). A fence
 * opens with three or more backticks or tildes after at most three spaces of indentation (four
 * or more is indented code); a backtick opener whose info string contains a backtick is not a
 * fence. It closes on the same character with at least the same length and no info string
 * (CommonMark). A fence still open at the end is treated as not fenced, so an unterminated fence
 * cannot turn prose into code.
 */
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced = new Array<boolean>(lines.length).fill(false);
  let open: { run: string; at: number } | null = null;
  lines.forEach((line, i) => {
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
  return fenced;
}

/**
 * Runs `check` on every line of every unit, with whether the line sits in a fenced code block. A
 * unit with a line over {@link MAX_LINE_CHARS} gets one "line too long to scan" failure and that
 * line is skipped (it still counts for fence state).
 */
function scanLines(
  units: ScanUnit[],
  failures: string[],
  check: (label: string, line: string, fenced: boolean) => void,
): void {
  for (const { label, text } of units) {
    let tooLong = false;
    const lines = text.split("\n");
    const fenced = fencedLines(lines);
    lines.forEach((line, i) => {
      if (line.length > MAX_LINE_CHARS) {
        tooLong = true;
        return;
      }
      check(label, line, fenced[i] === true);
    });
    if (tooLong) failures.push(tag(label, "line too long to scan"));
  }
}

/** Prefixes a message with its file label when the finding is not in SKILL.md. */
const tag = (label: string, msg: string): string => (label === "" ? msg : `${label}: ${msg}`);

/** Boilerplate advice that adds tokens but no repository-specific information (PRD §9.1). */
const GENERIC_PHRASES = [
  "follow best practices",
  "write clean code",
  "as a senior engineer",
  "as a staff engineer",
  "ensure high quality",
  "test thoroughly",
];

/**
 * Token budget and generic-phrase check (PRD §9.1): at most 2,000 tokens passes, up to 5,000 is
 * a warning, above fails; each generic phrase is a warning. Mandatory.
 */
export const concisenessEval: GenerationEval = {
  id: "conciseness",
  mandatory: true,
  async run(ctx) {
    const failures: string[] = [];
    const warnings: string[] = [];
    const tokens = ctx.skill.tokenEstimate;
    if (tokens > SKILL_TOKEN_HARD_LIMIT) {
      failures.push(
        `SKILL.md is ~${tokens} tokens (limit ${SKILL_TOKEN_HARD_LIMIT}): mandatory review`,
      );
    } else if (tokens > SKILL_TOKEN_SOFT_LIMIT) {
      warnings.push(`SKILL.md is ~${tokens} tokens (target ${SKILL_TOKEN_SOFT_LIMIT})`);
    }
    const lower = ctx.skill.raw.toLowerCase();
    for (const phrase of GENERIC_PHRASES) {
      if (lower.includes(phrase)) warnings.push(`generic phrase "${phrase}"`);
    }
    return result(failures, warnings);
  },
};

/**
 * Harness-specific names that make a skill non-portable (PRD §9.1, §6.9 #7): instruction files,
 * harness directories, product names, harness tool names and slash commands. The unambiguous
 * names are case-insensitive; `Codex`, `Task tool` and `slash command` stay case-sensitive (or
 * as-is) because lowercase "codex" / "task tool" are ordinary English.
 */
const PORTABILITY_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bCLAUDE\.md\b/i, label: "harness instruction file" },
  { re: /\bAGENTS\.md\b/i, label: "harness instruction file" },
  { re: /\.claude\//i, label: "harness directory" },
  { re: /\.agents\//i, label: "harness directory" },
  { re: /\.opencode\//i, label: "harness directory" },
  { re: /\bClaude Code\b/i, label: "harness product name" },
  { re: /\bCodex\b/, label: "harness product name" },
  { re: /\bOpenCode\b/i, label: "harness product name" },
  { re: /\bAskUserQuestion\b/i, label: "harness tool name" },
  { re: /\bTodoWrite\b/i, label: "harness tool name" },
  { re: /\bTask tool\b/, label: "harness tool name" },
  { re: /\bslash command/i, label: "slash command" },
];

/**
 * Syntax some hosts render or execute before the agent reads it, so it is non-portable. Each
 * pattern is linear (anchored or a fixed token, no nested quantifiers).
 */
const RENDERED_SYNTAX: { re: RegExp; label: string }[] = [
  // Inline shell execution: !` at line start or after whitespace, or a fence opened with !.
  { re: /(^|\s)!`/, label: "inline shell execution" },
  { re: /^\s*(`{3,}|~{3,})\s*!/, label: "inline shell execution" },
  { re: /```!/, label: "inline shell execution" },
  { re: /\$ARGUMENTS/, label: "argument placeholder" },
  { re: /\$\{CLAUDE_[A-Z_]+\}/, label: "host environment placeholder" },
];

/**
 * `$` and digits not followed by a word character, as hosts substitute them wherever they sit
 * (`file$1`, `$$1`, `$10`). The one exemption is a `$` escaped by a single backslash (`\$1`).
 */
const POSITIONAL = /(?<!(?:^|[^\\])\\)\$\d+(?!\w)/;

/**
 * Fails on any harness-specific reference or host-rendered syntax in the bundle (SKILL.md and
 * every other file in it), on argument and host-environment placeholders, on positional
 * placeholders in prose (a warning inside fenced code), and on a bundle layout that is not
 * portable (nested SKILL.md, dot-prefixed entries, strays beside the bundle). Generated skills
 * must run on every harness. Mandatory.
 */
export const portabilityEval: GenerationEval = {
  id: "portability",
  mandatory: true,
  async run(ctx) {
    const { units, failures, layout } = await collectScanUnits(ctx);
    const found = new Set<string>();
    const warned = new Set<string>();
    scanLines(units, failures, (label, line, fenced) => {
      for (const { re, label: what } of PORTABILITY_PATTERNS) {
        const msg = tag(label, `non-portable ${what}: ${re.source}`);
        if (!found.has(msg) && re.test(line)) found.add(msg);
      }
      for (const { re, label: what } of RENDERED_SYNTAX) {
        if (re.test(line)) found.add(tag(label, what));
      }
      if (POSITIONAL.test(line)) {
        if (fenced) warned.add(tag(label, "positional placeholder in code"));
        else
          found.add(
            tag(
              label,
              "positional placeholder in prose: write money without $ (50 USD); \\$ is not a neutral escape across hosts",
            ),
          );
      }
    });
    return result([...failures, ...layout, ...found], [...warned]);
  },
};

/**
 * `rm` with recursive and force flags (any spelling: `-rf`, `-Rf`, `-fr`, `-r -f`,
 * `--recursive --force`, optionally after `sudo`) aimed at the filesystem root or the home
 * directory itself, among any number of targets (`rm -rf build /`). Done by tokenising instead
 * of one regex because flag order and spelling vary. Only the exact targets `/`, `/*`, `/*.*`,
 * `~`, `~/`, `~/*`, `$HOME`, `${HOME}`, `${HOME:?}` (quotes stripped first, so `"$HOME"/*`
 * counts) are dangerous, so `rm -rf ./dist`, `/tmp/x` and `~/.cache/foo` pass. The command word
 * is normalised before comparing with `rm`: leading backslashes (alias bypass `\rm`), quotes,
 * backticks, `(` and `$(` (command substitution) are stripped, then any directory prefix
 * (`/bin/rm`, `/usr/bin/rm`); `rmdir`, `firm`, `./rm-notes.md` and `rm.txt` stay non-matches.
 * The line is split at `,` `;` `&` `|`, except commas inside a brace group (`{build,dist}`),
 * which are shell brace expansion, not separators; a brace target is expanded into its
 * alternatives so `{build,/}` counts as `/`. Within a segment collection continues over
 * path-like and identifier-like words and stops after a word that ends a sentence or contains
 * characters invalid in a path, so prose such as "not anything" is not read as targets.
 * Linear: one pass per segment, only the first `rm` of a segment is examined (its tokens
 * already include everything after it).
 *
 * @param line - One line of text (see {@link MAX_LINE_CHARS}).
 */
function hasDangerousRm(line: string): boolean {
  const HOME = String.raw`(?:\$HOME|\$\{HOME[^}]*\})`;
  const TARGET = new RegExp(String.raw`^(?:\/(?:\*(?:\.\*)?)?|~\/?\*?|${HOME}\/?\*?)$`);
  // Brace-group commas become BRACE_COMMA (a private-use character, not a control character)
  // so the split below keeps `{a,b}` in one word. The group regex cannot span a brace or
  // whitespace, so the replacement is linear.
  const BRACE_COMMA = "\uE000";
  const WORD = /^[\w@.+{}\uE000-]+$/;
  const BRACE = /^([^{}]*)\{([^{}]*\uE000[^{}]*)\}([^{}]*)$/;
  const protectedLine = line.replace(/\{[^{}\s]*\}/g, (g) => g.replaceAll(",", BRACE_COMMA));
  for (const seg of protectedLine.split(/[;&|,]/)) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    const start = tokens.findIndex(
      (t) => t.replace(/^(?:[\\`"'(]|\$\()+/, "").replace(/^.*\//, "") === "rm",
    );
    if (start < 0) continue;
    let recursive = false;
    let force = false;
    const targets: string[] = [];
    for (const t of tokens.slice(start + 1)) {
      if (t.startsWith("-")) {
        recursive ||= t === "--recursive" || /^-[a-zA-Z]*[rR]/.test(t);
        force ||= t === "--force" || /^-[a-zA-Z]*f/.test(t);
        continue;
      }
      const endsSentence = /[.:!?)]$/.test(t);
      const clean = t.replace(/["'`]/g, "").replace(/[.:!?)]+$/, "");
      const pathLike = /^[/~$.]|\//.test(clean);
      if (!pathLike && !WORD.test(clean)) break;
      const brace = BRACE.exec(clean);
      if (brace) {
        const [, pre = "", alts = "", post = ""] = brace;
        for (const alt of alts.split(BRACE_COMMA)) targets.push(pre + alt + post);
      } else {
        targets.push(clean);
      }
      if (endsSentence) break;
    }
    if (recursive && force && targets.some((t) => TARGET.test(t))) return true;
  }
  return false;
}

/**
 * True when a `git commit` command on this line carries the short `-n` (no-verify) flag
 * (`git -c k=v commit` included). Quoted strings are blanked first so words inside a message
 * are neither flags nor separators. Only the option tokens that belong to the commit count: it
 * stops at `;` `&` `|` `,` and at the first non-option word, and skips the argument of
 * `-m`/`-F`/`-C`/`-c`-style flags, so `git commit -m x then tsc -noEmit` is not flagged.
 */
function hasCommitNoVerifyShort(line: string): boolean {
  const bare = line.replace(/"[^"]*"|'[^']*'/g, '""');
  for (const seg of bare.split(/[;&|,]/)) {
    const m = /\bgit\s+(?:-c\s+\S+\s+)*commit\b/.exec(seg);
    if (!m) continue;
    const tokens = seg
      .slice(m.index + m[0].length)
      .split(/\s+/)
      .filter(Boolean);
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k] ?? "";
      if (!t.startsWith("-")) break;
      if (/^-[a-zA-Z]*n[a-zA-Z]*$/.test(t)) return true;
      if (/^-[a-zA-Z]*[mFCc]$/.test(t)) k++;
    }
  }
  return false;
}

/** Prompt-injection phrases; also tested on soft-wrapped text (see securityEval). */
const INJECTION =
  /\b(?:ignore|disregard|forget)\s+(?:(?:all|the|any|your|of|these|those|my|every)\s+)*(?:previous|prior|above|earlier)\s+instructions/i;

/**
 * Dangerous instructions a skill must never contain (PRD §9.5). The skill is agent-written from
 * untrusted repository content, so prompt-injection echoes are included.
 */
const SECURITY_FAIL: { test: (line: string) => boolean; label: string }[] = [
  {
    // `curl x | sh`, with optional intermediate pipes (`| tee y |`), sudo flags, `env` (also
    // `/usr/bin/env`), absolute shell paths and dash.
    test: (t) =>
      after(
        t,
        /\b(?:curl|wget)\b/i,
        /\|\s*(?:sudo(?:\s+-\S+)*\s+)?(?:(?:\/usr)?\/bin\/env\s+|env\s+)?(?:(?:\/usr)?\/bin\/)?(?:ba|z|da)?sh\b/i,
      ),
    label: "pipes a download into a shell",
  },
  {
    // The other way round: a shell, `source` or `eval` runs a command substitution that
    // downloads (`bash <(curl x)`, `sh -c "$(curl x)"`, `eval "$(curl x)"`).
    test: (t) => after(t, /\b(?:(?:ba|z)?sh|source|eval)\b/i, /(?:<\(|\$\()\s*(?:curl|wget)\b/i),
    label: "runs a downloaded script in a shell",
  },
  { test: hasDangerousRm, label: "recursive delete of root or home" },
  { test: (t) => /--dangerously/.test(t), label: "dangerous flag" },
  {
    // `(?![\w-])` so `--no-verify-ssl` is not mistaken for the git flag.
    test: (t) => /--no-verify(?![\w-])/.test(t),
    label: "skips verification hooks",
  },
  {
    // `git commit -n` is the short form of --no-verify; `-nm` bundles it with -m.
    test: hasCommitNoVerifyShort,
    label: "skips verification hooks",
  },
  {
    // "ignore (all of) (the|your) previous instructions", plus disregard/forget variants.
    test: (t) => INJECTION.test(t),
    label: "prompt injection phrase",
  },
  {
    // A read-like verb followed on the same line by `.env`. `.env\b` deliberately also matches
    // `.env.example` and other `.env.*` files: they are treated as secret on purpose,
    // consistent with discovery's isSecretPath. The verb requirement keeps prose like "the .env
    // file is ignored by git" from tripping while `cat .env` / `grep KEY .env` fail.
    test: (t) =>
      after(
        t,
        /\b(?:cat|head|tail|less|more|source|read|reads|reading|print|open|cp|scp|grep|egrep|rg|awk|sed)\b/i,
        /[\s/"'\x60]\.env\b/i,
      ),
    label: "reads secrets",
  },
  {
    // POSIX `. .env` sourcing has no verb word, so it is matched on its own.
    test: (t) => /(?:^|[\s;&|])\.\s+\.env\b/.test(t),
    label: "reads secrets",
  },
  {
    // SSH locations are flagged without a verb, for any `/.ssh` path (`~/.ssh`, `$HOME/.ssh`,
    // `/home/u/.ssh`): there is no benign reason for a generated skill to name a private key
    // location, unlike `.env`, which is common in prose.
    // `(?!-)` so a URL like `/.ssh-guide` is not mistaken for the directory.
    test: (t) => /\/\.ssh(?:\/|\b(?!-))|\bid_rsa\b/.test(t),
    label: "references SSH keys",
  },
  {
    // The sandbox itself is always the object; "permissions" only counts as the final object
    // ("disable permissions.", "disable all permissions checks"), so "disable permissions
    // caching" and "turn off the permissions banner" pass.
    test: (t) =>
      /\b(?:disable|disabling|turn\s+off|bypass|circumvent)\s+(?:the\s+|all\s+)?sandbox(?:ing|ed)?\b/i.test(
        t,
      ) ||
      /\b(?:disable|disabling)\s+(?:the\s+|all\s+)?permissions?(?=\s*(?:[.!,;:)]|$)|\s+checks?\b)/i.test(
        t,
      ),
    label: "disables safety controls",
  },
  {
    test: (t) => /\bchmod\s+(?:-\S+\s+)*(?:0?777|a\+rwx|ugo\+rwx)\b/.test(t),
    label: "world-writable permissions",
  },
  {
    test: (t) =>
      after(t, /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/, /\s(?:-g|--global)\b/) ||
      /\b(?:npm|pnpm|yarn|bun)\s+(?:-g|--global)\s+(?:install|i|add)\b/.test(t) ||
      /\byarn\s+global\s+add\b/.test(t),
    label: "global package install",
  },
  {
    test: (t) => after(t, /\bpip3?\s+install\b/, /--user\b/),
    label: "user-level package install",
  },
  {
    test: (t) =>
      new RegExp(
        String.raw`\b(?:install|register|add|configure|set\s*up)\b${GAP}\bMCP\s+server`,
        "i",
      ).test(t) ||
      /\bmcp\s+add\b/i.test(t) ||
      new RegExp(
        String.raw`\b(?:edit|editing|edits|modify|modifying|update|updating|create|creating|write|writing|add\s+to)\b${GAP}\bmcp\.json\b`,
        "i",
      ).test(t),
    label: "installs an MCP server",
  },
];
const SECURITY_WARN: { test: (line: string) => boolean; label: string }[] = [
  {
    test: (t) => after(t, /\bgit\s+push\b/, /(?:--force\b|\s-f\b)/),
    label: "force push",
  },
];

/**
 * Fails on dangerous instructions and warns on risky ones (PRD §9.5), in SKILL.md and every
 * referenced file. Mandatory.
 *
 * Cautionary or negated mentions ("do not run rm -rf /") fail too, deliberately: negation is
 * easy to evade or mis-parse, so generated skills must describe restrictions without quoting
 * the dangerous command or flag (the compilation brief tells the agent so).
 */
export const securityEval: GenerationEval = {
  id: "security",
  mandatory: true,
  async run(ctx) {
    const { units, failures } = await collectScanUnits(ctx);
    const warnings: string[] = [];
    const found = new Set<string>();
    scanLines(units, failures, (label, line) => {
      for (const { test, label: what } of SECURITY_FAIL) {
        const msg = tag(label, `unsafe instruction: ${what}`);
        if (!found.has(msg) && test(line)) found.add(msg);
      }
      for (const { test, label: what } of SECURITY_WARN) {
        const msg = tag(label, `risky instruction: ${what}`);
        if (!warnings.includes(msg) && test(line)) warnings.push(msg);
      }
    });
    // A phrase may span a soft line break; joining trimmed lines is linear (no backtracking
    // over whitespace) and INJECTION itself is linear, so no per-line cap is needed here.
    for (const { label, text } of units) {
      if (
        INJECTION.test(
          text
            .split("\n")
            .map((l) => l.trim())
            .join(" "),
        )
      ) {
        found.add(tag(label, "unsafe instruction: prompt injection phrase"));
      }
    }
    failures.push(...found);
    return result(failures, warnings);
  },
};
