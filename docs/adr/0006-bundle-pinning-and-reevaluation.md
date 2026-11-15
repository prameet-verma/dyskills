# 0006. Bundle pinning and re-evaluation

## Status

Accepted.

## Context

The agent writes the skill into the session directory and can keep editing it. If a bundle could
change between `evaluate` and `activate`, a skill that passed could be swapped for one that did
not (for example by adding a download piped into a shell). Separately, the first plan made a
failed behavioural result a dead end, although PRD §9.4 says a failure is revised and re-evaluated.

## Decision

- `evaluate` pins a sha256 digest of the evaluated bundle in the session: every file under
  `skills/` plus `evals/smoke.json`, with directories included so an empty directory is a change.
  The walk refuses symlinks and non-regular files and caps the bundle at 500 entries and 5 MB.
- `eval record` and `activate` recompute the digest first. A mismatch, or no pin, fails with
  `BUNDLE_INVALID` (exit 2) and saves nothing. The activation package API is unchanged.
- `evaluate` may follow `compile`, `evaluate` or `eval record`, so the agent can revise after a
  failed evaluation or a failed behavioural result. Every call consumes one of `MAX_EVAL_ATTEMPTS`
  (3, the first plus two revisions); the next call after that ends the session as failed
  (`EVAL_ATTEMPTS_EXHAUSTED`).
- A `BUNDLE_INVALID` from `evaluate` is saved: it consumes an attempt and clears the pin.

## Consequences

- A bundle edited after evaluation can never be recorded or activated; it must be evaluated again.
- Revision is possible but bounded, so there is no unbounded retry loop.
- One extra hash pass runs per command that checks the pin.
