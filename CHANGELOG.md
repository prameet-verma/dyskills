# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will follow
[Semantic Versioning](https://semver.org/) once it is released.

## [Unreleased]

### Fixed

- Discovery no longer hides source files named `secrets.*` (`secrets.ts`, `secrets.py`); only config and
  data forms (`secrets.yaml`, `secrets.json`, `secrets.enc.*`, ...) and `secrets/` directories are secret.

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

### Security

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
