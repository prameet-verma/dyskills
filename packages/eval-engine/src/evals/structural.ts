import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
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
 * Every bundle-relative link must resolve to an existing regular file inside the skill
 * directory (PRD §9.1). The skill is untrusted, so `../` escapes and symlinks that leave the
 * directory fail. Not mandatory: a skill with no references passes.
 */
export const referencesEval: GenerationEval = {
  id: "references",
  mandatory: false,
  async run(ctx) {
    const failures: string[] = [];
    let root: string;
    try {
      root = await realpath(ctx.skill.dir);
    } catch {
      return result(ctx.skill.references.map((r) => `reference "${r}" cannot be resolved`));
    }
    for (const ref of ctx.skill.references) {
      const target = resolve(ctx.skill.dir, ref);
      const rel = relative(resolve(ctx.skill.dir), target);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        failures.push(`reference "${ref}" escapes the skill directory`);
        continue;
      }
      try {
        // realpath also catches a symlinked directory component pointing outside.
        const real = await realpath(target);
        const realRel = relative(root, real);
        if (realRel.startsWith("..") || isAbsolute(realRel)) {
          failures.push(`reference "${ref}" escapes the skill directory`);
        } else if (!(await lstat(real)).isFile()) {
          failures.push(`reference "${ref}" is not a file`);
        }
      } catch {
        failures.push(`reference "${ref}" does not exist`);
      }
    }
    return result(failures);
  },
};

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
 * harness directories, product names, harness tool names and slash commands.
 */
const PORTABILITY_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bCLAUDE\.md\b/, label: "harness instruction file" },
  { re: /\bAGENTS\.md\b/, label: "harness instruction file" },
  { re: /\.claude\//, label: "harness directory" },
  { re: /\.agents\//, label: "harness directory" },
  { re: /\.opencode\//, label: "harness directory" },
  { re: /\bClaude Code\b/, label: "harness product name" },
  { re: /\bCodex\b/, label: "harness product name" },
  { re: /\bOpenCode\b/, label: "harness product name" },
  { re: /\bAskUserQuestion\b/, label: "harness tool name" },
  { re: /\bTodoWrite\b/, label: "harness tool name" },
  { re: /\bTask tool\b/, label: "harness tool name" },
  { re: /\bslash command/i, label: "slash command" },
];

/** Fails on any harness-specific reference; generated skills must run on every harness. Mandatory. */
export const portabilityEval: GenerationEval = {
  id: "portability",
  mandatory: true,
  async run(ctx) {
    const failures = PORTABILITY_PATTERNS.filter(({ re }) => re.test(ctx.skill.raw)).map(
      ({ re, label }) => `non-portable ${label}: ${re.source}`,
    );
    return result(failures);
  },
};

/**
 * Dangerous instructions a skill must never contain (PRD §9.5). The skill is agent-written from
 * untrusted repository content, so prompt-injection echoes are included.
 */
const SECURITY_FAIL: { re: RegExp; label: string }[] = [
  {
    re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
    label: "pipes a download into a shell",
  },
  {
    re: /\brm\s+-[a-z]*(?:rf|fr)[a-z]*\s+(?:\/(?![\w.-])|~)/,
    label: "recursive delete of root or home",
  },
  { re: /--dangerously/, label: "dangerous flag" },
  { re: /--no-verify\b/, label: "skips verification hooks" },
  {
    re: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i,
    label: "prompt injection phrase",
  },
  {
    re: /\b(?:cat|head|tail|less|more|source|read|reads|reading|print|open|cp|scp)\b[^\n]*(?:(?:^|[\s/"'`])\.env\b|~\/\.ssh|\bid_rsa\b)/i,
    label: "reads secrets",
  },
  { re: /~\/\.ssh|\bid_rsa\b/, label: "references SSH keys" },
  { re: /\bdisable\s+(?:the\s+)?(?:sandbox|permissions?)\b/i, label: "disables safety controls" },
  { re: /\bchmod\s+(?:-R\s+)?777\b/, label: "world-writable permissions" },
  { re: /\bnpm\s+(?:install|i)\b[^\n]*\s(?:-g|--global)\b/, label: "global package install" },
  { re: /\bpip3?\s+install\b[^\n]*--user\b/, label: "user-level package install" },
  { re: /\b(?:install|register|add)\b[^\n]*\bMCP\s+server/i, label: "installs an MCP server" },
  { re: /\bmcp\s+add\b/i, label: "installs an MCP server" },
];
const SECURITY_WARN: { re: RegExp; label: string }[] = [
  { re: /\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)/, label: "force push" },
];

/** Fails on dangerous instructions and warns on risky ones (PRD §9.5). Mandatory. */
export const securityEval: GenerationEval = {
  id: "security",
  mandatory: true,
  async run(ctx) {
    const text = ctx.skill.raw;
    const failures = SECURITY_FAIL.filter(({ re }) => re.test(text)).map(
      ({ label }) => `unsafe instruction: ${label}`,
    );
    const warnings = SECURITY_WARN.filter(({ re }) => re.test(text)).map(
      ({ label }) => `risky instruction: ${label}`,
    );
    return result(failures, warnings);
  },
};
