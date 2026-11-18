# Dynamic Skills on Claude Code

Tested against Claude Code `2.1.325`. Any other version still works but is reported as untested;
below `2.1.0` there is no live skill reload, and below `2.1.152` no `/reload-skills`. The adapter
internals are in the [adapter README](../../adapters/claude-code/README.md); the design is in the
[architecture](../architecture.md) and [ADR 0007](../adr/0007-harness-adapter-interface.md).

## Install

```sh
npm i -g dynamic-skills
dynamic-skills init --harness claude-code                 # personal scope (default)
dynamic-skills init --harness claude-code --scope project # this repository
dynamic-skills init --harness claude-code --native        # also set up native placement
```

The package is not yet published to npm; until it is, build the repository and put the built
`dynamic-skills` bin on `PATH`. Run `init --dry-run` first to see the plan: it writes nothing, not
even the session home. Skills never call the CLI through a package runner (Ruling R19).

### What `init` writes

Personal scope, under the config root `R` (an absolute `CLAUDE_CONFIG_DIR`, else `~/.claude`):

- `R/skills/dynamic-skill-bootstrap/SKILL.md`
- `R/agents/dynamic-skills-context-analyst.md` (tools `Read, Grep, Glob`)
- a merge into `R/settings.json`: `permissions.allow` (`Bash(dynamic-skills *)`, plus `Read` and
  `Edit` on the session home), `permissions.ask` (the consent rules), `permissions.additionalDirectories`
  and `env` (`DYNAMIC_SKILLS_HOME`, `DYNAMIC_SKILLS_HARNESS`). Every other key, including
  `statusLine`, `hooks` and your own rules, is kept.

Project scope, under `<project>/.claude/`:

- the same skill and agent (committable);
- `settings.json` (committable): only `Bash(dynamic-skills *)` and the consent rules;
- `settings.local.json` (not committable): the session-home `Read`/`Edit` rules,
  `additionalDirectories` and `env`, which carry machine paths. `init` warns when git does not
  ignore it; add it to `.gitignore` or `.git/info/exclude`.

Every path written into the settings is a realpath (`/var` becomes `/private/var` on macOS). Nothing
is written to `statusLine`, `hooks` or `enabledPlugins`. A new `agents/` directory needs a Claude
Code restart. `init` is idempotent, never overwrites a differing file without `--force`, and writes
nothing for any harness when one has a conflict (for example invalid JSON in `settings.json`, or a
changed `env.DYNAMIC_SKILLS_HOME`). See [the CLI reference](../cli-reference.md).

## Consent rules

`permissions.ask` holds `Bash(dynamic-skills save *)`, `Bash(dynamic-skills save)`,
`Bash(dynamic-skills init *)` and `Bash(dynamic-skills init)`. Ask beats allow, so the broad
`Bash(dynamic-skills *)` allow never silences them: Claude Code asks you before a skill is saved or
the configuration is changed, and that prompt is your consent. The CLI rejects any option placed
before the subcommand (`dynamic-skills -V save` is a usage error), so the rules cannot be bypassed
that way. A user-level `deny` for `dynamic-skills` blocks everything, because deny beats allow;
`init` adds a note when it finds one.

### Headless runs (`claude -p`)

A headless run cannot answer the prompt, so a save is denied. Either:

- run the command yourself in a terminal:
  `dynamic-skills save --session <id> --scope project --harness claude-code`, or
- remove the four `ask` entries from `permissions.ask` in the settings file (a later `init`
  may restore them or report a conflict).

## Using it

**Autonomous.** Claude Code lists every skill description each turn, so a task such as "implement a
new caching strategy" can trigger `dynamic-skill-bootstrap` on its own. **Explicit.** Start the
prompt with `/dynamic-skill-bootstrap <task>`; use this when the autonomous trigger does not fire.

The bootstrap runs the CLI step by step. Status is relayed as text: the agent shows the status
block in its reply. `init` writes no status line.

