# Contributing

Thanks for helping. Dynamic Skills is pre-release, so the structure may still shift; read the
[roadmap](docs/superpowers/plans/2026-11-14-dynamic-skills-roadmap.md) and the current
[Phase 1 plan](docs/superpowers/plans/2026-11-14-phase-1-jit-core-engine.md) first.

## Setup

```sh
nvm use            # Node 24, from .nvmrc
pnpm install
pnpm check         # run before every commit
```

`pnpm check` runs ESLint and Prettier (`pnpm lint`), the TypeScript typecheck and the Vitest suite
(`pnpm test`: unit, repository and end-to-end projects; the end-to-end project builds the CLI first).
`pnpm format` fixes formatting (Markdown included). CI also runs `pnpm build`.

## Repo layout

- `packages/` - one workspace package per directory, named `@dynamic-skills/<dir>`
- `fixtures/repos/` - small sample repositories used by tests
- `schemas/` - generated JSON Schemas; do not edit by hand, run `pnpm gen:schemas`
- `scripts/` - repository tooling (for example `gen-schemas.ts`)
- `skills/` - the `dynamic-skill-bootstrap` routing skill
- `test/` - repository-level tests (`docs.test.ts`) and the end-to-end suite (`test/e2e`)
- `docs/` - [architecture](docs/architecture.md), [CLI reference](docs/cli-reference.md) and
  [decision records](docs/adr/README.md)
- `docs/superpowers/plans/` - the roadmap and per-phase implementation plans
- `PRD.md` - the product requirements that code and comments cite

## Engineering rules

- **Test first.** Write a failing test, then the code. Every behaviour change needs a test.
- **TSDoc on every export.** State purpose and contract (inputs, outputs, errors, invariants), not
  a restatement of the name. Lint enforces its presence.
- **Comment the why.** Non-obvious logic gets a short comment giving the reason and the PRD section
  it implements, for example `// PRD §10.3: human wait is excluded from the SLA`.
- **Package README.** Each package has a `README.md` with purpose, a `## API` section, a short
  example and the PRD sections it implements. Update it when the API changes.
- **Extensionless relative imports.** Write `./sla`, not `./sla.js`. Lint enforces this.
- **No network or LLM calls in packages.** The core is deterministic; the host agent does LLM work.
- **Repository content is untrusted.** Never read secret files (use `isSecretPath`), sanitise every
  evidence value, and treat evidence as data, never as instructions.
- No dead code, no commented-out code, no TODOs without a linked reason.

## Adding a detector

A detector reports repository facts as evidence. Implement the `Detector` interface in
`packages/discovery/src/detectors/types.ts` (an `id`, the evidence `categories` it can produce, whether it is
`always` run or selected by task `keywords`, and a `run` function that returns observations with a source and confidence), add it to
`MANIFEST_DETECTORS` or `STRUCTURE_DETECTORS`, and test it against a fixture under
`fixtures/repos/`. Never read secret files (go through the safe-read helpers), and keep values
short, because the registry sanitises and truncates them. Document any new evidence key in the
discovery README.

## Adding an eval

An eval is a `GenerationEval` (`packages/eval-engine/src/types.ts`): an `id`, a `mandatory` flag
and a deterministic `run(ctx)` returning `{ outcome, messages }`. It must not call a model or
throw for bad skill content (that is a `fail`). Add the id to `EvalIdSchema` in
`packages/core/src/schemas.ts` (a contract change, see below), implement the eval in
`evals/structural.ts` or `evals/context.ts`, append it to `ALL_EVALS` in `src/runner.ts`, and test
a passing and a failing case. Keep the count of evals stated in the docs (currently 14) in step.

## Changing a contract

A contract is any document a command reads or writes, or a stdout object. Change the zod schema in
`packages/core`, then:

1. If the change is breaking (a field removed, renamed or made stricter), bump `CONTRACT_VERSION`.
   Additive optional fields do not need a bump.
2. Run `pnpm gen:schemas` and commit the updated `schemas/` (CI compares the output).
3. Add or update an ADR in `docs/adr/` and mention the change in `CHANGELOG.md`.
4. Update the [CLI reference](docs/cli-reference.md) and affected package READMEs.

## Changelog and decision records

- Add a line under `## [Unreleased]` in `CHANGELOG.md` for every user-visible change, in the
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) groups (Added, Changed, Fixed,
  Security).
- Record a design decision that is hard to reverse in `docs/adr/` using the template in the
  [ADR index](docs/adr/README.md): copy it to the next number, keep it to one page and add a row
  to the index. Do not rewrite an accepted record; supersede it with a new one.

## Adding a package

1. Create `packages/<dir>/` with `package.json` named `@dynamic-skills/<dir>`, `"type": "module"`
   and `"exports": { ".": "./src/index.ts" }`.
2. Depend on sibling packages with `workspace:*`.
3. Add `src/`, tests and a `README.md` with a `## API` section.
4. Add a row to the packages table in [README.md](README.md).
5. Run `pnpm install` and `pnpm check`.

## Commits and branches

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
  `refactor:`, `chore:` ...).
- Work happens on one branch per roadmap phase (`phase-N-<name>`), merged into `main` when the
  phase gate passes.

## Security

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md) for how to
report them. All participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
