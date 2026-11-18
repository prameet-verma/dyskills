import { claudeCodeAdapter } from "@dynamic-skills/adapter-claude-code";
import { codexAdapter } from "@dynamic-skills/adapter-codex";
import { openCodeAdapter } from "@dynamic-skills/adapter-opencode";
import type { HarnessAdapter } from "@dynamic-skills/adapter-sdk";
import type { Harness } from "@dynamic-skills/core";
import { CliError } from "./io";
import type { OptionSpec } from "./commands/types";

/**
 * Every harness adapter, keyed by harness id. This file is the only place in the CLI that names
 * harnesses; command code and help text are built from this registry.
 */
export const ADAPTERS: Record<Harness, HarnessAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  opencode: openCodeAdapter,
};

/** Harness ids in help order. */
export const HARNESS_IDS: Harness[] = ["claude-code", "codex", "opencode"];

/** Shorthand accepted in a harness list. */
const ALIASES: Readonly<Record<string, Harness>> = { claude: "claude-code" };

/**
 * Parses a comma-separated harness list: aliases resolved, duplicates removed, order kept.
 * @param value - The `--harness` value, for example `claude,codex`.
 * @returns The harness ids.
 * @throws {CliError} `USAGE` for an empty list or an unknown name.
 */
export function parseHarnessList(value: string): Harness[] {
  const out: Harness[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim();
    const id = ALIASES[name] ?? HARNESS_IDS.find((h) => h === name);
    if (id === undefined) {
      throw new CliError(
        "USAGE",
        name === ""
          ? `--harness needs a comma-separated list of: ${HARNESS_IDS.join(", ")}.`
          : `Unknown harness "${name}"; expected one of: ${HARNESS_IDS.join(", ")}.`,
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The current harness: the flag value when given, else `DYNAMIC_SKILLS_HARNESS`.
 * @param flag - The `--harness` value, if any (a single id or alias).
 * @param vars - Environment variables of the invocation.
 * @returns The harness, or `null` when none is known or the environment value is invalid.
 * @throws {CliError} `USAGE` when the flag itself is invalid.
 */
export function currentHarness(
  flag: string | undefined,
  vars: Readonly<Record<string, string | undefined>>,
): Harness | null {
  if (flag !== undefined) return parseHarnessList(flag)[0] ?? null;
  const v = vars.DYNAMIC_SKILLS_HARNESS;
  if (v === undefined) return null;
  return ALIASES[v] ?? HARNESS_IDS.find((h) => h === v) ?? null;
}

/** The `--harness <list>` option text of `init`, built from the registry. */
export function harnessOptionSpec(description: string): OptionSpec {
  return {
    flags: "--harness <list>",
    description: `${description} Comma-separated: ${HARNESS_IDS.join(", ")} (alias: claude).`,
  };
}

/**
 * The opt-in flag that maps to the harness-neutral `InstallOptions.allowRule` (Ruling R25).
 * Only the adapter that needs an allow rule acts on it; the others ignore it.
 */
export const ALLOW_RULE_OPTION: OptionSpec = {
  flags: "--codex-allow-rule",
  description:
    "Also write an allow rule that lets dynamic-skills run outside the sandbox, for harnesses that need one (an opt-in trust decision).",
};

/** Whether the allow-rule flag was given in parsed options. */
export function allowRuleRequested(opts: Record<string, string | boolean | undefined>): boolean {
  return opts.codexAllowRule === true;
}
