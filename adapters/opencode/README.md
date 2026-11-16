# @dynamic-skills/adapter-opencode

One adapter for both live OpenCode product lines (D3): OpenCode 1.x and OpenCode 2.x. It writes
only the V1-form `permission` object (never the V2 `permissions` array, nor `plugin`/`plugins`);
V2 migrates V1-form config automatically, and V1 hard-fails on a top-level V2 `permissions` key.
Tested against OpenCode `1.19.5` and `2.3.0`.

## API

- `openCodeAdapter: HarnessAdapter` (`id: "opencode"`, `binary: "opencode"`, `nativeActivation:
false`, delegation agent `dynamic-skills-context-analyst`, enforced read-only).
- `OPENCODE_TESTED_VERSIONS = ["1.19.5", "2.3.0"] as const`. Any other version detects as
  `tested: false`, and a major other than 1 or 2 detects `variant: null` with the warning
  "unsupported OpenCode line".
- `chooseConfigFile(candidates, fallback)`: the first of `candidates` that exists as a regular
  file, else `fallback`.
- `personalConfigDir(env)`: the OpenCode config directory — an absolute `OPENCODE_CONFIG_DIR`
  (used as-is), else `<absolute XDG_CONFIG_HOME, or <home>/.config>/opencode`.
- `mapQuestions(questions)`: maps questions onto the `question` tool.
- `detect`, `planInstall`, `skillRoot`, `readRoots`, `nativeSessionRoot`, `saveNotes` as in the
  `HarnessAdapter` contract.

## What `init` writes

Personal scope (under the config directory `C`, not committable):

- `C/skills/dynamic-skill-bootstrap/SKILL.md`, `C/agents/dynamic-skills-context-analyst.md`,
  `C/commands/dynamic-skills.md`.
- A `jsonc-merge` into `chooseConfigFile([C/opencode.jsonc, C/opencode.json], C/opencode.jsonc)`:
  `permission.bash` (the consent entries below), `permission.external_directory` and
  `permission.edit` both allowing `<session home>/*` (OpenCode 1.x needs the `external_directory`
  allow to read files there; V2 defaults it to allow already, but the rule is harmless on V2).

Project scope (under `<repo>/.opencode/`, committable):

- The same three files.
- A `jsonc-merge` into `chooseConfigFile([P/.opencode/opencode.jsonc, P/.opencode/opencode.json,
P/opencode.jsonc, P/opencode.json], P/.opencode/opencode.jsonc)` holding only `permission.bash`
  (no machine path, so it stays committable). Reading the session home from OpenCode 1.x then
  still needs the personal-scope `external_directory` allow; run `dynamic-skills init --harness
opencode --scope personal`.

A scalar `permission` (or an existing scalar `permission.bash`/`permission.edit`) is promoted to
`{ "*": <scalar>, ... }` before the new entries are added, so a user's blanket `"ask"` or `"allow"`
survives as the wildcard rule. Any other mismatch (for example an existing `"dynamic-skills *":
"deny"`) is a merge conflict and nothing is written.

## Consent entries (D6)

`permission.bash` always ends with, in this order (the last match wins):

```jsonc
{ "dynamic-skills *": "allow", "dynamic-skills save *": "ask", "dynamic-skills init *": "ask" }
```

`opencode run` rejects every pending ask. A non-interactive `dynamic-skills save` means running it
in a terminal, or appending `"dynamic-skills save *": "allow"` after the ask entry.

## Questions

OpenCode's `question` tool documents no cap on questions or options. Every question that has
options is sent in one call, with `multiple` set from `multiSelect`; a question without options is
asked as plain text. The native payload has no id field, so `idMap` keys are the (30-char-truncated)
header, mapped back to the question id. In `opencode run`, V1 denies the tool and V2 cancels the
form — ask in plain text or record a skipped answer with an assumption.

## Verification

Only on the V2 line: `opencode debug paths` is run and its exit code and non-empty output checked.
V1 has no equivalent command, so V1 and unsupported-line installs report no verify checks.
