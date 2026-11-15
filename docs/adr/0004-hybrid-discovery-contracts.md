# 0004. Hybrid discovery and versioned contracts

## Status

Accepted.

## Context

Programmatic detectors find manifests and config reliably but miss meaning: which module owns a
concern, what a convention actually is. A model can read the code, but its claims need provenance,
and it must not receive secrets or act on repository text as instructions (PRD §6, §13.1).

## Decision

Discovery is hybrid. The CLI builds a bounded, secret-free Context Packet from programmatic
discovery (`discover`). The host agent performs the analysis, optionally requesting up to 3 rounds
of extra files, and submits a Context Analysis Result. The CLI validates it with a strict schema and
consolidates it (`context-analyzer`). Contracts live in `@dynamic-skills/core` and are versioned by
`CONTRACT_VERSION` (PRD §13.2); every document and stdout object carries `schemaVersion`, and the
generated JSON Schemas carry `$id: "dynamic-skills/v1/<file>"`.

- Analysis is always required before `compile`.
- Each accepted `context submit` replaces the previous analysis: agentic evidence, `not-asked`
  assumptions and `unknown.*` requirements are rebuilt, so every submission is complete and a
  correction cannot leave stale conflicts behind.
- An agentic `observed` claim is `verified` only with a resolvable source (a non-secret indexed
  file, a packet path or an existing non-agentic evidence key); otherwise it is `inferred`.
- Analysis assumptions have status `not-asked`.
- The PRD §13.2 `SkillBootstrapRequest` is the set of `assess` flags (task, mode, explicit, repo and
  the `DYNAMIC_SKILLS_BUDGET_MS` budget) and `SkillBootstrapResult` is the JSON printed by `activate`
  and `sufficiency submit`. They are documented rather than given schemas.
- A base skill is matched to a verdict by exact string equality with the scanned path.

## Consequences

- Provenance is explicit: evidence has an origin (`programmatic`, `agentic`, `user`) and a confidence.
- A breaking contract change bumps `CONTRACT_VERSION` and regenerates `schemas/`.
- An agent must resend the whole analysis each time, which costs tokens but keeps state simple.
- The agent must echo scanned paths verbatim; a relative or symlinked path is rejected.
