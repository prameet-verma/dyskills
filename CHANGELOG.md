# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will follow
[Semantic Versioning](https://semver.org/) once it is released.

## [Unreleased]

### Added

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
