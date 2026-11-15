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

### Security

- The evaluated skill bundle is pinned by digest; `eval record` and `activate` refuse a changed
  bundle.
- Agent-written regular expressions run in a bounded worker.