**Questions.** Clarification questions use `AskUserQuestion` (at most 4 questions per call, 2-4
options each, plus the always-available free-text "Other"). The agent passes `--harness claude-code`
to `clarify ask` (or relies on `DYNAMIC_SKILLS_HARNESS`, which `init` sets), and `native` in the
result says what to call. A question without options is asked as plain text. The tool is not
available in subagents, and what a plain `-p` run does with it is undocumented; in that case the
question is asked in text or recorded as skipped with an assumption.

**Analyst agent.** `dynamic-skills-context-analyst` reads the Context Packet with `Read`, `Grep` and
`Glob` only, so it is truly read-only. Claude Code runs subagents in the background by default, and
the wait counts toward the 60 second budget.

## Native mode (optional)

Reading the files in `loadOrder` is always the activation. Native mode additionally lists the skill
in Claude Code itself. `init --native` sets `env.DYNAMIC_SKILLS_NATIVE` to `1` and creates
`<session home>/native/claude-code/.claude/skills`; start Claude Code with:

```sh
claude --add-dir <session home>/native/claude-code
```

`activate` then copies the evaluated skill to
`<realpath session home>/native/claude-code/.claude/skills/<name>` and returns it in `native`
(`{ name, path }`). It is skipped, with a line in `limitations`, when a skill of the same name is
already installed for Claude Code (the host would list it under a prefixed name), when another
session holds different bytes under that name, or when the session home's `native` directory is not
a plain directory. A refused activation returns `native: null`. Placements never reach a permanent
skill directory; they live under the session home and are swept: removed after 24 hours, when no
session references them, or when every referencing session ended without an activation, never
within 10 minutes of being placed. See [the CLI reference](../cli-reference.md#native-placement).

## Saving a skill

`dynamic-skills save --session <id> --scope project|personal --harness claude-code` copies the
evaluated bundle byte for byte to:

| Scope      | Location                                                   |
| ---------- | ---------------------------------------------------------- |
| `project`  | `<project>/.claude/skills/<name>/`                         |
| `personal` | `R/skills/<name>/` (`~/.claude/skills/<name>/` by default) |

Claude Code asks first (the consent rule). `--dry-run` shows the plan. OpenCode reads the same
directories, so `--harness claude-code,opencode` writes one copy. After a save, the skill is listed
live when the skills directory existed at session start; otherwise run `/reload-skills` (below
`2.1.0`, restart Claude Code). A skill saved in Phase 2 carries no freshness fingerprint; a later
phase treats it as needing a relevance check. Saving an augmentation is not supported yet
(`SAVE_UNSUPPORTED`).

## Troubleshooting

- **`claude -p` ignores project settings.** In an untrusted folder, headless mode does not use
  `.claude/settings.json`, so the allow rule is missing and the CLI call is denied. Use
  `--scope personal` (user settings are not trust-gated), or trust the folder interactively once.
- **Sandbox `$TMPDIR` differs.** A sandboxed command sees another temp directory, so the default
  session home (`<tmpdir>/dynamic-skills-<uid>`) would differ between calls. `init` pins
  `env.DYNAMIC_SKILLS_HOME` to avoid it. If you change `DYNAMIC_SKILLS_HOME` later, `init` reports a
  conflict at `env.DYNAMIC_SKILLS_HOME`: edit or remove that key by hand and run `init` again. The
  sandbox also denies writes to `.claude/skills`, which is one more reason `save` asks and the
  ephemeral skill is read from the session home.
- **`/var` and `/private/var`.** Allow rules must match both the requested and the resolved path, so
  `init` writes realpaths. If you moved the session home, rerun `init`.
- **`--add-dir` and native mode.** The directory must be the one `init` reported
  (`<session home>/native/claude-code`) and must exist before launch; a directory added after start
  needs `/add-dir`. Without it, the skill is still activated by reading `loadOrder`.
- **`settings.local.json` in git.** It holds machine paths and must stay out of version control.
- **Env-prefixed commands.** A command written as `FOO=1 dynamic-skills ...` does not match the
  allow rule and will prompt or be denied.
- **A different Claude Code version.** The adapter reports `tested: false` with a warning; verify
  with `scripts/live-smoke.sh claude-code explicit` (see the [README](../../README.md#live-smoke)).
