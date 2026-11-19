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
allow rule can override them. Codex still splits and checks plain-word scripts joined by `&&`, `||`, `;` or `|`, but a redirection (`2>&1`, heredoc), `$(...)`, backticks, `$VAR`, `VAR=` prefix, glob, or control flow or subshell makes it match the whole `bash -lc` script instead, which no rule covers and which is allowed by default (in workspace-write it still runs inside the sandbox; only danger-full-access is fully exposed; workspace-write also makes `<root>/.codex` read-only when it exists, which matters for a project `init`). That is Ruling R43, a known limit; a `forbidden` rule has the same limit, and the bootstrap skill tells agents to run commands bare. `codex exec` cannot approve a prompt: for a non-interactive save, run
`dynamic-skills save` yourself outside Codex, or remove the prompt rule from the rules file.

## The opt-in allow rule (a trust decision)

With `--codex-allow-rule`, `init` also writes
`prefix_rule(pattern = ["dynamic-skills"], decision = "allow", ...)`. That lets every
`dynamic-skills` command other than `save` and `init` run outside the Codex sandbox with no prompt.
`save` and `init` always match the stricter prompt rules, so they always ask, and Codex then runs an
approved prompt with the session's current permissions, still sandboxed. The allow rule therefore
never gives them a sandbox escape. Saving into `.agents/skills` from inside the sandbox may need the
agent to request escalated permissions, or running `dynamic-skills save` in a terminal.

The allow rule trusts whatever `dynamic-skills` resolves to on `PATH`: a different binary earlier on
`PATH` would run unsandboxed. From then on the CLI's own path checks are the only boundary around
those commands. Enable it only if you accept that. It matches the bare binary only, never a package
runner.

## Editing the rules file

Editing or removing rules in `dynamic-skills.rules` (as the consent-rule note invites for
non-interactive saves), or adding `--codex-allow-rule` later, makes the file differ from what `init`
writes. The next `init` then reports a conflict that needs `--force`. Codex stops loading rules at
the first parse error, so a Starlark mistake in an edited rules file silently disables ALL of your
rules, including `default.rules`.

## Questions

`request_user_input` takes 1-3 questions with 2-3 options each, works only in Plan mode and never
in subagents or `codex exec`. Questions with 2-3 options and no `multiSelect` are sent natively in
calls of at most 3 (`r1-q1` becomes `r1_q1`; `idMap` maps it back). Every other question is asked
as plain text, so no option is dropped.
