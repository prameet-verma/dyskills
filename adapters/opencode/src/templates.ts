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

/**
 * Project-scope entries (Ruling R44): only the consent asks, never the broad
 * `"dynamic-skills *": "allow"`. OpenCode merges its layers with `mergeDeep`, where a key already
 * present keeps its earlier position and new keys are appended; a project-layer allow would land
 * after a personal `save`/`init` deny and win the last-match evaluation.
 */
export const PROJECT_BASH_ENTRIES: Readonly<Record<string, string>> = {
  "dynamic-skills save *": "ask",
  "dynamic-skills init *": "ask",
};

/**
 * Note shown for both scopes about the consent entries and non-interactive saves (Ruling R36: the
 * opt-out key is distinct from, and more specific than, the consent entry it follows, so appending
 * it never creates a duplicate JSON key that would make the next `init` conflict).
 */
export const CONSENT_NOTE =
  '`dynamic-skills save` and `init` ask for approval; `opencode run` rejects asks; a non-interactive save means running `dynamic-skills save` in a terminal, or appending a more specific allow after the ask entry (last match wins), for example `"dynamic-skills save --session *": "allow"` and `"dynamic-skills init --harness *": "allow"`.';

/** Note shown in both scopes: OpenCode matches the literal command text, not its parsed intent. */
export const QUOTED_SUBCOMMAND_NOTE =
  "OpenCode matches the command as written; quoted or extra-spaced subcommands (for example `dynamic-skills 'save' …` or `dynamic-skills  save`) are not caught by the ask rules. We do not widen the asks to catch them (for example to `*save*`), because that would also prompt on unrelated commands such as `assess --task \"save …\"`.";

/** Note shown for project installs: OpenCode 1.x needs an extra allow to read the session home. */
export const PROJECT_EXTERNAL_DIR_NOTE =
  "Reading the session home from OpenCode 1.x needs an external_directory allow: run `dynamic-skills init --harness opencode --scope personal`.";

/** Note shown for project installs: the project config no longer pre-allows read-only commands. */
export const PROJECT_READONLY_NOTE =
  'A project install writes only the save and init asks, not `"dynamic-skills *": "allow"`, so it cannot turn a personal deny into an allow (OpenCode merges its layers key by key, last match wins). Read-only `dynamic-skills` commands are therefore not pre-allowed: with a personal `"*": "ask"` they prompt. Run `dynamic-skills init --harness opencode --scope personal` to allow them.';

/**
 * Note shown for personal installs only: a project-scoped config can defeat the personal asks for
 * that project (Ruling R34's cross-scope case).
 */
export const CROSS_SCOPE_NOTE =
  'A project `.opencode/opencode.json(c)` or a root `opencode.json(c)` with `permission.bash: "allow"` or a top-level `permission["*"]: "allow"` overrides these personal asks for that project (OpenCode 1.x deep-merges the root and `.opencode` project files, so a broad allow in either can win); run `dynamic-skills init --harness opencode --scope project` there too.';

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
