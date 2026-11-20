# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will follow
[Semantic Versioning](https://semver.org/) once it is released.

## [Unreleased]

### Changed

- The default active-time budget (`DEFAULT_BUDGET_MS`, PRD §10.1) is 150 seconds instead of 60.
  The Phase 2 live smoke measured 116.6 s of active time for a full run with a delegated
  context-analysis subagent on Claude Code. `DYNAMIC_SKILLS_BUDGET_MS` still overrides it.

### Added

Phase 2, Harness Integrations:

- `dynamic-skills init`: installs the `dynamic-skill-bootstrap` skill, the permission and consent
  rules and a read-only analyst agent for Claude Code, Codex and OpenCode (1.x and 2.x), planned
  and previewed first, idempotent, and written only when no harness has a conflict. `--dry-run`,
  `--force` (installer files only), `--scope project|personal`, `--native` and the opt-in
  `--codex-allow-rule` (a trust decision: it runs `dynamic-skills` outside the Codex sandbox).
- Consent rules in every harness: the harness asks before `dynamic-skills save` and
  `dynamic-skills init`. Program options before the subcommand are rejected, so they cannot bypass
  the rules. On OpenCode a quoted or extra-spaced subcommand is a known bypass.
- `dynamic-skills save --scope project|personal|ephemeral|discard`: copies the evaluated bundle
  byte for byte to the fewest skill roots the selected harnesses read, refusing a name already in
  use, a machine path in a committed skill, or a path outside the project. Saved skills carry no
  context fingerprint until Phase 3, and saving an augmentation is `SAVE_UNSUPPORTED` until then.
- Optional native activation on Claude Code: `activate` also returns `native` (`{ name, path }` or
  `null`), a placement under `<home>/native/` that a session started with `--add-dir` lists. Expired
  placements are swept at every `assess` and `activate` (24 hour TTL, 10 minute grace, 2 second
  budget).
- Structured clarification questions (`options`, `multiSelect`) and `clarify ask --harness`, which
  returns `native`, the plan for the harness's question tool (`AskUserQuestion`,
  `request_user_input`, `question`); `CONTRACT_VERSION` stays `"1"`.
- `@dynamic-skills/adapter-sdk` and the adapters `adapter-claude-code`, `adapter-codex` and
  `adapter-opencode`, with a compatibility suite over four targets (claude-code, codex,
  opencode-v1, opencode-v2); tested versions Claude Code `2.1.325`, Codex `0.169.0`, OpenCode
  `1.19.5` and `2.3.0`.
- Environment variables `DYNAMIC_SKILLS_HARNESS`, `DYNAMIC_SKILLS_NATIVE` and
  `DYNAMIC_SKILLS_ETC_DIR`; error codes `INIT_CONFLICT`, `HARNESS_NOT_DETECTED`, `SAVE_CONFLICT`,
  `SAVE_DENIED` and `SAVE_UNSUPPORTED`.
- Harness guides under `docs/harnesses/`, an adapter authoring guide, ADRs 0007 to 0011 and a
  release checklist; the live smoke scripts per harness (manual, never in CI).
- The CLI is published as the unscoped package `dynamic-skills` (`npm i -g dynamic-skills`); it is
  not yet published. Licensed under AGPL-3.0-only; the repository is
  <https://github.com/prameet-verma/dyskills>.

Phase 1, the JIT Core Engine:

- Versioned contracts (`CONTRACT_VERSION` 1) with generated JSON Schemas, an active-time SLA clock
  and a file-backed ephemeral session store.
- An evidence registry with provenance, conflicts and sanitisation, and parallel, task-directed
  discovery with secret-file exclusion.
- Hybrid discovery: a bounded Context Packet, targeted context requests, strict Context Analysis
  Results and gap analysis.
- The skill sufficiency verdict with reuse, delta-only augmentation of an unchanged base, and
  suggest-mode approval.
- Bounded clarification with SLA pause and recorded assumptions.
- The compilation brief, the skill bundle parser, 14 deterministic generation evals, behavioural
  smoke recording, and gated ephemeral activation with a timeout fallback.
- The `dynamic-skills` CLI (`assess` to `activate`, `status`, `clean`, `report perf`) and the
  `dynamic-skill-bootstrap` routing skill.
- Performance reporting, end-to-end pipeline tests and a live smoke script.
- Architecture, CLI reference and decision records under `docs/`, plus contributor guides.

### Changed

