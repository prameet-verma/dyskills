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

The package is not yet published to npm. Until it is published, build it (`pnpm install && pnpm
build`) and link the bin into a directory on your `PATH`, for example `ln -s
"$PWD/packages/cli/dist/index.js" ~/.local/bin/dynamic-skills`. Restart Codex after `init` so it
loads the rules.

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
before the subcommand, so `dynamic-skills -V save` does not change which rule matches.

**Known limit (Ruling R43): the rules match plain commands only.** Codex splits a script of plain
words joined by `&&`, `||`, `;` or `|` and checks each command against the rules, so those still
prompt. A redirection (for example `2>&1`, including a heredoc), `$(...)`, backticks, `$VAR`, a
`VAR=` prefix, a glob, or control flow or a subshell makes Codex fall back to the whole
`["bash", "-lc", "<script>"]` command. No `dynamic-skills` rule matches that, and an unmatched
command is allowed by default, so `dynamic-skills save ... 2>&1` runs without the prompt. Under
`workspace-write` it still runs inside the sandbox, where writes to `~/.agents`, `~/.codex` and an
existing `.agents` directory fail; only `danger-full-access` is fully exposed. The bootstrap skill
tells the agent to run every `dynamic-skills` command bare (it also forbids pipes and chaining, to
be conservative), but that is an instruction, not an enforcement: the rules are a consent prompt for
ordinary use, not a barrier against an agent that adds a redirection. A `forbidden` rule has the
same limit, so denying the command in rules does not help. If that matters to you, use a read-only
sandbox, or run `save` and `init` yourself in a terminal.

### The opt-in allow rule is a trust decision

With `--codex-allow-rule`, `init` also writes
`prefix_rule(pattern = ["dynamic-skills"], decision = "allow", ...)`. It is off by default, and it
matches the bare binary only, never a package runner. Enable it only if you accept the following.

With `--codex-allow-rule`, every `dynamic-skills` command except `save` and `init` runs outside the
Codex sandbox without a prompt, trusting whatever `dynamic-skills` resolves to on `PATH`. `save` and
`init` keep their prompt rules; an approved prompt runs with the session's current permissions
(sandboxed unless the session itself is not), so the allow rule gives them no sandbox escape.
Whether `save` from inside Codex needs an escalation or a terminal run is pending live verification
(R32).

### Headless runs (`codex exec`)

`codex exec` cannot approve a prompt, so a save is rejected there. Either:

- run `dynamic-skills save --session <id> --scope project --harness codex` in a terminal, or
- remove the `save` prompt rule from `dynamic-skills.rules`, with the caveats below.

Prefer the terminal run. Removing the prompt rule does not make a headless save work reliably:

- **Without `--codex-allow-rule`**, `save` then only runs inside the `exec` sandbox. That sandbox is
  read-only by default and protects `.agents/`, so the save most likely fails with a sandbox write
  error.
- **With `--codex-allow-rule`**, `save` then runs unprompted and outside the sandbox, which gives up
  the consent rule (D6).

Whether `save` from inside Codex works is part of the pending R32 live smoke
(`scripts/live-smoke.sh codex autonomous`).

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
bundle byte for byte to `<project>/.agents/skills/<name>/` (project) or `~/.agents/skills/<name>/`
(personal). OpenCode reads `.agents/skills` too, so `--harness codex,opencode` usually writes one
copy. Codex lists a skill saved into an existing skills directory within about 10 seconds; restart
Codex if it does not appear. A skill saved in Phase 2 carries no freshness fingerprint, and saving
an augmentation is not supported yet (`SAVE_UNSUPPORTED`).

## Troubleshooting

- **Project trust.** `.codex/rules` and `.codex/agents` apply only in a trusted project. In an
  untrusted one, the consent rules are not loaded and the analyst agent is missing; the project
  skill under `.agents/skills` may not be listed either. Trust the project, or use personal scope.
- **Allow rule trust decision.** If `dynamic-skills` is unexpectedly unsandboxed, check
  `command -v dynamic-skills` and remove the allow rule from `dynamic-skills.rules`.
- **Save ran without a prompt.** The command was not bare (a redirection such as `2>&1` or a heredoc,
  `$(...)`, backticks, an env prefix, `$VAR`, a glob, control flow or a subshell); see the known limit under Consent rules.
- **Prompt rules in `exec`.** `save` and `init` are rejected, not prompted. Use a terminal.
- **Plan-mode questions.** If the agent asks in text instead of with a form, it is not in Plan mode
  or it is a subagent; this is expected.
- **Write errors on `save`.** A sandbox write error for `.agents/skills` means the save ran
  sandboxed: approve an escalation, or run the command in a terminal.
- **Rules not applied.** Restart Codex after `init`; check the file with `codex execpolicy check`.
