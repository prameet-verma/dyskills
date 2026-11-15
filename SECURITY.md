# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Report it privately to the maintainers at
[maintainer contact]. Include what you found, the steps to reproduce it and the version or commit.
We will acknowledge the report, work on a fix and agree a disclosure date with you. The project is
pre-release, so no versions are supported yet.

## Threat model summary

Dynamic Skills reads a repository and the agent's output, and produces text that an agent will
treat as instructions. The design assumes both inputs can be hostile.

- **Repository content is untrusted.** It is data, never instructions. Everything sent to the agent
  is sanitised and fenced as untrusted, including the Context Packet.
- **Agent output is untrusted until validated.** Every document the agent submits is parsed with a
  strict schema, and agent claims keep their provenance; a claim is `verified` only when it resolves
  to real, non-secret evidence.
- **Existing skills are untrusted and read-only.** A base skill is shown to the agent fenced and
  read-only, matched by exact scanned path, and pinned by sha256. Canonical skills are never
  written, moved or deleted.
- **Secrets are excluded.** Secret files (environment files, keys, certificates, credential files
  and similar) are never indexed or read by discovery, are never part of a packet, and secret-shaped
  values are redacted from excerpts and evidence.
- **A generated skill is evaluated before use.** Deterministic evals reject unsafe commands, prompt
  injection phrases, secret reads and sandbox weakening. The evaluated bundle is pinned by digest,
  so an edit after evaluation is refused.
- **Agent-written regular expressions are bounded.** They run in a worker thread under a total time
  budget and are terminated on timeout.
- **No automatic installation.** Nothing is installed into any agent or skill directory.
- **No writes outside the session directory in Phase 1.** Session files live under
  `DYNAMIC_SKILLS_HOME` or the temporary directory. File reads and writes are confined and symlinks
  are refused.
- **No network or model calls** are made by any package.
- Terminal output is stripped of control characters, because session ids and options are
  agent-controlled.

Known limitation: the deterministic evals check form and grounding, not intent. Review a generated
skill before relying on it for anything sensitive.
