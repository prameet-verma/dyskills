# 0002. Ephemeral session store

## Status

Accepted.

## Context

Generated skills are for one task. Writing them into a project or a harness skill directory would
leave stale files, mix generated content with hand-written skills and need an uninstall story.
The pipeline still needs durable intermediate state, because each CLI call is a separate process.

## Decision

All state lives in a file-backed session directory, `<home>/sessions/<id>/`, where `<home>` is
`DYNAMIC_SKILLS_HOME` or `<os tmpdir>/dynamic-skills`. `session.json` is saved atomically after
each successful command, under a lock file that becomes stale after 30 seconds. Artifact reads and
writes are confined to the session directory. Phase 1 writes nowhere else, and existing skills and
instruction files are only read. A session is removed with `clean`.

## Consequences

- Nothing persists beyond the temporary directory by default; persistence, versioning and caching
  belong to Phase 3.
- A command that fails saves nothing, so a bad document cannot corrupt a session. The few saved
  failures (timeout, exhausted attempts, a refused activation, a broken bundle at `evaluate`) are
  deliberate and listed in the [CLI reference](../cli-reference.md).
- Every session leaves reports (`reports/*.json`) that make timing and outcomes measurable with
  `report perf`.
- Because evaluated files live in a directory the agent can still edit, the evaluated bundle is
  pinned by digest (ADR 0006).
