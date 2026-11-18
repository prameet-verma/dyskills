# Architecture decision records

Each record states Context, Decision, Consequences and Status, and fits on one page. Records are
numbered and never rewritten: a changed decision gets a new record that supersedes the old one.

| Record                                          | Decision                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| [0001](0001-agent-driven-cli.md)                | A deterministic CLI driven by the host agent, which does the LLM work         |
| [0002](0002-ephemeral-session-store.md)         | State lives in an ephemeral session directory, nowhere else                   |
| [0003](0003-deterministic-evals-first.md)       | Activation is gated by deterministic evals plus a recorded behavioural result |
| [0004](0004-hybrid-discovery-contracts.md)      | Hybrid discovery and versioned contracts                                      |
| [0005](0005-sufficiency-and-augmentation.md)    | Sufficiency verdict, reuse and delta-only augmentation                        |
| [0006](0006-bundle-pinning-and-reevaluation.md) | Bundle digest pinning and bounded re-evaluation                               |
| [0007](0007-harness-adapter-interface.md)       | Pure adapter planners, one SDK executor, consent rules in every harness       |
| [0008](0008-read-first-activation.md)           | Read-first activation, optional Claude Code placement with a 24 h sweep       |
| [0009](0009-opencode-dual-line.md)              | One OpenCode adapter for 1.x and 2.x, writing V1-form config                  |
| [0010](0010-structured-question-options.md)     | Optional question options, text fallback, `CONTRACT_VERSION` unchanged        |
| [0011](0011-npm-distribution.md)                | Unscoped `dynamic-skills` package, bare binary, deferred augmentation save    |

## Template

Copy this into `NNNN-short-title.md` and add a row to the table above.

```md
# NNNN. Title

## Status

Proposed, Accepted, or Superseded by NNNN.

## Context

The forces at play: what problem, which constraints, which PRD sections.

## Decision

What we do, in full sentences.

## Consequences

What becomes easier, what becomes harder, what is now fixed.
```
