# CLI reference

`dynamic-skills` is driven one command at a time by a host agent. This page is the contract:
commands, flags, preconditions, stdout fields, exit codes and error codes. The agent runs the bare
`dynamic-skills` command from `PATH`. Package runners are deliberately not used: they can fetch
and run an unrelated registry package of the same name without asking (Ruling R19). If the
command is missing, the agent stops and asks the user to install it. The architecture is in
[architecture.md](architecture.md) and the package view in the [CLI README](../packages/cli/README.md).

## Output contract

- Every command prints exactly one JSON object on stdout. It always has `ok` and
  `schemaVersion: "1"`. A failure adds `error` (a code from the table below) and `message`.
- stderr carries a human status block, with these variants. A thrown error (for example
  `INVALID_STATE` or `SCHEMA_INVALID`) prints only the one-line `Error <CODE>: <message>`, with no
  status block. `TIMEOUT` prints the status block without an `Error` line. A saved failure
  (`EVAL_ATTEMPTS_EXHAUSTED`, an `evaluate` `BUNDLE_INVALID`, `compile`'s `BASE_CHANGED`, a refused
  `activate`) prints the `Error` line and then the status block. A command-line parse error (bad
  choice, missing option or subcommand, unknown command) prints `Error USAGE: <message>` and no
  status block. A session that has ended
  (`completed`, `warning`, `failed`, `timeout`) shows `Processing SLA: STOPPED`: its clock stops
  when it ends, so the active time shown stays the same afterwards. Control characters other than newline are removed from everything written
  to stderr.
- Two commands differ. `status` prints its status block as **plain text on stdout** (nothing on
  stderr). `report perf` prints JSON on stdout and **no status block** on stderr, because it has no
  session.
- `--help` prints `{"ok":true,"schemaVersion":"1","help":true}` on stdout and the help text on
  stderr. A usage error is a `USAGE` JSON error on stdout and `Error USAGE: <message>` on stderr.
- Documents the agent supplies (`--file`) are strictly validated; the JSON Schemas are written to
  `schemas/` in the session by `discover`.

## Exit codes

| Code | Meaning                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| 0    | Success. An evaluation that finds problems still exits 0 (`activatable` says whether to revise). |
| 1    | Usage or state error: nothing was saved, except `compile`'s `BASE_CHANGED` (a saved failure)     |
| 2    | Evaluation gate failed: `BUNDLE_INVALID`, `EVAL_ATTEMPTS_EXHAUSTED` or `ACTIVATION_REFUSED`      |
| 3    | Timeout: the active budget was exceeded, or `activate` refused with reason `timeout`             |

## Version

`dynamic-skills --version` (or `-V`) prints `{"ok":true,"schemaVersion":"1","version":"<x.y.z>"}` on
stdout, nothing on stderr, and exits 0. The version is the published package version.

## Environment

