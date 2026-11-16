# @dynamic-skills/adapter-claude-code

The Claude Code adapter: plans the `dynamic-skills init` install, names the directories `save`
writes and Claude Code reads, and maps clarification questions onto `AskUserQuestion`. Every write
is a `PlannedWrite` executed by `@dynamic-skills/adapter-sdk`. Tested against Claude Code `2.1.325`.

## API

- `claudeCodeAdapter: HarnessAdapter` with `id: "claude-code"`, `binary: "claude"`,
  `nativeActivation: true` and a read-only (`enforced`) analyst agent.
- `CLAUDE_CODE_TESTED_VERSIONS = ["2.1.325"]`. Any other version detects as `tested: false`;
  versions below `2.1.0` warn "no live skill reload", below `2.1.152` "no /reload-skills".
- `detect`, `planInstall`, `skillRoot`, `readRoots`, `questions`, `nativeSessionRoot`, `saveNotes`
  as in the SDK contract. The config root is an absolute `CLAUDE_CONFIG_DIR`, else `~/.claude`.

## What `init` writes

Personal scope (under the config root `R`):

- `R/skills/dynamic-skill-bootstrap/SKILL.md` and `R/agents/dynamic-skills-context-analyst.md`
  (tools `Read, Grep, Glob`).
- A merge into `R/settings.json`: `permissions.allow` (`Bash(dynamic-skills *)` plus `Read` and
  `Edit` on the session home), `permissions.ask` (consent rules), `permissions.additionalDirectories`
  and `env` (`DYNAMIC_SKILLS_HOME`, `DYNAMIC_SKILLS_HARNESS`). Every other key (`statusLine`,
  `hooks`, user rules) is kept.

Project scope:

- The same skill and agent under `<project>/.claude/` (committable).
- `.claude/settings.json` (committable): only `Bash(dynamic-skills *)` and the consent rules.
- `.claude/settings.local.json` (not committable, must be git-ignored): the session-home
  `Read`/`Edit` rules, `additionalDirectories` and `env`, all of which carry machine paths.
- `claude -p` in an untrusted folder ignores `.claude/settings.json`; use `--scope personal` for
  headless runs.

## Consent rules

`permissions.ask` holds `Bash(dynamic-skills save *)`, `Bash(dynamic-skills save)`,
`Bash(dynamic-skills init *)` and `Bash(dynamic-skills init)`. Ask beats allow, so the broad
`Bash(dynamic-skills *)` allow never silences them. A non-interactive save means running
`dynamic-skills save` in a terminal, or removing the ask rules.

The ask rules match `dynamic-skills save` or `init` only as the first argument after the binary;
the CLI rejects options placed before the subcommand (Ruling R31), so they cannot be used to slip
past the rules.

A user-level `deny` on `Bash(dynamic-skills ...)` blocks Dynamic Skills entirely, because deny beats
allow. `init` adds a plan note when it finds such a rule in the target settings file.

## Native mode

`--native` adds `env.DYNAMIC_SKILLS_NATIVE = "1"` (to whichever file holds `env`) and creates
`<session home>/native/claude-code/.claude/skills`. Launch with
`claude --add-dir <session home>/native/claude-code` so sessions list activated skills natively.

## Questions

`AskUserQuestion` takes at most 4 questions with 2-4 options each. Questions are chunked in input
order; the answer key is the question text, mapped back to the id by `idMap`. Questions without
options, with an out-of-range option count, or with a repeated text are asked as plain text.
