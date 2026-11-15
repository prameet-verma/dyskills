# 0001. Agent-driven CLI

## Status

Accepted.

## Context

Dynamic Skills must create a skill inside an agent's own session within a 60 second active budget.
The product needs model judgement (what the repository means, whether a skill suffices, writing
the skill) and deterministic guarantees (limits, validation, secret handling, gates). Embedding a
model client in the core would need API keys, a network and a provider choice, and would make
results hard to reproduce.

## Decision

The core is a deterministic CLI that the host's root agent drives one JSON-in, JSON-out command at
a time. The agent performs all LLM work and submits schema-checked documents; the CLI validates,
stores, bounds and gates. A routing skill (`dynamic-skill-bootstrap`) tells the agent the order of
commands. Each command prints one JSON object on stdout and a human status block on stderr, with
exit codes `0` ok, `1` usage or state error, `2` evaluation gate failed, `3` timeout. `status`
(plain text on stdout) and `report perf` (JSON with no stderr block) are the two documented
exceptions. A session state machine fixes the legal command order.

## Consequences

- No packages import a network or model client; tests need no credentials and are deterministic.
- The agent can make mistakes in any step, so every agent document is untrusted until validated
  and every loop is bounded (clarification rounds, context requests, analyses, evaluation attempts).
- The CLI contract is the integration surface. Harness adapters (Phase 2) wrap it rather than
  replace it, and an optional headless provider (Phase 5) could drive the same commands.
- The bootstrap skill is documentation the agent follows, so its wording is tested like code.
