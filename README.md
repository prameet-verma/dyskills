# Dynamic Skills

<!-- Badges (CI status, license, version) are added once the repository is published. -->

Dynamic Skills creates a small, evidence-grounded agent skill for the task you are about to do,
at the moment you ask for it. Instead of relying on generic skills or hand-written ones that rot,
it inspects the repository, finds what the task needs that is not yet covered, asks at most a few
clarifying questions, writes a concise `SKILL.md` bundle, evaluates it, and only then activates it.
By default the skill is ephemeral and leaves no trace in your project. See [PRD.md](PRD.md) for the
full product definition.

**Status:** pre-release. Phase 1 (JIT Core Engine) is implemented. Phase 2 (Harness Integrations:
installer, consent rules, save, native questions and optional native activation for Claude Code,
Codex and OpenCode) is implemented and awaiting its gate (live smoke runs by a human). Nothing is
published yet: the package is not yet on npm.

## How it works

Dynamic Skills is an **agent-driven CLI**. The TypeScript core is deterministic: each command
prints JSON on stdout and a human-readable status block on stderr. It makes no model calls and
needs no API keys or network access. All LLM work (semantic discovery, drafting the skill, judging
rubrics) is done by the host's root agent, which is instructed by the `dynamic-skill-bootstrap`
skill.

- **60 second SLA.** Active processing is limited to 60 seconds of wall-clock time, minus time
  spent paused waiting for a human. Clarification never resets the budget.
- **Clarification pause.** If a material question must be asked, the clock pauses while the user
  answers. At most 3 rounds are allowed; unanswered questions become recorded assumptions.
- **Ephemeral by default.** A session writes only inside its session directory
  (`$DYNAMIC_SKILLS_HOME/sessions/<id>/`, defaulting to the OS temp directory) and never into a
  permanent harness skill directory. The only other writes are `init`, `save` (after the host asks
  you) and optional native placement under the session home; see [SECURITY.md](SECURITY.md).

### The pipeline

1. **Assess** (`assess`): creates a session and scans existing skills and instruction files.
2. **Hybrid discovery** (`discover`, `context request`, `context submit`): the CLI discovers
   deterministic facts and builds a bounded, secret-free Context Packet. The agent analyses the
   packet (optionally asking for up to 3 rounds of targeted extra files), then submits a
   schema-checked Context Analysis Result. Each claim keeps its provenance; an agent claim is
   `verified` only when it resolves to real, non-secret evidence.
3. **Sufficiency verdict** (`sufficiency submit`): the agent decides, after analysis, whether an
   existing skill already covers the task.
   - _Reuse_ (`sufficient`): the existing skill is returned unchanged and the session ends.
   - _Augment_ (`partial`): a small separate skill adds what is missing and names the unchanged
     base it extends; the base is never modified.
   - _Generate_ (`insufficient`): a new short-lived skill is written for the task.
4. **Clarify** (`clarify ask`, `clarify answer`): at most 3 rounds of material questions; the
   SLA clock is paused while the human answers, and unanswered questions become assumptions.
5. **Compile, evaluate, activate** (`compile`, `evaluate`, `eval record`, `activate`): the CLI
   writes a brief, the agent writes the skill bundle and a smoke eval, the CLI runs 14 structural
   and grounding evals and checks the agent's behavioural output, and only a passing bundle is
   handed back. An edited bundle is refused (`BUNDLE_INVALID`) until it is evaluated again.

The CLI and the bootstrap skill ([`skills/dynamic-skill-bootstrap/SKILL.md`](skills/dynamic-skill-bootstrap/SKILL.md)) are built.
The repository contains the library packages below. The design rationale is in the
[roadmap](docs/superpowers/plans/2026-11-14-dynamic-skills-roadmap.md).

## Install

```sh
npm i -g dynamic-skills
dynamic-skills init                      # every detected harness, personal scope
dynamic-skills init --harness codex --scope project --dry-run   # preview one harness, write nothing
```

The package is not yet published to npm. Until it is published,
build it (`pnpm install && pnpm build`) and link the bin into a directory on your `PATH`, for
example `ln -s "$PWD/packages/cli/dist/index.js" ~/.local/bin/dynamic-skills`. Any global
`dynamic-skills` on `PATH` (this link or `npm i -g`) makes the live smoke abort; remove it before
running the smoke, or set `SMOKE_ALLOW_GLOBAL=1` and accept that the global copy bypasses the smoke
guard and jail.

Everything calls the bare `dynamic-skills` command and never a package runner, which could fetch an
unrelated package of the same name (Ruling R19).

`init` installs the `dynamic-skill-bootstrap` skill, a read-only analyst agent where the harness has
one, and the harness's permission rules. It makes the harness ask before `dynamic-skills save` and
`dynamic-skills init` run. It previews every harness first and writes nothing if any has a conflict.
Per-harness guides: [Claude Code](docs/harnesses/claude-code.md),
[Codex](docs/harnesses/codex.md) and [OpenCode 1.x and 2.x](docs/harnesses/opencode.md).

