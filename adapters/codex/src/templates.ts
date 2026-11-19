/** Agent name Codex knows the context analyst by (TOML `name`, the `agent_type` hint). */
export const CODEX_AGENT_NAME = "dynamic_skills_context_analyst";

/** File stem of the analyst's TOML file. */
export const CODEX_AGENT_FILE = "dynamic-skills-context-analyst";

const ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\b": "\\b",
  "\t": "\\t",
  "\f": "\\f",
  "\r": "\\r",
};

function escapeChar(ch: string, keepNewline: boolean): string {
  if (keepNewline && ch === "\n") return ch;
  if (ch === "\n") return "\\n";
  const known = ESCAPES[ch];
  if (known !== undefined) return known;
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
}

/**
 * Renders `text` as a single-line TOML basic string, escaping backslash, double quote and every
 * control character, so no input can end the string early.
 *
 * @param text - Any text.
 * @returns A quoted TOML string that parses back to `text`.
 */
export function tomlBasicString(text: string): string {
  return `"${Array.from(text, (c) => escapeChar(c, false)).join("")}"`;
}

/**
 * Renders `text` as a TOML multi-line basic string. Every double quote is escaped (so a `"""` in
 * the text cannot close the string), backslash and control characters are escaped, newlines stay.
 *
 * @param text - Any text.
 * @returns A `"""` string that parses back to `text`.
 */
export function tomlMultilineString(text: string): string {
  return `"""\n${Array.from(text, (c) => escapeChar(c, true)).join("")}"""`;
}

/**
 * Builds the Codex custom-agent TOML for the read-only context analyst.
 *
 * @param instructions - The analyst's developer instructions.
 * @returns The TOML document.
 */
export function analystToml(instructions: string): string {
  return [
    `name = ${tomlBasicString(CODEX_AGENT_NAME)}`,
    `description = ${tomlBasicString("Read-only analyst for a Dynamic Skills context packet; returns JSON only.")}`,
    `model_reasoning_effort = "medium"`,
    `developer_instructions = ${tomlMultilineString(instructions)}`,
    "",
    "[features]",
    "request_permissions_tool = false",
    "apps = false",
    "plugins = false",
    "",
    "[[skills.config]]",
    `name = "dynamic-skill-bootstrap"`,
    "enabled = false",
    "",
  ].join("\n");
}

/**
 * Note about Codex's prefix-rule matching (Ruling R43). Codex splits a `bash -lc` script of plain
 * words joined by `&&`, `||`, `;` or `|` and checks each part, but redirection (including
 * heredocs), `$(…)`, backticks, `$VAR`, `VAR=` prefixes, globs and control flow or subshells make
 * it match the whole `["bash","-lc","<script>"]` command, which no `dynamic-skills` rule matches.
 * An unmatched command is allowed by default; in workspace-write it still runs inside the sandbox.
 */
export const BARE_COMMAND_NOTE =
  "Codex checks the save and init prompt rules against each command of a script of plain words joined by `&&`, `||`, `;` or `|`, so those are still split and checked. A redirection (for example `2>&1`, including a heredoc), `$(…)`, backticks, `$VAR`, a `VAR=` prefix, a glob, or control flow or a subshell makes Codex evaluate the whole `bash -lc` script as one command instead, so the prompt rules do not apply and the command is allowed by default. In workspace-write it still runs inside the sandbox, where writes to `~/.agents`, `~/.codex` and an existing `.agents` fail; only danger-full-access is fully exposed. The bootstrap skill tells the agent to run `dynamic-skills` as a bare command, with no pipe or chaining either; this is a known limit, not a guarantee.";

const SAVE_RULE =
  'prefix_rule(pattern = ["dynamic-skills", "save"], decision = "prompt", justification = "Saving a skill needs the user\'s consent (Dynamic Skills)", match = ["dynamic-skills save --session x --scope project"], not_match = ["dynamic-skills status --session x"])';

const INIT_RULE =
  'prefix_rule(pattern = ["dynamic-skills", "init"], decision = "prompt", justification = "Installing changes harness configuration (Dynamic Skills)", match = ["dynamic-skills init --harness codex"], not_match = ["dynamic-skills status --session x"])';

const ALLOW_RULE =
  'prefix_rule(pattern = ["dynamic-skills"], decision = "allow", justification = "Dynamic Skills deterministic CLI (installed by dynamic-skills init)", match = ["dynamic-skills status --session x"], not_match = ["git status"])';

/**
 * Builds `dynamic-skills.rules`. The consent (prompt) rules are always present; Codex applies the
 * strictest matching decision, so they hold even beside the allow rule.
 *
 * @param allowRule - Also write the opt-in allow rule (first).
 * @returns The rules file text.
 */
export function rulesText(allowRule: boolean): string {
  const rules = allowRule ? [ALLOW_RULE, SAVE_RULE, INIT_RULE] : [SAVE_RULE, INIT_RULE];
  return `${rules.join("\n")}\n`;
}
