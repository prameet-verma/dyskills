# @dynamic-skills/adapter-codex

The Codex adapter for Dynamic Skills. Tested against Codex `0.169.0`.

## API

- `codexAdapter`: the `HarnessAdapter` (`id: "codex"`, `binary: "codex"`, no native activation,
  delegation agent `dynamic_skills_context_analyst`, read-only by instruction only).
- `CODEX_TESTED_VERSIONS`: `["0.169.0"]`; any other version is detected as untested with a warning.
- `codexQuestions(questions)`: maps questions onto `request_user_input`.
- `analystToml`, `rulesText`, `tomlBasicString`, `tomlMultilineString`: the generated texts and the
  TOML escaping they use.

## What `init` writes

Personal scope (`CODEX_HOME` when absolute, else `~/.codex`) or project scope (committable):

| File            | Personal                                                 | Project                                                    |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| Bootstrap skill | `~/.agents/skills/dynamic-skill-bootstrap/SKILL.md`      | `<repo>/.agents/skills/dynamic-skill-bootstrap/SKILL.md`   |
| Analyst agent   | `$CODEX_HOME/agents/dynamic-skills-context-analyst.toml` | `<repo>/.codex/agents/dynamic-skills-context-analyst.toml` |
| Rules           | `$CODEX_HOME/rules/dynamic-skills.rules`                 | `<repo>/.codex/rules/dynamic-skills.rules`                 |

It never edits `config.toml`, `rules/default.rules`, `AGENTS.md` or `hooks.json`. A differing
existing file is a conflict, never overwritten without `--force`. Restart Codex after `init`;
Codex applies `.codex/` only in trusted projects.

## Consent rules (always written)

`dynamic-skills.rules` always holds two `prefix_rule`s with `decision = "prompt"`, one for
`dynamic-skills save` and one for `dynamic-skills init`, so Codex asks the user before a skill is
saved or the harness configuration is changed. Codex applies the strictest matching decision, so no
allow rule can override them. `codex exec` cannot approve a prompt: for a non-interactive save, run
`dynamic-skills save` yourself outside Codex, or remove the prompt rule from the rules file.

## The opt-in allow rule (a trust decision)

Without `--codex-allow-rule`, `dynamic-skills` runs inside the Codex sandbox and `save` may be
denied, because `.agents/` is protected and `~/.agents` is outside the writable roots. With the
flag, `init` also writes `prefix_rule(pattern = ["dynamic-skills"], decision = "allow", ...)`. That
lets every `dynamic-skills` command run outside the sandbox with no prompt (the two prompt rules
above still win for `save` and `init`). From then on the CLI's own path checks are the only
boundary around those commands. Enable it only if you accept that. It matches the bare binary only,
never a package runner.

## Questions

`request_user_input` takes 1-3 questions with 2-3 options each, works only in Plan mode and never
in subagents or `codex exec`. Questions with 2-3 options and no `multiSelect` are sent natively in
calls of at most 3 (`r1-q1` becomes `r1_q1`; `idMap` maps it back). Every other question is asked
as plain text, so no option is dropped.
