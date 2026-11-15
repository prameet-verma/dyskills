# Dynamic Skills

<!-- Badges (CI status, license, version) are added once the repository is published. -->

Dynamic Skills creates a small, evidence-grounded agent skill for the task you are about to do,
at the moment you ask for it. Instead of relying on generic skills or hand-written ones that rot,
it inspects the repository, finds what the task needs that is not yet covered, asks at most a few
clarifying questions, writes a concise `SKILL.md` bundle, evaluates it, and only then activates it.
By default the skill is ephemeral and leaves no trace in your project. See [PRD.md](PRD.md) for the
full product definition.

**Status:** pre-release. Phase 1 (JIT Core Engine) is implemented and in verification; nothing is published yet.

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
- **Ephemeral by default.** Phase 1 writes only inside a session directory
  (`$DYNAMIC_SKILLS_HOME/sessions/<id>/`, defaulting to the OS temp directory) and never into any
  harness skill directory.

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

## Commands

Every command prints one JSON object on stdout (with `ok` and `schemaVersion`) and a status block
on stderr, with two exceptions: `status` prints its block as plain text on stdout, and `report perf`
prints JSON on stdout with no status block on stderr (it has no session). Exit codes: `0` ok, `1` usage or state error, `2` evaluation gate failed, `3` timeout.
Full detail is in the [CLI README](packages/cli/README.md).

| Command                                                          | Purpose                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `assess --task <t> [--repo <p>] [--mode m] [--explicit]`         | Start a session and apply the invocation-mode gate.                      |
| `discover --session <id>`                                        | Programmatic discovery and the Context Packet.                           |
| `context request --session <id> --file <f>`                      | Ask for more repository files (3 rounds, safe-read rules).               |
| `context submit --session <id> --file <f>`                       | Submit the agent's analysis (strictly validated).                        |
| `sufficiency submit --session <id> --file <f>`                   | Record the reuse, augment or generate verdict.                           |
| `sufficiency approve --session <id> --decision approve\|decline` | Suggest mode: answer the approval prompt.                                |
| `clarify ask` / `clarify answer --session <id> --file <f>`       | Ask material questions (clock paused) and apply the answers.             |
| `compile --session <id>`                                         | Write the compilation brief and prepare the session `skills/` directory. |
| `evaluate --session <id>`                                        | Run the generation evals and pin the evaluated bundle.                   |
| `eval record --session <id> --output <f> --verdict pass\|fail`   | Record the behavioural smoke-eval result.                                |
| `activate --session <id>`                                        | Gated activation: returns the skill, or refuses with a fallback.         |
| `status --session <id>`                                          | Print the status block as plain text on stdout.                          |
| `clean --session <id>`                                           | Remove the session directory.                                            |
| `report perf`                                                    | Aggregate performance over all sessions (no session needed, read-only).  |

## Phase 1 limitations

- Activation is ephemeral and agent-mediated: `activate` returns the skill content and load order;
  nothing is installed into any agent harness or skill directory (native activation is Phase 2).
- Nothing is persisted beyond the session directory (saved skills, versioning and caching are
  Phase 3), and there is no installer.
- There is no model call, network access or database anywhere in the packages.

## Packages

| Package                                                                             | Purpose                                                                                                               |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`@dynamic-skills/core`](packages/core/README.md)                                   | Shared zod schemas, fixed limits, SLA clock, ephemeral session store, status rendering, performance reporting.        |
| [`@dynamic-skills/evidence-registry`](packages/evidence-registry/README.md)         | Provenance-tracking store of repository facts, with conflict recording and value sanitisation.                        |
| [`@dynamic-skills/discovery`](packages/discovery/README.md)                         | Parallel, task-directed deterministic discovery with secret-file exclusion.                                           |
| [`@dynamic-skills/context-analyzer`](packages/context-analyzer/README.md)           | Task requirements, evidence gap classification and semantic probe planning.                                           |
| [`@dynamic-skills/context-packet`](packages/context-packet/README.md)               | Context Packet builder, safe targeted enrichment and excerpt sanitising.                                              |
| [`@dynamic-skills/bootstrapper`](packages/bootstrapper/README.md)                   | Existing skill scan and coverage assessment (reuse, synthesize, suggest or none).                                     |
| [`@dynamic-skills/clarification-manager`](packages/clarification-manager/README.md) | Clarification rounds, SLA pause/resume and assumption recording.                                                      |
| [`@dynamic-skills/skill-compiler`](packages/skill-compiler/README.md)               | Compilation brief (new skill and augmentation), bundle parser and golden skill fixtures.                              |
| [`@dynamic-skills/eval-engine`](packages/eval-engine/README.md)                     | Generation evals: spec, metadata, references, conciseness, portability and security.                                  |
| [`@dynamic-skills/activation`](packages/activation/README.md)                       | Gated ephemeral activation of new skills and augmentations with timeout fallback.                                     |
| [`@dynamic-skills/cli`](packages/cli/README.md)                                     | The `dynamic-skills` command: framework, session state machine and every command (assess to activate, status, clean). |

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
home. `scripts/live-smoke.sh` is a manual check that drives a real agent through the bootstrap
skill; it is not part of the test suite and needs that agent installed.

## Roadmap

1. **Phase 1, JIT Core Engine:** contracts, SLA clock, session store, evidence,
   discovery, gap analysis, clarification, evals, activation gating, CLI and bootstrap skill.
2. **Phase 2, Harness Integrations:** adapter contract and adapters, native activation, installer.
3. **Phase 3, Persistence and Lifecycle:** saving skills, versioning, freshness checks, caching.
4. **Phase 4, Evaluation Maturity:** eval fixture library, baseline-vs-skill benchmarks, regressions.
5. **Phase 5, Ecosystem Expansion:** extension API, more adapters, optional headless LLM provider.

Details: [roadmap](docs/superpowers/plans/2026-11-14-dynamic-skills-roadmap.md).

## Documentation

- [Architecture](docs/architecture.md) - components, a full session, trust boundaries
- [CLI reference](docs/cli-reference.md) - every command, flag, exit code and error code
- [Decision records](docs/adr/README.md) - why the design is the way it is
- [CONTRIBUTING.md](CONTRIBUTING.md) - how to set up, develop and submit changes
- [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [CHANGELOG.md](CHANGELOG.md)
- [PRD.md](PRD.md) - product requirements

## License

Not yet chosen.
