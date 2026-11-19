# 0009. One OpenCode adapter for two product lines

## Status

Accepted.

## Context

Source: the [Phase 2 synthesis](../superpowers/research/2026-11-15-phase-2-synthesis.md).

OpenCode ships two incompatible lines, 1.x (tested 1.19.5) and 2.x (tested 2.3.0). V1 throws on a
top-level V2 `permissions` key, while V2 migrates V1-form `permission` config on load
(synthesis, decision D3; risk 6). Maintaining two adapters would duplicate nearly everything.

## Decision

- One adapter, `openCodeAdapter`. The variant (`v1` or `v2`) comes from `opencode --version`; any
  other major version has no variant and a warning.
- It writes only the V1 form: `"permission": { … }`. It never writes the V2 `permissions` key,
  nor `plugin` or `plugins`.
- The compat suite has four targets: claude-code, codex, opencode-v1 and opencode-v2.
- Consent entries end `permission.bash` with `"dynamic-skills *": "allow"`, then `"ask"` entries
  for `dynamic-skills save *` and `dynamic-skills init *`; OpenCode's last match wins. Project scope writes only the two `ask` entries, never the broad allow (R44): layers merge with `mergeDeep` (existing keys keep their position, new keys append), so a project-layer allow would land after a personal save/init deny and win. A project-only install therefore does not pre-allow read-only commands. `consentNotes` simulates the layered config (global, root project, `.opencode`, plus each agent's `permission`) and notes any `save`/`init` result other than ask. Opt-out
  advice uses distinct keys (`dynamic-skills save --session *`, `dynamic-skills init --harness *`)
  so a re-run of `init` stays unchanged (R36).
- Environment semantics follow the source: OpenCode's disable flags are true only for
  `true`, `yes`, `on`, `1` and `y` (R33), and on V1 `OPENCODE_CONFIG_DIR` is additive to the XDG
  config directory while V2 replaces it, so the root registry lists both (R37).

## Consequences

- One code path and one set of tests serves both lines.
- The V2 native `permissions` array always outranks V1-derived rules; `init` reports this as a
  note (R34), not a conflict.
- OpenCode matches raw command text, so quoted or extra-spaced subcommands bypass the ask entries
  (R35). We do not widen the patterns.
- If V1 is dropped, the adapter keeps working on V2 through migration.
