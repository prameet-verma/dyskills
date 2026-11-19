# 0007. Harness adapter interface and the planner/executor split

## Status

Accepted.

## Context

Source: the [Phase 2 synthesis](../superpowers/research/2026-11-15-phase-2-synthesis.md).

Phase 2 makes Dynamic Skills install into and save for three harnesses (Claude Code, Codex,
OpenCode). Each has its own skill directories, permission file format and question tool. Writing
outside the session home was forbidden in Phase 1, so every new write needs one place where
idempotency, atomicity and containment are enforced and tested (synthesis, "Chosen adapter
design"; risks 1, 5 and 15). The core packages may not name harnesses.

## Decision

- `@dynamic-skills/adapter-sdk` defines `HarnessAdapter` and names no harness. An adapter in
  `adapters/<id>` is a pure planner: it detects its tool through an injected `HostProbe`, returns
  an `InstallPlan` (a list of `PlannedWrite` values and notes), names its save root and read roots,
  maps questions onto its native tool and supplies its analyst agent text (the SDK's
  `ANALYST_INSTRUCTIONS`, wrapped in the harness's format). It may read harness config and stat
  directories, but writes nothing.
- The SDK holds the only executor: `previewPlan` and `applyPlan`, plus `placeBundle`. Every write
  is planned, reported, idempotent, atomic, refuses a symlink at the target and declares a
  `within` root its parent must stay inside (`applyPlan` for installer writes, `placeBundle` for
  bundles). A conflict anywhere stops the whole apply.
- The CLI (`packages/cli/src/adapters.ts`) is the composition root and the only CLI file that
  names harnesses. The bootstrapper's `roots.ts` is the single root registry; adapters derive
  `readRoots` from it. Every adapter runs the shared `defineAdapterCompatSuite` against its own
  fixture home.
- The writes rule is amended: outside the session home the CLI writes only for `init`, for
  `save --scope project|personal` and for native placement under `<realpath home>/native/`.
- Consent (D6): `init` writes, in every harness, a rule that makes the harness ask before
  `dynamic-skills save` and `dynamic-skills init`, even where `dynamic-skills` is otherwise
  allowed (Claude Code `permissions.ask`, Codex `prefix_rule` with `decision = "prompt"`,
  OpenCode `"ask"` entries after the allow). The CLI rejects any option before the subcommand
  (R31) so argument order cannot change which rule matches. The Codex allow rule is opt-in
  (`allowRule`, R25) and gives `save` no sandbox escape (R32). OpenCode matches raw command text,
  so a quoted subcommand escapes its ask rules (R35, a documented limit); Codex matches prefix rules only against bare commands: a redirection, env prefix, `$` expansion, glob, pipe or chaining makes it evaluate the whole `bash -lc` script, which no rule covers and which is allowed by default (R43, a documented limit; the bootstrap skill instructs bare commands); `init` evaluates the
  merged config with last-match semantics and notes any rule that defeats consent (R34).

## Consequences

- Adding a harness is a package, a `Harness` enum entry with regenerated schemas, a registry line,
  root-registry entries, a dependency in the CLI package, a fixture home and a compat test file;
  [the authoring guide](../adapters/authoring.md) lists them.
- Idempotency, dry run and containment are tested once in the SDK and per target by the testkit.
- A harness quirk that cannot be planned (OpenCode quoted commands) stays a documented limit, not
  hidden code.
- The SDK executor is on the trust path of every write; its tests are the main safeguard. Known
  residual windows are listed in the architecture's trust boundaries.
