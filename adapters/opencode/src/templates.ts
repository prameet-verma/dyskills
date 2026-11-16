import { ANALYST_INSTRUCTIONS } from "@dynamic-skills/adapter-sdk";

/**
 * Bash permission entries `init` merges into `permission.bash`, in the order they must appear so
 * the consent entries land after the broad allow (D6: the last match wins).
 */
export const BASH_ENTRIES: Readonly<Record<string, string>> = {
  "dynamic-skills *": "allow",
  "dynamic-skills save *": "ask",
  "dynamic-skills init *": "ask",
};

/** Note shown for both scopes about the consent entries and non-interactive saves. */
export const CONSENT_NOTE =
  '`dynamic-skills save` and `init` ask for approval; `opencode run` rejects asks; a non-interactive save means running `dynamic-skills save` in a terminal, or appending `"dynamic-skills save *": "allow"` after the ask entry (last match wins).';

/** Note shown for project installs: OpenCode 1.x needs an extra allow to read the session home. */
export const PROJECT_EXTERNAL_DIR_NOTE =
  "Reading the session home from OpenCode 1.x needs an external_directory allow: run `dynamic-skills init --harness opencode --scope personal`.";

/**
 * Renders the read-only context analyst agent markdown OpenCode loads from `agents/`.
 *
 * @returns The file bytes.
 */
export function analystAgentFile(): Buffer {
  return Buffer.from(
    [
      "---",
      "description: Read-only Dynamic Skills context analyst. Reads a Context Packet and returns one JSON object valid for the given schema; no prose.",
      "mode: subagent",
      "steps: 30",
      "permission:",
      '  "*": deny',
      "  read: allow",
      "  glob: allow",
      "  grep: allow",
      "  list: allow",
      "---",
      ANALYST_INSTRUCTIONS,
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * Renders the explicit trigger command `.opencode/commands/dynamic-skills.md` (or its personal
 * equivalent). Not named `dynamic-skill-bootstrap`, to avoid clashing with the skill's own
 * V1 slash command.
 *
 * @returns The file bytes.
 */
export function commandFile(): Buffer {
  return Buffer.from(
    [
      "---",
      "description: Run the dynamic-skill-bootstrap workflow for a task",
      "---",
      "Use the dynamic-skill-bootstrap skill for: $ARGUMENTS",
      "",
    ].join("\n"),
    "utf8",
  );
}
