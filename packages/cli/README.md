# @dynamic-skills/cli

The `dynamic-skills` command line: a thin, deterministic wrapper that lets a host agent drive the
just-in-time skill pipeline one JSON-in, JSON-out step at a time. It makes no model calls; all
reasoning is done by the agent, which submits schema-checked documents. This package holds the
command framework, the session state machine and the first half of the commands
(`assess` to `clarify`); compilation, evaluation, activation, `status` and `clean` follow in the
next task.

Every command prints exactly one JSON object on stdout (always with `ok` and `schemaVersion: "1"`)
and a human status block on stderr. Exit codes: `0` ok, `1` usage or state error, `2` evaluation
gate failed, `3` timeout.

## API

- **`runCli(argv, env?)`** (`src/run.ts`): in-process entry returning
  `{ exitCode, stdout, stderr }`. `env` may set `home` (session root), `cwd`, `userHome` (where
  personal skills are scanned) and `now` (clock), which keeps tests hermetic. `src/index.ts` is the
  bin: it calls `runCli(process.argv.slice(2))` and writes the streams.
- **`assertCanRun(state, command)`** (`src/state-machine.ts`): the session state machine. Throws a
  `CliError` with code `INVALID_STATE` and `expected: string[]` unless the last completed step is
  an allowed predecessor of `command`. Also enforces one verdict per session, a pending approval
  before `clarify ask` and `compile`, and that finished sessions accept nothing but `status` and
  `clean`.
- **`CliError`** and **`parseDocument(schema, text)`** (`src/io.ts`): expected failures with a
  stable code (`SESSION_NOT_FOUND`, `SESSION_LOCKED`, `INVALID_STATE`, `USAGE`, `ANALYSIS_LIMIT`,
  `BASE_CHANGED`, `SCHEMA_INVALID`, `VERDICT_INVALID`, `TIMEOUT`) and strict validation of agent
  documents with `issues: { path, message }[]`.
- **`COMMANDS`** (`src/commands/index.ts`): the command registry. A command is a `CommandDef`
  (name, options, completed step, stage and a `run` handler); the shared wrapper loads the session
  under its lock, enforces the active-time deadline, checks the state machine, runs the handler,
  records the stage and step, saves and prints. A handler that throws saves nothing. To add a
  command, append a definition to `COMMANDS` and a name to `CliCommand`.

### Commands

| Command                                                          | Effect                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `assess --task <t> [--repo <p>] [--mode m] [--explicit]`         | Creates the session, scans existing skills, applies the invocation-mode gate.                  |
| `discover --session <id>`                                        | Programmatic discovery, requirements, gaps, probes, Context Packet and the agent JSON Schemas. |
| `context request --session <id> --file <f>`                      | Adds requested repository files to the packet under the safe-read rules (3 rounds).            |
| `context submit --session <id> --file <f>`                       | Consolidates the agent's analysis; each accepted submission replaces the last (4 per session). |
| `sufficiency submit --session <id> --file <f>`                   | Records the verdict; `sufficient` reuses the base unchanged and ends the session.              |
| `sufficiency approve --session <id> --decision approve\|decline` | Suggest mode: resumes the SLA; a decline ends the session as `skipped`.                        |
| `clarify ask --session <id> --file <f>`                          | Asks up to 3 rounds of questions and pauses the SLA.                                           |
| `clarify answer --session <id> --file <f>`                       | Applies answers (evidence or assumptions) and resumes the SLA.                                 |

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

§5.4 (invocation modes), §5.5 (skill sufficiency), §6.4-§6.8 (Context Packet exchange), §10.1-§10.8
(SLA, clarification, status, reports), §13 (CLI contract).
