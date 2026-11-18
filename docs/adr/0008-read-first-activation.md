# 0008. Read-first activation with optional Claude Code native placement

## Status

Accepted.

## Context

Source: the [Phase 2 synthesis](../superpowers/research/2026-11-15-phase-2-synthesis.md).

Activation must work without restarting the host (AC 24) and must never write an ephemeral skill
into a permanent skill directory (AC 28). Only Claude Code watches a non-permanent location (a
directory added with `--add-dir` at launch); Codex's own activation is reading `SKILL.md`, and
OpenCode 1.x has no live reload (synthesis matrix rows 1 and 2, decision D2).

## Decision

- `activate` always returns `loadOrder`, and the agent always reads those files into context. This
  works on every harness and is the default.
- Native placement is additive, Claude Code only and opt-in: `init --native` sets
  `DYNAMIC_SKILLS_NATIVE=1` and creates `<home>/native/claude-code/.claude/skills`; the user
  launches with `--add-dir <home>/native/claude-code`. Placement goes through the SDK
  (`placeBundle`, mode 0600/0700) and is contained in the realpath session home
  (`within: env.sessionHome`); an R38 pre-check restricts it to `native/`. R29 and R38 govern
  removal.
- Placements are ephemeral (D5). Every `assess` and `activate` sweeps `<home>/native/`. A placement
  is removed when it is older than `NATIVE_PLACEMENT_TTL_MS` (24 h), when no session references it,
  or when every referencing session ended without `activated` or `augmented`. An unparsable
  `session.json` counts as referencing every placement, so only the TTL removes placements while
  one exists.
- Sweep safety: before removing any state-derived path, `<realpath home>/native` must be a real
  directory, not a symlink, and the path must lie inside it (R38). A placement whose mtime is
  within `NATIVE_PLACEMENT_GRACE_MS` (10 minutes) is kept, so one placed just before its session
  is saved is not swept (R39).

## Consequences

- An expired placement is removed by the next `assess` or `activate` (best effort, budgeted at 2 s
  / 2000 dirs). A successfully activated session's placement stays until the 24 h TTL unless
  `clean` or `save --scope discard` removes it. Reuse refreshes the placement time. This bounds
  synthesis risk 14 (a crashed session leaving a listed skill) but does not remove it at once.
- Native placement may not survive on harnesses other than Claude Code; they rely on the read.
- Compaction survival is a benefit only for users who opt in.
- Removal is conservative: a path that fails the containment checks is skipped, never removed.
