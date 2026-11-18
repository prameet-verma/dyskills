# @dynamic-skills/cli

The `dynamic-skills` command line: a thin, deterministic wrapper that lets a host agent drive the
just-in-time skill pipeline one JSON-in, JSON-out step at a time. It makes no model calls; all
reasoning is done by the agent, which submits schema-checked documents. This package holds the
command framework, the session state machine and every command, from `assess` to `activate`, plus
`status`, `clean` and `report perf`.

Every command prints exactly one JSON object on stdout (always with `ok` and `schemaVersion: "1"`)
and a human status block on stderr; the exceptions are `status`, which prints its block as plain
text on stdout, and `report perf`, which has no session and so writes no status block to stderr. `--help` prints `{"ok":true,"schemaVersion":"1","help":true}` on stdout and the help
text on stderr. Exit codes: `0` ok, `1` usage or state error, `2` evaluation gate failed (including
a refused activation), `3` timeout. Everything written to stderr has control characters (other than
newline) removed, because session ids and option values are agent-controlled.

## API

- **`runCli(argv, env?)`** (`src/run.ts`): in-process entry returning
  `{ exitCode, stdout, stderr }`. `env` may set `home` (session root), `cwd`, `userHome` (where
  personal skills are scanned), `now` (clock), `vars` (environment, default `process.env`),
  `probe` (host binary lookup, default `createHostProbe(vars)`) and `etcDir` (default `/etc`),
  which keeps tests hermetic. `dynamic-skills --version` prints
  `{ "ok": true, "schemaVersion": "1", "version" }`. `src/index.ts` is the
  bin: it calls `runCli(process.argv.slice(2))` and writes the streams.
  The package exports only `runCli`, `CliOutcome` and `CliEnv`. The items below are **internal
  extension points** for adding commands inside this package; they are not part of the public API.

- **`buildHostEnv(input)`** (internal, `src/host.ts`): builds the adapter `HostEnv` with realpaths;
  `dryRun` resolves the session home without creating it and maps path errors to `HOME_UNSAFE`.
- **`assertCanRun(state, command)`** (internal, `src/state-machine.ts`): the session state machine.
  Throws a `CliError` with code `INVALID_STATE` and `expected: string[]` unless the last completed
  step is an allowed predecessor of `command`. Also enforces one verdict per session, a pending
  approval before `clarify ask` and `compile`, and that finished sessions accept nothing but
  `status` and `clean`.
- **`CliError`** and **`parseDocument(schema, text)`** (internal, `src/io.ts`): expected failures
  with a stable code (`SESSION_NOT_FOUND`, `SESSION_LOCKED`, `HOME_UNSAFE`, `INVALID_STATE`,
  `USAGE`, `ANALYSIS_LIMIT`, `BASE_CHANGED`, `ACTIVATION_REFUSED`, `SCHEMA_INVALID`,
  `VERDICT_INVALID`, `BUNDLE_INVALID`, `EVAL_ATTEMPTS_EXHAUSTED`, `INIT_CONFLICT`,
  `HARNESS_NOT_DETECTED`, `TIMEOUT`) and strict validation of agent documents with
  `issues: { path, message }[]`.
- **`ADAPTERS`, `HARNESS_IDS`, `parseHarnessList`, `currentHarness`** (internal,
  `src/adapters.ts`): the adapter registry (`claude-code`, `codex`, `opencode`) and the only CLI
  file that names harnesses; `--harness` help text is built from `HARNESS_IDS`. `parseHarnessList`
  takes a comma list (alias `claude`), de-duplicates it and raises `USAGE` for an unknown name;
  `currentHarness` reads the flag, else `DYNAMIC_SKILLS_HARNESS` (an invalid value is `null`).
- **`COMMANDS`** (internal, `src/commands/index.ts`): the command registry. A command is a
  `CommandDef` (name, options, completed step, stage and a `run` handler); the shared wrapper loads
  the session under its lock, enforces the active-time deadline, checks the state machine, runs the
  handler, records the stage and step, saves and prints. A handler that throws saves nothing; one
  that returns `exitCode` and `error` is a failure that is saved (a failed evaluation attempt, a
  refused activation, a changed base at `compile`). When the handler ends the session the wrapper
  stops its SLA clock before writing the terminal reports (`performance`, `discovery`,
  `assumptions`). To add a command, append a definition to `COMMANDS` and a name to
  `CliCommand`. A definition's `kind` is `session` (loaded under the lock), `create` (`assess`)
  or `global` (no session, no lock, no state machine: `report perf`, `init`). `runCli` rejects any
  argument before the subcommand (Ruling R31) except a lone `-V`/`--version`/`-h`/`--help` and `help <command>` (which only prints help).