The skill scan honours the variables that relocate harness skill roots (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR`; only absolute values are used) and the
admin skill root `/etc/codex/skills`. This applies to `assess`, `compile` and `evaluate`.

## Commands

Every command except `assess` and `report perf` takes `--session <id>`. A command may run only when
the session's last completed step is one of its allowed predecessors; otherwise it fails with
`INVALID_STATE` and `expected` lists the allowed steps. A session that has ended (`completed`,
`warning` or `failed`) accepts only `status` and `clean`. So does a `timeout` session: any other
command returns `TIMEOUT` again without saving.

| Command                          | Allowed after (completed step)                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `assess`                         | none (creates the session)                                                                                                                   |
| `discover`                       | `assess`                                                                                                                                     |
| `context request`                | `discover`, `context-request`, `context-submit`                                                                                              |
| `context submit`                 | `discover`, `context-request`, `context-submit`, `clarify-answer`                                                                            |
| `sufficiency submit`             | `context-submit`                                                                                                                             |
| `sufficiency approve`            | `sufficiency-submit`, with an approval pending                                                                                               |
| `clarify ask`                    | `context-submit`, `sufficiency-submit`, `sufficiency-approve`, `clarify-answer`, with a verdict recorded and no approval pending             |
| `clarify answer`                 | `clarify-ask`                                                                                                                                |
| `compile`                        | `context-submit`, `sufficiency-submit`, `sufficiency-approve`, `clarify-answer`, `evaluate`, with a verdict recorded and no approval pending |
| `evaluate`                       | `compile`, `evaluate`, `eval-record`                                                                                                         |
| `eval record`                    | `evaluate`                                                                                                                                   |
| `activate`                       | `eval-record`                                                                                                                                |
| `status`, `clean`, `report perf` | any state                                                                                                                                    |

One verdict is allowed per session, so a second `sufficiency submit` is `INVALID_STATE`.

### `assess --task <text> [--repo <path>] [--mode auto|suggest|manual] [--explicit]`

Creates the session, scans existing skills and instruction files, and applies the invocation-mode
gate. The budget is `DEFAULT_BUDGET_MS` unless the environment variable `DYNAMIC_SKILLS_BUDGET_MS`
(a positive integer, in milliseconds) is set. `--repo` is resolved to an absolute path.

stdout: `sessionId`, `recommendation` (`none` ends the session as skipped, otherwise `discover`),
`candidates` (ranked hints, never a reuse decision), `skills` (name, scope, scanned `path`),
`reason`, `instructionFiles`, `warnings`.

### `discover --session <id>`

Programmatic discovery, requirement derivation, gap analysis, semantic probes and the Context Packet.
Writes the six agent JSON Schemas.

stdout: `packetPath`, `packetRevision`, `packetTokens`, `schemaPaths` (`analysis`, `request`,
`sufficiency`, `clarificationRequest`, `clarificationResponse`, `smokeEval`), `evidenceCount`,
`gaps`, `semanticProbes`, `errors`, `truncated`. The `smokeEval` schema is exposed so the agent
learns the smoke-eval field types, caps and the behavioural-definition rule before it writes
`evals/smoke.json`, rather than spending an evaluation attempt guessing.

### `context request --session <id> --file <f>`

The agent asks for specific extra repository files. Files go through the safe-read rules (no secret
files, nothing outside the repository, bounded size). At most `MAX_CONTEXT_REQUEST_ROUNDS` (3)
rounds, `MAX_CONTEXT_REQUEST_FILES` (8) files per round. Every request uses a round, even if all
its files are rejected. Once the 3 rounds are used, a request is answered with every path rejected
as `round-limit` and uses no round.

stdout: `packetPath`, `packetRevision`, `added`, `rejected`, `roundsRemaining`.

After the last allowed analysis submission (`MAX_ANALYSIS_SUBMISSIONS`, 4) the command fails with
`ANALYSIS_LIMIT` and saves nothing. Otherwise a request after the final submission would leave the
session unable to reach `sufficiency submit`.

### `context submit --session <id> --file <f>`

Submits the Context Analysis Result. **Each submission must carry the complete analysis, because an
accepted submission replaces the previous one**: agentic evidence, `not-asked` assumptions and
`unknown.*` requirements are dropped and rebuilt. At most 4 accepted submissions per session.
Every list in the result holds at most `MAX_ANALYSIS_LIST_ITEMS` (50) items. An `observed` claim is
`verified` only when its source resolves to real, non-secret evidence; otherwise it is stored as
`inferred` and listed in `downgraded`.

stdout: `evidenceAdded`, `downgraded`, `assumptions`, `unknowns`, `conflicts`, `gaps`,
`inspectGapsRemaining`, `submissionsRemaining`, `warnings`.

An accepted submission sets the session status to `analysing` (status label "Analysing"); a
rejected one changes nothing.

### `sufficiency submit --session <id> --file <f>`

Records the agent's verdict: `sufficient`, `partial` or `insufficient`. The base skill must match a
scanned skill by exact string equality of name and scanned path (the agent copies the path from
`skills-scan.json`); the CLI stores the scanned path and the sha256 of the base `SKILL.md`. A base
is only ever read.

- `sufficient`: the existing skill is returned unchanged in `reused` and the session ends as
  reused (exit 0, no compile).
- `partial`: an augmentation will be generated against the pinned base.
- `insufficient`: a new skill will be generated.
- Unless the verdict ends or pauses the session, the status is `assessing` (label "Assessing skill
  coverage") until `compile` sets `generating`.
- In `suggest` mode without `--explicit`, a non-`sufficient` verdict leaves approval `pending`
  and pauses the SLA.

stdout: `outcome`, `baseSkill`, `approval` (`not-required`, `pending`), `reused`
(`{path, content, notice}` or `null`), `next` (`done`, `approve`, `clarify-or-compile`).
Errors: `SCHEMA_INVALID`, `VERDICT_INVALID` (with `issues`).

### `sufficiency approve --session <id> --decision approve|decline`

The user's decision in suggest mode. Resumes the SLA and books the wait as human time. A decline
ends the session as skipped.

stdout: `approval` (`approved` or `declined`), `fallback` (text on decline, otherwise `null`).

### `clarify ask --session <id> --file <f>`

Proposes a round of questions. The manager rejects (in order) `round-limit`, `not-material`,
`answerable-by-evidence`, `answerable-by-discovery` and `duplicate` questions. Accepting at least
one uses a round (at most `MAX_CLARIFICATION_ROUNDS`, 3) and pauses the SLA. A call that accepts
nothing records no step, so the agent may still ask a better question or compile. A question `id`
must match the Agent Skills name pattern (1-64 lowercase letters, digits and single hyphens, for
example `r1-q1`); `text` is at most 1000 characters and `requirement` 200. Anything else is
`SCHEMA_INVALID`.

stdout: `round`, `accepted`, `rejected`.

### `clarify answer --session <id> --file <f>`

Applies the user's answers and resumes the SLA. Answered questions become verified `user.<id>`
evidence (plus `user.<requirement>` for a human-only requirement); declined, skipped or unanswered
ones become recorded assumptions. Unknown or blank answers are a `USAGE` error.

A blocking question left unresolved (declined, skipped or unanswered) can never be cleared and
activation would be refused, so the CLI ends the session there, as for a declined approval
(Ruling R20): status `completed`, outcome `skipped`, `reports/performance.json`, `discovery.json`
and `assumptions.json` written. Any later pipeline command is `INVALID_STATE` with `expected: []`.

stdout: `evidenceAdded`, `assumptions`, `blockingUnresolved`, `warnings`, and `fallback` when the
session ended.

### `compile --session <id>`

Writes `brief.md` and creates `skills/` and `evals/`. Requires a validated analysis. For an
augmentation the base must still hash to the pinned sha256, otherwise `BASE_CHANGED`. Because one
verdict is allowed per session, a changed base can never be fixed, so `BASE_CHANGED` is a **saved
terminal failure** (Ruling R20): status and outcome `failed`, reports written, `fallback` on
stdout, exit 1. `compile` may also run after `evaluate`, to start over from the brief.

stdout: `briefPath`, `skillsDir`, `skillPath` (augmentation only), `mode` (`new` or `augmentation`),
`smokeEvalPath`, `remainingMs`.

### `evaluate --session <id>`

Runs the 14 generation evals on the bundle in `skills/` and `evals/smoke.json`. Each call consumes
one of `MAX_EVAL_ATTEMPTS` (3: the first plus two revisions). A passing or failing report still
exits 0; `activatable` and `revisionHints` tell the agent what to fix. Whenever the evals run, pass
or fail, it **pins a sha256 digest of the evaluated bundle** (everything under `skills/` plus `evals/smoke.json`,
directories included, at most 500 entries and 5 MB, symlinks refused).

`evaluate` may follow `compile`, another `evaluate` or `eval record`. After a failed evaluation or
a failed behavioural result the agent revises the bundle and evaluates again, bounded by the
attempt limit.

stdout: `overall`, `activatable`, `results`, `limitations`, `revisionHints`, `attempt`,
`attemptsRemaining`. Failure modes are saved with exit 2: `BUNDLE_INVALID` (the bundle is missing,
malformed, over the caps or changed while it was being evaluated; the attempt is consumed and the
pin cleared) and `EVAL_ATTEMPTS_EXHAUSTED` (returned when the agent runs a fourth `evaluate`, for
example after an activatable third attempt; it ends the session as failed with `fallback`).

**Last attempt (Ruling R22).** When the attempt just spent leaves `attemptsRemaining` at 0 and the
result is not activatable, the CLI ends the session itself: status and outcome `failed`, the
clock stops, `performance.json`, `discovery.json` and `assumptions.json` are written (and
`evaluation.json` is kept), and stdout adds `fallback`. For a failed evaluation `ok` stays `true`
and the exit code stays 0, as for any evaluation that finds problems; for a `BUNDLE_INVALID`
attempt the document is the same error as before (exit 2) plus `fallback`. The agent stops
synthesis and continues the task. A last attempt that is activatable stays open for `eval record`
and `activate`.

### `eval record --session <id> --output <f> --verdict pass|fail [--notes <text>]`

Records the agent's behavioural smoke result. The assertions in `evals/smoke.json` are checked
against the output file (regexes run in a worker under a total budget of one second) and combined
with the agent's rubric verdict into the `behavioural` result in `reports/evaluation.json`.

The bundle must still match the digest pinned by `evaluate`; otherwise the command fails with
`BUNDLE_INVALID` (exit 2) and **nothing is saved**. It also fails with `BUNDLE_INVALID` when
`evals/smoke.json` is missing or not a valid smoke eval.

stdout: `outcome`, `messages`. When `outcome` is `fail` and all `MAX_EVAL_ATTEMPTS` attempts are
used, the session ends as `failed` with reports (Ruling R22) and stdout adds `fallback`; `ok`
stays `true` and the exit code stays 0, because the recording itself succeeded. With attempts
left, a `fail` leaves the session open for a revision and another `evaluate`.

### `activate --session <id>`

The final, gated step. First the bundle digest is checked (`BUNDLE_INVALID`, exit 2, nothing saved
when it changed). Then the activation checks run in order: deadline, pending clarifications, base
integrity, the evaluation report, the behavioural result.

- Success: `activated: true`, `kind` (`generated` or `augmented`), `skillPath`, `content`, `base`
  (the unchanged base, `augmented` only), `loadOrder` (base first), `limitations`, `notice`.
- Refusal (saved, session ends as failed, exit 2; exit 3 when `reason` is `timeout`):
  `ok: false`, `error` (`ACTIVATION_REFUSED`, or `TIMEOUT` when `reason` is `timeout`), `message`
  (derived from the reason), `activated: false`, `reason` (`timeout`, `blocked-by-clarification`,
  `base-changed`, `evaluation-failed`, `behavioural-missing`), `fallback`. A refusal with reason
  `timeout` leaves the session status as `timeout`. Reports (`performance.json`, `discovery.json`,
  `assumptions.json`, and `evaluation.json` when one exists) are written for every outcome.

### `status --session <id>`

Read-only. Prints the status block as plain text on stdout. Works on any session, including one
that has timed out.

### `clean --session <id>`

First archives the session's `reports/performance.json`, when the session has ended with a valid
report, to `<home>/reports/<sessionId>.json` (file mode 0600, directory 0700, never through a
symlink), then removes the session directory (Ruling R21: cleaning never erases the metrics).
Always allowed, including on a timed-out session. A session that has not ended is first ended
(Ruling R22) as `timeout` if its budget has run out, otherwise `failed`. Idle time after the
budget ran out is not counted as active time (a last command that itself ran past the deadline
keeps that overrun). Terminal reports are written, so abandoning a session still counts in
`fallbackRate`. If the archive cannot be written the command fails and nothing is removed.

stdout: `removed: true`, `archived` (whether a report was archived).

### `report perf`

Needs no session or lock and is allowed anywhere; read-only. Aggregates
`reports/performance.json` over all sessions under the session home together with the reports
archived by `clean` in `<home>/reports/`, counting each session id once. Symlinked, special,
oversized, unparseable or wrong-version reports are skipped.

stdout: `count`, `p50ActiveMs`, `p95ActiveMs`, `maxActiveMs`, `timeoutRate`, `fallbackRate`,
`reuseRate`, `augmentationRate`, `cacheHitRate`, `avgClarificationRounds`, `avgContextRequests`.
Percentiles are `null` when there are no sessions.

## Error codes

| Code                      | Exit | Meaning                                                                           | Saved?    |
| ------------------------- | ---- | --------------------------------------------------------------------------------- | --------- |
| `USAGE`                   | 1    | Bad flag, empty value, unreadable `--file`, blank answer                          | no        |
| `SESSION_NOT_FOUND`       | 1    | No such session (a symlinked session directory counts as unknown)                 | no        |
| `SESSION_LOCKED`          | 1    | Another command holds the session lock                                            | no        |
| `HOME_UNSAFE`             | 1    | The session home or `sessions/` is a symlink, not a directory, or another user's  | no        |
| `INVALID_STATE`           | 1    | The state machine refuses the command; `expected` lists the allowed steps         | no        |
| `SCHEMA_INVALID`          | 1    | A document failed strict validation; `issues: [{path, message}]`                  | no        |
| `VERDICT_INVALID`         | 1    | The sufficiency verdict failed validation against the scan, mode or explicit flag | no        |
| `ANALYSIS_LIMIT`          | 1    | `context submit` or `context request` after 4 accepted analyses                   | no        |
| `BASE_CHANGED`            | 1    | The base skill no longer hashes to the pinned sha256 (at `compile`)               | yes       |
| `ACTIVATION_REFUSED`      | 2    | `activate` refused; `reason` says why, `fallback` what to do                      | yes       |
| `BUNDLE_INVALID`          | 2    | The bundle is invalid, over a cap, or changed since `evaluate`                    | see below |
| `EVAL_ATTEMPTS_EXHAUSTED` | 2    | More than `MAX_EVAL_ATTEMPTS` evaluations (a 4th `evaluate`)                      | yes       |
| `TIMEOUT`                 | 3    | The active budget was exceeded; carries `fallback`                                | yes       |
| `INTERNAL`                | 1    | An unexpected failure                                                             | no        |

A handler that throws saves nothing, so the previous `session.json` is untouched. The exceptions,
which do save state because the session or the attempt count must change, are:

- `TIMEOUT`: the session is saved as `timeout`, `skills/` is deleted and reports are written.
- `EVAL_ATTEMPTS_EXHAUSTED`: the session is saved as `failed` with reports.
- `BUNDLE_INVALID` from `evaluate`: the attempt is consumed and the pin cleared, so a broken bundle
  cannot be retried without bound; on the last attempt the session is also saved as `failed` with
  reports and `fallback`. From `eval record` and `activate` it saves nothing.
- `BASE_CHANGED` from `compile`: the session is saved as `failed` with reports; no step is recorded.
- A refused `activate` (`ACTIVATION_REFUSED`, or `TIMEOUT` for reason `timeout`): the session is
  saved as `failed` (or `timeout`) and reports are written; no step is recorded.

## Session home

Sessions live in `DYNAMIC_SKILLS_HOME`, by default `<os tmpdir>/dynamic-skills-<uid>` (a per-user
directory). Before the first write of each command the home and `<home>/sessions` are checked: a
symlink, a non-directory or (where the platform has uids) a directory owned by another user is
refused with `HOME_UNSAFE`. The path is resolved first, so a symlink written with a trailing slash
is refused too. Only directories the store creates are tightened (Ruling R23): a missing home is
created 0700 and `<home>/sessions` loses any group or other bits, but an existing home keeps its
mode and is never chmodded, because a user-provided `DYNAMIC_SKILLS_HOME` may be a directory like
`$HOME`. Session directories are created 0700 and files 0600.
