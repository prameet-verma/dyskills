import { ANALYST_DESCRIPTION, ANALYST_INSTRUCTIONS } from "@dynamic-skills/adapter-sdk";

/** Name of the read-only context analyst agent Claude Code loads from `agents/`. */
export const CLAUDE_ANALYST_NAME = "dynamic-skills-context-analyst";

/**
 * Renders the context analyst agent file: frontmatter limiting it to read-only tools (enforced by
 * Claude Code), then the shared analyst instructions.
 *
 * @returns The file bytes.
 */
export function analystAgentFile(): Buffer {
  return Buffer.from(
    [
      "---",
      `name: ${CLAUDE_ANALYST_NAME}`,
      `description: ${ANALYST_DESCRIPTION}`,
      "tools: Read, Grep, Glob",
      "model: inherit",
      "maxTurns: 20",
      "omitClaudeMd: true",
      "---",
      ANALYST_INSTRUCTIONS,
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Permission rule that lets the agent run the `dynamic-skills` binary. */
export const BASH_RULE = "Bash(dynamic-skills *)";

/** Consent rules (D6): `ask` beats `allow`, so these prompt even when {@link BASH_RULE} is allowed. */
export const ASK_RULES: readonly string[] = [
  "Bash(dynamic-skills save *)",
  "Bash(dynamic-skills save)",
  "Bash(dynamic-skills init *)",
  "Bash(dynamic-skills init)",
];

/**
 * Builds the `Read(...)` and `Edit(...)` rules for the session home. The home is absolute, so the
 * rule reads `Read(//abs/path/**)` (a leading `//` anchors at the filesystem root).
 *
 * @param home - Realpath of the session home.
 * @returns The read and edit rules.
 */
export function homeRules(home: string): { read: string; edit: string } {
  return { read: `Read(/${home}/**)`, edit: `Edit(/${home}/**)` };
}

/** Note shown for both scopes about the consent rules. */
export const CONSENT_NOTE =
  "`dynamic-skills save` and `init` ask for approval; an allow rule cannot override them (ask beats allow), so a non-interactive save means running `dynamic-skills save` in a terminal, or removing the ask rules.";

/** Note shown for project installs about untrusted folders. */
export const UNTRUSTED_NOTE =
  "`claude -p` in an untrusted folder ignores .claude/settings.json; run `dynamic-skills init --scope personal` for headless use.";
