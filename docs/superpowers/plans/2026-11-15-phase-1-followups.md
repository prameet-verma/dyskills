# Phase 1 Follow-ups (input to the Phase 2 plan)

Phase 1 (JIT Core Engine) merged into `main` at f00638f on 2026-11-15. This file keeps the decisions and
deferred findings from the Phase 1 execution ledger, which was not committed. The Phase 2 plan must either
schedule each item below or say explicitly why it is dropped.

## Not yet done at merge

- **Gate item 7 (human live smoke):** `scripts/live-smoke.sh` has not been run yet. This leaves AC 3
  (autonomous invocation) and the live part of AC 8 unverified, and the 60 s budget has not been measured
  with a real agent. Three things can't be checked without running it:
  - whether the agent's skill and subagent tools need explicit grants in print mode;
  - whether compound shell commands (`cd … && dynamic-skills …`) match the `Bash(dynamic-skills:*)`
    allow rule;
  - whether macOS `/var` → `/private/var` affects `--add-dir`.

## Decisions to carry forward

- **R19 — CLI invocation:** the CLI is always invoked as the bare `dynamic-skills` binary, never through a
  package runner. Before Phase 2 ships an installer it must do one of two things:
  - publish under a name the project owns (reserve `dynamic-skills` on npm);
  - install the scoped `@dynamic-skills/cli` and put its bin on `PATH`.

  The roadmap's `npx dynamic-skills init` wording must follow whichever is chosen.
- **R22 — unended sessions (parked, Important for metrics):** in two cases the skill stops but the session
  never reaches a terminal state:
  - the last `evaluate` attempt fails (`attemptsRemaining: 0`);
  - `eval record` returns `outcome: fail` on the last attempt.

  In both cases no `performance.json` is written, `clean` archives nothing, and `report perf`
  under-counts `fallbackRate` (PRD §17). Fix by making `evaluate` / `eval record` end the session
  `failed`/`failed` when no attempts remain. Alternatively, or as a catch-all, `clean` writes terminal
  reports for an unended session before archiving. Also correct `docs/architecture.md` "Terminal
  outcomes", which currently claims every dead-end path ends the session.
- **R23 — session home (parked):**
  - `ensurePrivateDir` chmods a user-provided `DYNAMIC_SKILLS_HOME` to 0700. If that is `$HOME`, the
    user's home directory gets tightened. Only tighten directories the store creates; on the home itself,
    keep the symlink and owner checks only.
  - A trailing-slash symlinked home bypasses the `lstat`. Fix with `path.resolve(home)` before the
    `lstat`.

## Final-review minors carried to Phase 2

- **M4 (do before adding adapters):** one safe base-skill reader and shared constants in core.
  - `BOOTSTRAP_SKILL` is defined three times: `bootstrapper/src/sufficiency.ts`, `bootstrapper/src/coverage.ts`
    and `cli/src/commands/bundle.ts`.
  - The fallback text is defined three times: `cli/src/io.ts`, `cli/src/commands/sufficiency.ts` and
    `activation/src/activate.ts`.
  - There are two base readers with different safety. `cli/src/io.ts` `readBaseSkillFile` is safe;
    `activation/src/activate.ts` and evidence-registry `fingerprintFile` use plain uncapped `readFile`.
  - `sufficiency.ts` re-fingerprints instead of using `read.sha256`.
- **M3:** the status block shows `Discovering` through `context submit` / `sufficiency submit`. Add an
  `analysing` status, or set `assessing` on `sufficiency submit`.
- **M6:** clarification question ids are an unconstrained `z.string()` (`core/src/schemas.ts`). Constrain
  them to the `SkillNameSchema` pattern, and add `.max()` to `text`, `requirement` and `value`, so that
  `[assumption: id]` stays citable.
- **M7:** commander parse errors print commander text instead of `Error USAGE:`. Align either the output
  or `docs/cli-reference.md`.
- **Secrets pattern:** in `discovery/src/secrets.ts`, `/^secrets\./` also hides ordinary source files
  (`secrets.ts`, `secrets.py`). It fails safe, but should be limited to config extensions.
- **Test gap:** `discovery` has no concurrency test of its own (AC 13 is proven through `mapConcurrent`
  and context-packet). Add an in-flight-count test around `runDiscovery`.

## Deferred minors (low impact, schedule opportunistically)

- **core/session:**
  - stale-lock reclaim race;
  - a lock vanishing between EEXIST and stat reports SESSION_LOCKED;
  - `withLock` mkdirs an unknown id at the API level;
  - `resolveInside` rejects names like `..foo`;
  - session report writes follow a planted `reports/` symlink and are not atomic;
  - missing `@param`/`@throws` on several methods.