## Commands

Every command prints one JSON object on stdout (with `ok` and `schemaVersion`) and a status block
on stderr, with two exceptions: `status` prints its block as plain text on stdout, and `report perf`
prints JSON on stdout with no status block on stderr (it has no session). Exit codes: `0` ok, `1` usage or state error, `2` evaluation gate failed, `3` timeout.
Sessions live in a private per-user home (`DYNAMIC_SKILLS_HOME`, default
`<os tmpdir>/dynamic-skills-<uid>`).
Full detail is in the [CLI README](packages/cli/README.md).

| Command                                                             | Purpose                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `assess --task <t> [--repo <p>] [--mode m] [--explicit]`            | Start a session and apply the invocation-mode gate.                       |
| `discover --session <id>`                                           | Programmatic discovery and the Context Packet.                            |
| `context request --session <id> --file <f>`                         | Ask for more repository files (3 rounds, safe-read rules).                |
| `context submit --session <id> --file <f>`                          | Submit the agent's analysis (strictly validated).                         |
| `sufficiency submit --session <id> --file <f>`                      | Record the reuse, augment or generate verdict.                            |
| `sufficiency approve --session <id> --decision approve\|decline`    | Suggest mode: answer the approval prompt.                                 |
| `clarify ask` / `clarify answer --session <id> --file <f>`          | Ask material questions (clock paused) and apply the answers.              |
| `compile --session <id>`                                            | Write the compilation brief and prepare the session `skills/` directory.  |
| `evaluate --session <id>`                                           | Run the generation evals and pin the evaluated bundle.                    |
| `eval record --session <id> --output <f> --verdict pass\|fail`      | Record the behavioural smoke-eval result.                                 |
| `activate --session <id>`                                           | Gated activation: returns the skill, or refuses with a fallback.          |
| `status --session <id>`                                             | Print the status block as plain text on stdout.                           |
| `clean --session <id>`                                              | Archive the performance report, then remove the session directory.        |
| `init [--harness l] [--scope s] [--dry-run] [--native]`             | Install the bootstrap skill and consent rules into each harness.          |
| `save --session <id> --scope project\|personal\|ephemeral\|discard` | Save (project/personal, after the host asks), keep ephemeral, or discard. |
| `report perf`                                                       | Aggregate performance over all sessions (no session needed, read-only).   |

## Current limitations

- Activation is agent-mediated: `activate` returns the skill content and `loadOrder`, and the agent
  reads those files. On Claude Code, `init --native` adds an optional native listing through
  `--add-dir`; Codex and OpenCode have none.
- A skill outlives its session only through `save` (project or personal scope) after the host asks.
  Saved skills carry no freshness fingerprint, and saving an augmentation is not supported yet;
  both arrive in Phase 3, together with versioning and caching.
- Headless runs cannot answer the consent prompt, so `save` there means running it in a terminal;
  each harness guide gives the recipe. On Codex, the optional allow rule runs `dynamic-skills`
  outside the sandbox and is a trust decision, and on OpenCode a quoted subcommand bypasses the ask
  (see the guides).
- There is no model call, network access or database anywhere in the packages.

## Packages

| Package                                                                             | Purpose                                                                                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`@dynamic-skills/core`](packages/core/README.md)                                   | Shared zod schemas, fixed limits, SLA clock, ephemeral session store, status rendering, performance reporting.      |
| [`@dynamic-skills/evidence-registry`](packages/evidence-registry/README.md)         | Provenance-tracking store of repository facts, with conflict recording and value sanitisation.                      |
| [`@dynamic-skills/discovery`](packages/discovery/README.md)                         | Parallel, task-directed deterministic discovery with secret-file exclusion.                                         |
| [`@dynamic-skills/context-analyzer`](packages/context-analyzer/README.md)           | Task requirements, evidence gap classification and semantic probe planning.                                         |
| [`@dynamic-skills/context-packet`](packages/context-packet/README.md)               | Context Packet builder, safe targeted enrichment and excerpt sanitising.                                            |
| [`@dynamic-skills/bootstrapper`](packages/bootstrapper/README.md)                   | Existing skill scan and coverage assessment (reuse, synthesize, suggest or none).                                   |
| [`@dynamic-skills/clarification-manager`](packages/clarification-manager/README.md) | Clarification rounds, SLA pause/resume and assumption recording.                                                    |
| [`@dynamic-skills/skill-compiler`](packages/skill-compiler/README.md)               | Compilation brief (new skill and augmentation), bundle parser and golden skill fixtures.                            |
| [`@dynamic-skills/eval-engine`](packages/eval-engine/README.md)                     | Generation evals: spec, metadata, references, conciseness, portability and security.                                |
| [`@dynamic-skills/activation`](packages/activation/README.md)                       | Gated ephemeral activation of new skills and augmentations with timeout fallback.                                   |
| [`@dynamic-skills/adapter-sdk`](packages/adapter-sdk/README.md)                     | Harness-neutral adapter contract, the planned/atomic writer, bundle placement and the compatibility testkit.        |
| [`@dynamic-skills/adapter-claude-code`](adapters/claude-code/README.md)             | Claude Code installer, save roots, `AskUserQuestion` mapping and optional native placement.                         |
| [`@dynamic-skills/adapter-codex`](adapters/codex/README.md)                         | Codex installer (skill, analyst agent, consent rules), save roots and `request_user_input` mapping.                 |
| [`@dynamic-skills/adapter-opencode`](adapters/opencode/README.md)                   | One OpenCode adapter for 1.x and 2.x: installer, consent entries, save roots and `question` mapping.                |
| [`dynamic-skills`](packages/cli/README.md)                                          | The CLI (published name, source in `packages/cli`): every command from `assess` to `activate`, plus `init`, `save`. |

