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
- `wildcardMatch(input, pattern)`: OpenCode's own `*`/`?` glob match, hand-written,
  `O(n·m)` (a dynamic-programming table) with no backtracking.
- `consentNotes(merged, variant, path)`: Ruling R34's consent-defeat check (below).
- `hasTopLevelPermissionsKey(path)`: whether a config file already declares a top-level
  `permissions` key, via `jsonc-parser`.
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

A scalar `permission.bash`, `permission.edit` or `permission.external_directory` is promoted to
`{ "*": <scalar>, ... }` before the new entries are added, so a user's blanket `"ask"` or `"allow"`
at one of those three paths survives as the wildcard rule. **A scalar `permission` itself (the
whole block, e.g. `"permission": "ask"`) is not promoted — it is a merge conflict, and nothing is
written.** Any other mismatch (for example, in personal scope, an existing `"dynamic-skills *": "deny"`) is also a
conflict. `init` never weakens a deny others share (Ruling R46, amended). Project scope omits an ask entry when `save` or `init` already resolves to `deny` in a _project_ layer (root project files, `.opencode/`), with a note; a deny only in a personal or global layer still gets the ask (so teammates never get allow) and the note says your personal deny becomes ask in this project. Personal scope compares the decisions for `save`, `init` and a read-only command before and after and leaves out, with a note, any entry (the broad allow, or an ask overwriting a deny) that would weaken one.

## Consent entries (D6)

Personal scope: `permission.bash` ends with, in this order (the last match wins):

```jsonc
{ "dynamic-skills *": "allow", "dynamic-skills save *": "ask", "dynamic-skills init *": "ask" }
```

`opencode run` rejects every pending ask. A non-interactive `dynamic-skills save` means running it
in a terminal, or appending a **distinct, more specific** allow after the ask entry — never the same
key again, which would be a duplicate JSON key and make the next `init` report a conflict. For
example: `"dynamic-skills save --session *": "allow"` and `"dynamic-skills init --harness *":
"allow"`.

### Limits on what the ask entries catch

OpenCode matches the command exactly as written, not its parsed intent. `dynamic-skills 'save' …`
(quoted), `dynamic-skills "init" …` (quoted) and `dynamic-skills  save` (extra space) all match our
broad `"dynamic-skills *": "allow"` (personal scope), or no rule at all (project scope, default allow), instead of the ask, because the glob compares literal text. We
do **not** widen the ask patterns to catch these (for example to `*save*`), because that would also
prompt on unrelated commands such as `assess --task "save …"`.

### Ruling R34: when another rule outranks the ask

OpenCode evaluates the _last_ matching rule, not the most specific one, for a `permission.bash`
(or, on V2, migrated `shell`) query. That means a top-level `permission["*"]` key positioned
_after_ `bash` in the same object always wins over our ask, no matter how it got there — and on the
V2 line, every entry in the native `permissions` array wins over every V1-derived rule regardless
of where `permissions` sits in the document, because OpenCode always evaluates the migrated V1
rules first and the native array after. `init` simulates the merged document with the same
last-match evaluation OpenCode itself uses (`consentNotes`, built on a hand-written `wildcardMatch`
mirroring OpenCode's `Wildcard.match`) — never a conflict, and never a blocked write — and reports
what it finds for `dynamic-skills save` and `dynamic-skills init`:

- A documented opt-out (an allow rule specifically scoped to `dynamic-skills save …` or
  `dynamic-skills init …`, per the advice above) is reported as consent deliberately lifted, not a
  defeat.
- A deny is reported as the command being denied outright (stricter than asking), never as
  something to move or remove.
- Anything else that wins instead of the ask — a broad or misplaced allow that was not meant to
  cover this command, such as a top-level `permission["*"]: "allow"` placed after `bash` — is
  reported as a defeat, naming the winning rule and advising it be moved or removed.

### Cross-scope override

A project's own `.opencode/opencode.json(c)` or a root `opencode.json(c)` is evaluated alongside
personal config. On OpenCode 1.x, the project and personal config files are deep-merged, so a
project file with `permission.bash: "allow"` or a top-level `permission["*"]: "allow"` can override
the _personal_ asks for work done in that project. Run `dynamic-skills init --harness opencode
--scope project` there too if that project should keep the consent entries. Project scope writes only the save and init `ask` entries (no broad `"dynamic-skills *": "allow"`, Ruling R44), so it cannot turn a personal deny into an allow; read-only commands then rely on a personal `init`.

## Questions

OpenCode's `question` tool documents no cap on questions or options. Every question that has
options is sent in one call, with `multiple` set from `multiSelect`; a question without options is
asked as plain text. The native payload has no id field, so `idMap` keys are the header: the first
30 characters of the question id, or, if two ids share that 30-character prefix, as many leading
characters as fit alongside a `~2`, `~3`, … suffix, kept to at most 30 characters in total, so
neither question's header is dropped or over OpenCode's limit. In `opencode run`, V1 denies the
tool and V2 cancels the form — ask in plain text or record a skipped answer with an assumption.

## Verification

Only on the V2 line: `opencode debug paths` is run, and its exit code and non-empty (`/\S/`)
stdout are checked. V1 has no equivalent command, so V1 and unsupported-line installs report no
verify checks.
