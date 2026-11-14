# Dynamic Skills

Dynamic Skills creates a small, evidence-grounded agent skill for the task you are about to do,
at the moment you ask for it. Instead of relying on generic skills or hand-written ones that rot,
it inspects the repository, finds what the task needs that is not yet covered, asks at most a few
clarifying questions, writes a concise `SKILL.md` bundle, evaluates it, and only then activates it.
By default the skill is ephemeral and leaves no trace in your project. See [PRD.md](PRD.md) for the
full product definition.

**Status:** pre-release. Phase 1 (JIT Core Engine) is in progress; nothing is published yet.

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

The CLI and the bootstrap skill are **planned** (Phase 1, Tasks 15-17) and do not exist yet. Today
the repository contains the library packages below. The design rationale is in the
[roadmap](docs/superpowers/plans/2026-11-14-dynamic-skills-roadmap.md).

## Packages

| Package                                                                             | Purpose                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`@dynamic-skills/core`](packages/core/README.md)                                   | Shared zod schemas, fixed limits, SLA clock, ephemeral session store, status rendering, performance reporting. |
| [`@dynamic-skills/evidence-registry`](packages/evidence-registry/README.md)         | Provenance-tracking store of repository facts, with conflict recording and value sanitisation.                 |
| [`@dynamic-skills/discovery`](packages/discovery/README.md)                         | Parallel, task-directed deterministic discovery with secret-file exclusion.                                    |
| [`@dynamic-skills/context-analyzer`](packages/context-analyzer/README.md)           | Task requirements, evidence gap classification and semantic probe planning.                                    |
| [`@dynamic-skills/context-packet`](packages/context-packet/README.md)               | Context Packet builder, safe targeted enrichment and excerpt sanitising.                                       |
| [`@dynamic-skills/bootstrapper`](packages/bootstrapper/README.md)                   | Existing skill scan and coverage assessment (reuse, synthesize, suggest or none).                              |
| [`@dynamic-skills/clarification-manager`](packages/clarification-manager/README.md) | Clarification rounds, SLA pause/resume and assumption recording.                                               |
| [`@dynamic-skills/skill-compiler`](packages/skill-compiler/README.md)               | Compilation brief (new skill and augmentation), bundle parser and golden skill fixtures.                       |
| [`@dynamic-skills/eval-engine`](packages/eval-engine/README.md)                     | Generation evals: spec, metadata, references, conciseness, portability and security.                           |
| [`@dynamic-skills/activation`](packages/activation/README.md)                       | Gated ephemeral activation of new skills and augmentations with timeout fallback.                              |

Further packages land as Phase 1 progresses.

## Requirements and quick start

- Node.js 24 or newer (see `.nvmrc`)
- pnpm 12 (pinned by `packageManager`)

```sh
nvm use
pnpm install
pnpm check         # lint, typecheck and tests
pnpm test          # tests only
pnpm gen:schemas   # regenerate JSON Schemas into schemas/
```

## Roadmap

1. **Phase 1, JIT Core Engine (in progress):** contracts, SLA clock, session store, evidence,
   discovery, gap analysis, clarification, evals, activation gating, CLI and bootstrap skill.
2. **Phase 2, Harness Integrations:** adapter contract and adapters, native activation, installer.
3. **Phase 3, Persistence and Lifecycle:** saving skills, versioning, freshness checks, caching.
4. **Phase 4, Evaluation Maturity:** eval fixture library, baseline-vs-skill benchmarks, regressions.
5. **Phase 5, Ecosystem Expansion:** extension API, more adapters, optional headless LLM provider.

Details: [roadmap](docs/superpowers/plans/2026-11-14-dynamic-skills-roadmap.md).

## More

- [CONTRIBUTING.md](CONTRIBUTING.md) - how to set up, develop and submit changes
- [PRD.md](PRD.md) - product requirements

## License

Not yet chosen.
