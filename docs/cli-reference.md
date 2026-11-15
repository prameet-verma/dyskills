# CLI reference

`dynamic-skills` is driven one command at a time by a host agent. This page is the contract:
commands, flags, preconditions, stdout fields, exit codes and error codes. The architecture is in
[architecture.md](architecture.md) and the package view in the [CLI README](../packages/cli/README.md).

## Output contract

- Every command prints exactly one JSON object on stdout. It always has `ok` and
  `schemaVersion: "1"`. A failure adds `error` (a code from the table below) and `message`.
- stderr carries a human status block, with these variants. A thrown error (for example
  `INVALID_STATE` or `SCHEMA_INVALID`) prints only the one-line `Error <CODE>: <message>`, with no
  status block. `TIMEOUT` and a refused `activate` print the status block without an `Error` line.
  A saved `EVAL_ATTEMPTS_EXHAUSTED` or an `evaluate` `BUNDLE_INVALID` prints the `Error` line and
  then the status block. Control characters other than newline are removed from everything written
  to stderr.
- Two commands differ. `status` prints its status block as **plain text on stdout** (nothing on
  stderr). `report perf` prints JSON on stdout and **no status block** on stderr, because it has no
  session.
- `--help` prints `{"ok":true,"schemaVersion":"1","help":true}` on stdout and the help text on
  stderr. A usage error is a `USAGE` JSON error.
- Documents the agent supplies (`--file`) are strictly validated; the JSON Schemas are written to
  `schemas/` in the session by `discover`.

## Exit codes

| Code | Meaning                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| 0    | Success. An evaluation that finds problems still exits 0 (`activatable` says whether to revise). |
| 1    | Usage or state error: nothing was saved                                                          |
| 2    | Evaluation gate failed: `BUNDLE_INVALID`, `EVAL_ATTEMPTS_EXHAUSTED` or a refused `activate`      |
| 3    | Timeout: the active budget was exceeded, or `activate` refused with reason `timeout`             |

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

### `sufficiency submit --session <id> --file <f>`

Records the agent's verdict: `sufficient`, `partial` or `insufficient`. The base skill must match a
scanned skill by exact string equality of name and scanned path (the agent copies the path from
`skills-scan.json`); the CLI stores the scanned path and the sha256 of the base `SKILL.md`. A base
is only ever read.

- `sufficient`: the existing skill is returned unchanged in `reused` and the session ends as
  reused (exit 0, no compile).
- `partial`: an augmentation will be generated against the pinned base.
- `insufficient`: a new skill will be generated.
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
nothing records no step, so the agent may still ask a better question or compile.

stdout: `round`, `accepted`, `rejected`.

### `clarify answer --session <id> --file <f>`

Applies the user's answers and resumes the SLA. Answered questions become verified `user.<id>`
evidence (plus `user.<requirement>` for a human-only requirement); declined, skipped or unanswered
ones become recorded assumptions. Unknown or blank answers are a `USAGE` error.

stdout: `evidenceAdded`, `assumptions`, `blockingUnresolved`, `warnings`.

### `compile --session <id>`

Writes `brief.md` and creates `skills/` and `evals/`. Requires a validated analysis. For an
augmentation the base must still hash to the pinned sha256, otherwise `BASE_CHANGED`. `compile` may
also run after `evaluate`, to start over from the brief.

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
pin cleared) and `EVAL_ATTEMPTS_EXHAUSTED` (the session ends as failed with `fallback`).

### `eval record --session <id> --output <f> --verdict pass|fail [--notes <text>]`

Records the agent's behavioural smoke result. The assertions in `evals/smoke.json` are checked
against the output file (regexes run in a worker under a total budget of one second) and combined
with the agent's rubric verdict into the `behavioural` result in `reports/evaluation.json`.

The bundle must still match the digest pinned by `evaluate`; otherwise the command fails with
`BUNDLE_INVALID` (exit 2) and **nothing is saved**. It also fails with `BUNDLE_INVALID` when
`evals/smoke.json` is missing or not a valid smoke eval.

stdout: `outcome`, `messages`.

### `activate --session <id>`

The final, gated step. First the bundle digest is checked (`BUNDLE_INVALID`, exit 2, nothing saved
when it changed). Then the activation checks run in order: deadline, pending clarifications, base
integrity, the evaluation report, the behavioural result.

- Success: `activated: true`, `kind` (`generated` or `augmented`), `skillPath`, `content`, `base`
  (the unchanged base, `augmented` only), `loadOrder` (base first), `limitations`, `notice`.
- Refusal (saved, session ends as failed, exit 2; exit 3 when `reason` is `timeout`):
  `activated: false`, `reason` (`timeout`, `blocked-by-clarification`, `base-changed`,
  `evaluation-failed`, `behavioural-missing`), `fallback`. A refusal with reason `timeout` leaves
  the session status as `timeout`.

### `status --session <id>`

Read-only. Prints the status block as plain text on stdout. Works on any session, including one
that has timed out.

### `clean --session <id>`

Removes the session directory. Always allowed, including on a timed-out session.

stdout: `removed: true`.

### `report perf`

Needs no session or lock and is allowed anywhere; read-only. Aggregates
`reports/performance.json` over all sessions under the session home.

stdout: `count`, `p50ActiveMs`, `p95ActiveMs`, `maxActiveMs`, `timeoutRate`, `fallbackRate`,
`reuseRate`, `augmentationRate`, `cacheHitRate`, `avgClarificationRounds`, `avgContextRequests`.
Percentiles are `null` when there are no sessions.

## Error codes

| Code                      | Exit | Meaning                                                                           | Saved?    |
| ------------------------- | ---- | --------------------------------------------------------------------------------- | --------- |
| `USAGE`                   | 1    | Bad flag, empty value, unreadable `--file`, blank answer                          | no        |
| `SESSION_NOT_FOUND`       | 1    | No such session (a symlinked session directory counts as unknown)                 | no        |
| `SESSION_LOCKED`          | 1    | Another command holds the session lock                                            | no        |
| `INVALID_STATE`           | 1    | The state machine refuses the command; `expected` lists the allowed steps         | no        |
| `SCHEMA_INVALID`          | 1    | A document failed strict validation; `issues: [{path, message}]`                  | no        |
| `VERDICT_INVALID`         | 1    | The sufficiency verdict failed validation against the scan, mode or explicit flag | no        |
| `ANALYSIS_LIMIT`          | 1    | `context submit` or `context request` after 4 accepted analyses                   | no        |
| `BASE_CHANGED`            | 1    | The base skill no longer hashes to the pinned sha256 (at `compile`)               | no        |
| `BUNDLE_INVALID`          | 2    | The bundle is invalid, over a cap, or changed since `evaluate`                    | see below |
| `EVAL_ATTEMPTS_EXHAUSTED` | 2    | More than `MAX_EVAL_ATTEMPTS` evaluations                                         | yes       |
| `TIMEOUT`                 | 3    | The active budget was exceeded; carries `fallback`                                | yes       |
| `INTERNAL`                | 1    | An unexpected failure                                                             | no        |

A handler that throws saves nothing, so the previous `session.json` is untouched. The exceptions,
which do save state because the session or the attempt count must change, are:

- `TIMEOUT`: the session is saved as `timeout`, `skills/` is deleted and reports are written.
- `EVAL_ATTEMPTS_EXHAUSTED`: the session is saved as `failed` with reports.
- `BUNDLE_INVALID` from `evaluate`: the attempt is consumed and the pin cleared, so a broken bundle
  cannot be retried without bound. From `eval record` and `activate` it saves nothing.
- A refused `activate`: the session is saved as `failed` and reports are written; no step is recorded.
