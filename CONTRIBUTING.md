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

`pnpm check` runs ESLint and Prettier, the TypeScript typecheck and the Vitest suite. `pnpm format`
fixes formatting (Markdown included).

## Repo layout

- `packages/` - one workspace package per directory, named `@dynamic-skills/<dir>`
- `fixtures/repos/` - small sample repositories used by tests
- `schemas/` - generated JSON Schemas; do not edit by hand, run `pnpm gen:schemas`
- `scripts/` - repository tooling (for example `gen-schemas.ts`)
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

Please do not open public issues for vulnerabilities. Report them privately to the maintainers;
a contact address and `SECURITY.md` will be added in Phase 1 (Task 19).