- **evidence-registry:**
  - a fresh `conflicting` add stores `conflicts: []`;
  - `slice(0, 499)` can split a surrogate pair;
  - git `execFile` inherits `GIT_DIR`.
- **discovery:**
  - abort is not checked during the index walk;
  - errors arrive in completion order;
  - `collectDeps` parses twice;
  - entrypoints are uncapped at any depth;
  - README detection is case-sensitive.
- **context-analyzer:**
  - `user.*` evidence of any confidence counts as verified;
  - `policy`/`schema` substrings trigger human-only asks (mitigated by §9.3 materiality).
- **bootstrapper:** a UTF-8 BOM breaks frontmatter; an empty name or description is accepted.
- **skill-compiler:**
  - `basePath` is unused in the brief input (plan-mandated);
  - single-quoted link titles, reference-style definitions and indented code are not handled.
- **eval-engine:**
  - `securityEval` is heuristic: quoted command words, `${IFS}` forms, and no total cap across
    referenced files. Phase 4 deepens it.
  - Unchecked paragraph claims in Project context; setext headings bypass the augmentation allow-list.
  - An emoji inside a citation opener is not flagged.
  - A worker crash is reported as "timed out" (fails closed).
- **activation:** dead-code narrowing; `activationMs` excludes report writes.
- **cli:**
  - `BUNDLE_INVALID` message wording (root-is-file, unreadable dir, entry-cap text);
  - Dirent→lstat swap race (accepted);
  - the README `## API` long line.
- **scripts/live-smoke.sh:** file tools are not path-scoped. Consider deny rules for the harness skill dirs.
- **docs:**
  - the docs-test inline-span regex could swallow a prose link if a span wraps lines;
  - the SECURITY "Writes stay in the session directory" heading reads as absolute;
  - a code span wraps at `clarification-manager/README.md:19-20`.
- **tooling:** `eslint-plugin-jsdoc` is one patch behind (pnpm `minimumReleaseAge`); the CI workflow is
  untested until the first push.

## Controller rulings made during Phase 1

| # | Ruling | Cost if wrong |
|---|---|---|
| R1 | Status prints the configured budget, not a literal 60 s | trivial |
| R2 | (superseded) step names are the Task 15 list | rename |
| R3 | `status`/`clean` bypass the TIMEOUT exit | small |
| R4 | Bootstrap skill has the five required sections; no version tokens or harness names | none |
| R5 | Every package README has `## API` | none |
| R6 | No LICENSE until the maintainer picks one | — |
| R7 | Humanonly gaps are answered by `user.<requirementId>`, aliased from clarify answers | humanOnly gaps never close |
| R8 | Gate-3 allow-list includes `core/src/schemas.ts` (Harness enum) | none |
| R9 | Base skill matched by exact scanned path | agent must copy the path verbatim |
| R10 | Conflicts/assumptions/gaps rendered inside the untrusted fence | none |
| R11 | One linear citation grammar, one key per tag | agents write one key per tag |
| R12 | Version rule skips §-numbers, dotted quads and v-prefixes | false hints |
| R13 | Agent regex assertions run in one Worker with a 1 s budget; ≤ 50 assertions | ~ms per `eval record` |
| R14 | `evaluate` pins the bundle digest; `eval record`/`activate` refuse a changed bundle | one hash pass per command |
| R15 | `evaluate` may follow `eval-record` (revise after behavioural fail) | none |
| R16 | `status` prints plain text on stdout | none |
| R17 | `context request` after the last allowed analysis → `ANALYSIS_LIMIT` | none |
| R18 | `discover` exposes `schemaPaths.smokeEval` | one more schema file |
| R19 | Bare `dynamic-skills` bin, never a package runner | bin must be on PATH |
| R20 | CLI ends blocked sessions (completed/skipped) and `BASE_CHANGED` at compile (failed/failed) | agent cannot "try anyway" |
| R21 | `clean` archives `performance.json` to `<home>/reports/<id>.json` | one small file per cleaned session |
| R22 | (parked) unended sessions after the last failed attempt | `fallbackRate` under-counted |
| R23 | (parked) user-provided home chmod; trailing-slash symlink | `DYNAMIC_SKILLS_HOME=$HOME` gets tightened |

Per-task rulings, as recorded in the ledger:
- Task 4: keys and sources are sanitised at render time.
- Task 5: symlink-follow and case-sensitive secret matching fixed as must-fix.
- Task 7: `orm` word-bounded, `sql` substring.
- Task 9a/9b: strict schemas at every level and full private-key redaction win over the plan text.
- Task 9: pending-only, non-blank answers, unique question ids.
- Task 11: negated dangerous mentions still fail; referenced files are scanned.
