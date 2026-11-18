# Dynamic Skills on Codex

Tested against Codex `0.169.0`. Any other version works but is reported as untested. The adapter
internals are in the [adapter README](../../adapters/codex/README.md); the design is in the
[architecture](../architecture.md) and [ADR 0007](../adr/0007-harness-adapter-interface.md).

## Install

```sh
npm i -g dynamic-skills
dynamic-skills init --harness codex                       # personal scope (default)
dynamic-skills init --harness codex --scope project       # this repository
dynamic-skills init --harness codex --codex-allow-rule    # opt-in trust decision, see below
```

The package is not yet published to npm; until it is, build the repository and put the built
`dynamic-skills` bin on `PATH`. Restart Codex after `init` so it loads the rules.

### What `init` writes

| File            | Personal (`CODEX_HOME` when absolute, else `~/.codex`)   | Project (committable)                                      |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| Bootstrap skill | `~/.agents/skills/dynamic-skill-bootstrap/SKILL.md`      | `<repo>/.agents/skills/dynamic-skill-bootstrap/SKILL.md`   |
| Analyst agent   | `$CODEX_HOME/agents/dynamic-skills-context-analyst.toml` | `<repo>/.codex/agents/dynamic-skills-context-analyst.toml` |
| Rules           | `$CODEX_HOME/rules/dynamic-skills.rules`                 | `<repo>/.codex/rules/dynamic-skills.rules`                 |

`init` never edits `config.toml`, `rules/default.rules`, `AGENTS.md`, `hooks.json` or
`agents/openai.yaml`, and writes no status line or hook. A differing existing file is a conflict,
never overwritten without `--force`, and a conflict anywhere stops every harness's writes. Codex
applies `.codex/` only in a trusted project.

## Consent rules

`dynamic-skills.rules` always holds two `prefix_rule`s with `decision = "prompt"`, one for
`dynamic-skills save` and one for `dynamic-skills init`. Codex applies the strictest matching
decision, so no allow rule can override them: Codex asks before a skill is saved or the
configuration is changed, and that prompt is your consent. The CLI rejects any option placed
before the subcommand, so `dynamic-skills -V save` cannot slip past the rules.

### The opt-in allow rule is a trust decision

With `--codex-allow-rule`, `init` also writes
`prefix_rule(pattern = ["dynamic-skills"], decision = "allow", ...)`. The allow rule lets every
`dynamic-skills` command except `save` and `init` run **outside the Codex sandbox, unsandboxed**,
with no prompt, and it trusts whatever `dynamic-skills` resolves to on `PATH`. Enable it only if you
accept that. It is off by default, and it matches the bare binary only, never a package runner.

It gives `save` and `init` no sandbox escape: their prompt rules always match, and an approved
prompt runs the CLI with the session's current permissions, which stay sandboxed. Saving into
`.agents/skills` from inside the sandbox may therefore need the agent to request escalated
permissions, or running `dynamic-skills save` in a terminal. Whether `save` from inside Codex needs
escalation is still to be verified by the phase-gate live smoke (Ruling R32); until then, treat a
terminal run as the reliable route.

### Headless runs (`codex exec`)

`codex exec` cannot approve a prompt, so a save is rejected there. Either:

- run `dynamic-skills save --session <id> --scope project --harness codex` in a terminal, or
- remove the `save` prompt rule from `dynamic-skills.rules`.

Editing the rules file makes it differ from what `init` writes, so the next `init` reports a
conflict that needs `--force`. A Starlark mistake in an edited rules file makes Codex stop loading
rules at the first parse error, which silently disables all of your rules, `default.rules`
included. `codex execpolicy check --rules <file> -- dynamic-skills save --scope project` shows the
decision (`prompt`) without running anything; `init` runs the same check as its verification.

## Using it

**Autonomous.** Codex lists skill descriptions in its catalog (up to about 2 % of the context), so
a matching task can trigger `dynamic-skill-bootstrap`. **Explicit.** Start the prompt with
`$dynamic-skill-bootstrap <task>` (or pick it with `/skills`).

Activation on Codex is reading the files in `loadOrder`; there is no native placement
(`activate` returns `native: null`). Status is relayed as text in the agent's reply.

**Questions.** `request_user_input` takes 1-3 questions with 2-3 options, single-select, and works
only in **Plan mode**. It is refused in the default mode, in subagents and in `codex exec`. The
agent passes `--harness codex` to `clarify ask`; questions the tool can carry are mapped natively
(ids with hyphens become underscores, `idMap` maps them back) and every other question is asked as
plain text, so no option is dropped. Headless, questions are asked in text or recorded as skipped
with an assumption.

**Analyst agent.** `dynamic_skills_context_analyst` (`dynamic-skills-context-analyst.toml`) is
read-only **by instruction only**: Codex subagents inherit the parent sandbox and approvals. The
CLI's schema validation is the real gate on its output.

## Saving a skill

`dynamic-skills save --session <id> --scope project|personal --harness codex` copies the evaluated
bundle byte for byte to `<project>/.agents/skills/<name>/` (project) or
`~/.agents/skills/<name>/` (personal). OpenCode reads `.agents/skills` too, so
`--harness codex,opencode` writes one copy. Codex lists a skill saved into an existing skills
directory within about 10 seconds; restart Codex if it does not appear. A skill saved in Phase 2
carries no freshness fingerprint, and saving an augmentation is not supported yet
(`SAVE_UNSUPPORTED`).

## Troubleshooting

- **Project trust.** `.codex/rules` and `.codex/agents` apply only in a trusted project. In an
  untrusted one, the consent rules are not loaded and the analyst agent is missing; the project
  skill under `.agents/skills` may not be listed either. Trust the project, or use personal scope.
- **Allow rule trust decision.** If `dynamic-skills` is unexpectedly unsandboxed, check
  `command -v dynamic-skills` and remove the allow rule from `dynamic-skills.rules`.
- **Prompt rules in `exec`.** `save` and `init` are rejected, not prompted. Use a terminal.
- **Plan-mode questions.** If the agent asks in text instead of with a form, it is not in Plan mode
  or it is a subagent; this is expected.
- **Write errors on `save`.** A sandbox write error for `.agents/skills` means the save ran
  sandboxed: approve an escalation, or run the command in a terminal.
- **Rules not applied.** Restart Codex after `init`; check the file with `codex execpolicy check`.