## Requirements and quick start

- Node.js 24 or newer (see `.nvmrc`)
- pnpm 12 (pinned by `packageManager`)

```sh
nvm use
pnpm install
pnpm check         # lint, typecheck and tests
pnpm test          # unit tests plus end-to-end tests (builds the CLI first)
pnpm build         # bundle the CLI to packages/cli/dist
pnpm gen:schemas   # regenerate JSON Schemas into schemas/
```

The end-to-end tests (`test/e2e`) spawn the built binary against a temporary session home and user
home, and put generated fake harness executables on `PATH`; no real harness binary runs in the test
suite.

## Live smoke

`scripts/live-smoke.sh <claude-code|codex|opencode> [autonomous|explicit] [--native]` is a manual
check, never run in CI. It runs a **real harness** with **your own login** (it costs tokens), in a
temp workspace that is removed on exit, and records evidence for **you to judge**: it runs a few
automatic checks (such as AC 28, that nothing ephemeral reached a permanent skill directory) but the
verdicts are yours: it prints a checklist to fill in, the timing and the reports. Build first
(`pnpm build`), then for example:

```sh
pnpm build
scripts/live-smoke.sh claude-code explicit
scripts/live-smoke.sh claude-code autonomous --native   # --native: Claude Code only
SMOKE_SKIP_PROBES=1 scripts/live-smoke.sh codex autonomous
```

The scripts jail `init` and `save` to the temp workspace, deny the harness real config access and
guard the CLI calls, so your real harness configuration and skill directories are not written.
Any global `dynamic-skills` on `PATH` (the link above or `npm i -g`) makes the live smoke abort;
remove it before running the smoke, or set `SMOKE_ALLOW_GLOBAL=1` and accept that the global copy
bypasses the smoke guard and jail. Environment variables:

- `SMOKE_ALLOW_GLOBAL=1`: the script aborts when a `dynamic-skills` is already on `PATH`, because
  it could shadow the guarded wrapper and bypass the guard and the jail. Set this to run anyway and
  accept that risk (or uninstall the global copy).
- `SMOKE_KEEP=<absolute dir>`: copy the run output and session files there before the workspace is
  removed. Agent output may contain anything the agent printed.
- `SMOKE_SKIP_PROBES=1`: skip the extra probes (consent rules, the Codex sandbox write, OpenCode
  quoted-command bypass, compound commands, the `/var` alias) and run only the main flow.
- `SMOKE_TIMEOUT_SECS=<n>`: wall-clock limit of each harness run (default 600; `0` disables it).
  It needs `timeout` or `gtimeout` on `PATH`.

Run it per harness and version listed in the Phase 2 gate; the harness guides name the tested
versions.

## Roadmap

1. **Phase 1, JIT Core Engine:** contracts, SLA clock, session store, evidence,
   discovery, gap analysis, clarification, evals, activation gating, CLI and bootstrap skill.
2. **Phase 2, Harness Integrations:** adapter contract and adapters, native activation, installer
   (implemented; gate pending).
3. **Phase 3, Persistence and Lifecycle:** freshness, versioning, saving augmentations, caching.
4. **Phase 4, Evaluation Maturity:** eval fixture library, baseline-vs-skill benchmarks, regressions.
5. **Phase 5, Ecosystem Expansion:** extension API, more adapters, optional headless LLM provider.

Details: [roadmap](docs/superpowers/plans/2026-11-14-dynamic-skills-roadmap.md).

## Documentation

- [Architecture](docs/architecture.md) - components, a full session, trust boundaries
- [CLI reference](docs/cli-reference.md) - every command, flag, environment variable, exit code and error code
- Harness guides: [Claude Code](docs/harnesses/claude-code.md), [Codex](docs/harnesses/codex.md),
  [OpenCode](docs/harnesses/opencode.md)
- [Writing a harness adapter](docs/adapters/authoring.md)
- [Decision records](docs/adr/README.md) - why the design is the way it is
- [CONTRIBUTING.md](CONTRIBUTING.md) - how to set up, develop and submit changes
- [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [CHANGELOG.md](CHANGELOG.md)
- [PRD.md](PRD.md) - product requirements

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