- **`bundleDigest(sessionDir)`, `assertBundlePinned(state, sessionDir)`, `MAX_BUNDLE_BYTES`**
  (internal, `src/commands/bundle.ts`): the bundle pin. `bundleDigest` hashes everything under
  `skills/` plus `evals/smoke.json` (directories included) and refuses symlinks and non-regular
  files, more than 500 entries (files and directories) and more than `MAX_BUNDLE_BYTES`
  (5,000,000) in total, each as `BUNDLE_INVALID`. `evaluate` stores the digest;
  `assertBundlePinned` makes `eval record` and `activate` fail with `BUNDLE_INVALID`, saving
  nothing, when the bundle changed or was never pinned.

### Commands

| Command                                                                                           | Effect                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assess --task <t> [--repo <p>] [--mode m] [--explicit]`                                          | Creates the session, scans existing skills, applies the invocation-mode gate.                                                                                                                                                      |
| `discover --session <id>`                                                                         | Programmatic discovery, requirements, gaps, probes, Context Packet and the six agent JSON Schemas (`schemaPaths`, including `smokeEval`).                                                                                          |
| `context request --session <id> --file <f>`                                                       | Adds requested repository files to the packet under the safe-read rules (3 rounds); `ANALYSIS_LIMIT` once all 4 analyses are used.                                                                                                 |
| `context submit --session <id> --file <f>`                                                        | Consolidates the agent's analysis; each accepted submission replaces the last (4 per session).                                                                                                                                     |
| `sufficiency submit --session <id> --file <f>`                                                    | Records the verdict; `sufficient` reuses the base unchanged and ends the session.                                                                                                                                                  |
| `sufficiency approve --session <id> --decision approve\|decline`                                  | Suggest mode: resumes the SLA; a decline ends the session as `skipped`.                                                                                                                                                            |
| `clarify ask --session <id> --file <f>`                                                           | Asks up to 3 rounds of questions and pauses the SLA.                                                                                                                                                                               |
| `clarify answer --session <id> --file <f>`                                                        | Applies answers (evidence or assumptions) and resumes the SLA; a blocking question left unresolved ends the session (skipped, `fallback`).                                                                                         |
| `compile --session <id>`                                                                          | Writes `brief.md` (needs a validated analysis) and prepares `skills/` and `evals/`; a changed augmentation base ends the session (`BASE_CHANGED`, saved).                                                                          |
| `evaluate --session <id>`                                                                         | Runs the 14 generation evals (3 attempts; allowed again after `eval record`) and pins the bundle digest; exit 2 `BUNDLE_INVALID` or `EVAL_ATTEMPTS_EXHAUSTED`.                                                                     |
| `eval record --session <id> --output <f> --verdict pass\|fail [--notes <t>]`                      | Checks the smoke-eval assertions against the agent's output (regexes run in a bounded worker) and stores the `behavioural` result. Exit 2 `BUNDLE_INVALID` if the bundle changed since `evaluate`.                                 |
| `activate --session <id>`                                                                         | Gated activation (also `BUNDLE_INVALID` if the bundle changed since `evaluate`): returns the skill (and the unchanged base first); `ACTIVATION_REFUSED` exit 2, 3 on timeout.                                                      |
| `status --session <id>`                                                                           | Prints the status block as plain text on stdout; read-only.                                                                                                                                                                        |
| `clean --session <id>`                                                                            | Archives `reports/performance.json` to `<home>/reports/<id>.json`, then removes the session directory.                                                                                                                             |
| `init [--harness l] [--scope s] [--repo p] [--dry-run] [--force] [--native] [--codex-allow-rule]` | Installs the bootstrap skill and consent rules into each harness (`claude-code`, `codex`, `opencode`); previews all first and writes nothing on any conflict; idempotent; `--dry-run` writes nothing. See `docs/cli-reference.md`. |
| `report perf`                                                                                     | Aggregates live and archived performance reports, once per session (count, p50/p95/max active ms, timeout, fallback, reuse, augmentation rates). No session or lock; read-only.                                                    |

## Example

```ts
import { runCli } from "@dynamic-skills/cli";

const { stdout } = await runCli(["assess", "--task", "Add caching to order reads"]);
const { sessionId } = JSON.parse(stdout);
await runCli(["discover", "--session", sessionId]);
```

Phase 1 writes only inside `$DYNAMIC_SKILLS_HOME/sessions/<id>/`. Existing skills and instruction
files are only ever read.

## PRD sections implemented

§5.4 (invocation modes), §5.5 (skill sufficiency, augmentation), §8-§9 (compilation, evaluation),
§11 (activation), §6.4-§6.8 (Context Packet exchange), §10.1-§10.8
(SLA, clarification, status, reports), §13 (CLI contract).
