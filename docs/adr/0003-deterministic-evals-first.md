# 0003. Deterministic evals first

## Status

Accepted.

## Context

A generated skill must be checked before it is activated, within the same short budget. Judging it
with another model call is slow, costs money and is not reproducible. Many real defects are
mechanical: malformed frontmatter, oversize text, unresolved links, unsafe commands, uncited claims.

## Decision

Activation is gated by 14 deterministic generation evals (spec, metadata, references, conciseness,
portability, security, grounding, evidence classification, assumptions, completeness, scope, role,
duplication and the behavioural definition) that run in parallel with at most 6 in flight. Mandatory
evals fail the gate; others warn. A behavioural result is added by `eval record`: the agent runs
the smoke scenario and reports its own verdict, and the CLI checks the deterministic assertions in
`evals/smoke.json` against the output. Agent-written regexes run in a worker thread under a total
one second budget, because heuristics cannot bound every catastrophic pattern. A worker that
crashes or exits early is treated the same way as a timeout, so the assertion fails closed.

## Consequences

- The same evals run for new skills and augmentations.
- Results are reproducible and need no model, but they judge form and grounding, not quality.
  Quality judgement stays with the agent's rubric verdict. Benchmarks against a baseline are Phase 4.
- Failures return `revisionHints` so the agent can revise. Revision is bounded by
  `MAX_EVAL_ATTEMPTS` (ADR 0006).
- Some defences are intentionally blunt: a cautionary mention of an unsafe command fails, because
  negation is easy to evade.
