# 0005. Sufficiency verdict and augmentation

## Status

Accepted.

## Context

An existing skill may already cover a task. Generating a new skill then duplicates it, while
silently editing it would damage a file the user owns (PRD §5.5, FR-40 to FR-42). A verdict taken
before the repository is understood would be a guess.

## Decision

- The sufficiency verdict comes after context analysis (`sufficiency submit` follows `context
submit`). The agent judges; the core validates the verdict against the scan, the invocation mode
  and the explicit flag.
- `sufficient` returns the existing skill unchanged and ends the session; there is no compile and
  no evaluation. `partial` produces an augmentation. `insufficient` produces a new skill.
- In `suggest` mode without an explicit request, a non-`sufficient` verdict needs approval. The SLA
  is paused while the user decides (PRD §10.3), and a decline ends the session.
- A `partial` verdict produces a delta-only augmentation named `<base>-augment`. It names its base
  (`metadata.augments`) and pins the sha256 of the base `SKILL.md` it was evaluated against
  (`metadata.augments-sha256`). It is activated base-first, and the base is never modified or moved.
- A base whose sha256 changes after the verdict stops `compile` (`BASE_CHANGED`) and activation
  (`base-changed`).

## Consequences

- Canonical skills stay read-only; an augmentation is a separate session artifact.
- Reuse is cheap and exact; augmentation costs one small skill, not a rewrite.
- The base must remain unchanged for the session. If it changes, the agent continues with the
  existing skill and tells the user.
- A skill outside the scanned directories cannot be a base, and an unreadable base is a failure.