- The CLI package is renamed from `@dynamic-skills/cli` to `dynamic-skills`.
- The "writes only inside the session directory" rule is amended: `init`, `save` and native
  placement also write, each planned, contained and reported (see `SECURITY.md`).
- A refused `activate` carries `native: null`.
- Sessions that can no longer progress end terminally with reports and a `fallback`: a
  `clarify answer` that leaves a blocking question unresolved ends as completed/skipped, and
  `compile`'s `BASE_CHANGED` is a saved failed/failed outcome (still exit 1).
- `clean` archives `reports/performance.json` to `<home>/reports/<id>.json` before removing the
  session, and `report perf` counts live and archived reports once per session.
- A refused `activate` carries `error: "ACTIVATION_REFUSED"` (`TIMEOUT` for reason `timeout`) and a
  `message`.
- An ended session stops its SLA clock; the status block prints `Processing SLA: STOPPED`.
- Terminal paths also write `reports/assumptions.json`.
- Discovery no longer hides ordinary source files named `secrets.*` (`secrets.ts`, `secrets.py`,
  `secrets.test.ts`); they are indexed and readable again.
- `BOOTSTRAP_SKILL_NAME` and the fallback and notice texts are defined once in core.
- `evaluate` ends the session as `failed` when the last allowed attempt is not activatable (or its
  bundle is invalid), and `eval record` does so for a `fail` with no attempts left. Both add
  `fallback` to stdout, write the terminal reports and stop the clock, so `report perf` counts
  them. `clean` on a session that has not ended also ends it as `failed` and archives it.
- The session store no longer changes the mode of an existing `DYNAMIC_SKILLS_HOME` (only
  directories it creates are tightened), and a symlinked home written with a trailing slash is
  refused with `HOME_UNSAFE`.
- New session status `analysing` (label "Analysing") is set when `context submit` is accepted;
  `sufficiency submit` sets `assessing`. The status enum gained a value; `CONTRACT_VERSION`
  stays `"1"`.
- Clarification question ids must match the Agent Skills name pattern (1-64 lowercase letters,
  digits and single hyphens, such as `r1-q1`); question `text` is at most 1000 characters,
  `requirement` 200, an answer `value` 2000 and each assumption field 1000. This tightens the
  `clarification-request` and `clarification-response` contracts: an id with a space, a comma or
  nothing at all is now `SCHEMA_INVALID`.
- Command-line parse errors (a bad choice, a missing option or subcommand, an unknown command) print
  `Error USAGE: <message>` on stderr instead of commander's text; stdout is unchanged.

### Security

- Writes outside the session directory go through one executor that is idempotent, atomic,
  symlink-refusing and contained in the project root or the realpath session home; `--force`
  never applies to config merges, saved skills or base skills. Residual windows are listed in
  `docs/architecture.md`.
- The Codex allow rule, when opted into, runs `dynamic-skills` outside the sandbox and trusts
  whatever resolves on `PATH`; it gives `save` and `init` no escape from the prompt rules.
- One shared safe file reader in core (`readSafeFile`) now serves the CLI base read, activation's
  base read, `fingerprintFile` and discovery's readers: a FIFO, device symlink or oversize base can
  no longer hang or bloat `activate`, `evaluate` or `sufficiency submit`. `sufficiency submit`
  hashes the bytes it read instead of reading the file twice.
- The evaluated skill bundle is pinned by digest; `eval record` and `activate` refuse a changed
  bundle.
- Agent-written regular expressions run in a bounded worker.
- The skills scan reads `SKILL.md` through one non-blocking, regular-file-only, size-capped handle
  and only `stat`s instruction files, so a FIFO, `/dev/zero` symlink or oversized file cannot hang
  or bloat `assess`.
- The default session home is per user (`<tmpdir>/dynamic-skills-<uid>`); a symlinked,
  non-directory or foreign-owned home is refused with `HOME_UNSAFE`, loose permissions are
  tightened, and session data is written 0700/0600.
- The bootstrap skill and the live smoke script use the bare `dynamic-skills` command, never a
  package runner.
- More credential files are treated as secrets: Terraform variables and state,
  `.git-credentials`, `.aws/`, `.docker/config.json`, `secrets.*`, `kubeconfig`, `.kube/config`,
  keystores, `.htpasswd` and `.pgpass`.
- Secret-file exclusion for `secrets.*` fails closed: any such name is secret unless it is plain
  source with no config, data or encryption marker. A bare `secrets`, `.secrets` and `.secrets/`
  are now secret too.
