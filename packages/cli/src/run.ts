import { lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONTRACT_VERSION,
  SessionNotFoundError,
  SessionStore,
  enforceDeadline,
  hasEnded,
  recordStage,
  renderStatus,
  resolveHome,
  stopClock,
} from "@dynamic-skills/core";
import type { SessionState } from "@dynamic-skills/core";
import { Command, CommanderError, Option } from "commander";
import { COMMANDS } from "./commands/index";
import type { CommandDef, CommandResult } from "./commands/types";
import { CliError, FALLBACK, stripControlChars, writeTerminalReports } from "./io";
import type { CliEnv } from "./io";
import { assertCanRun, isTerminal } from "./state-machine";

/** What {@link runCli} returns: the process exit code and the two output streams as text. */
export interface CliOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Exit code for a session that exceeded its active budget (PRD §10.1). */
const EXIT_TIMEOUT = 3;

/** Exit code for a failed evaluation gate (PRD §10.5). */
const EXIT_GATE = 2;

/** Error codes that are evaluation-gate failures rather than usage or state errors. */
const GATE_CODES: ReadonlySet<string> = new Set(["BUNDLE_INVALID", "EVAL_ATTEMPTS_EXHAUSTED"]);

/** Codes of the session store's own errors, reported as they are (each exits 1). */
const CORE_CODES: ReadonlySet<string> = new Set([
  "SESSION_NOT_FOUND",
  "SESSION_LOCKED",
  "HOME_UNSAFE",
]);

/** Line-terminated JSON for stdout. */
function jsonLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

/** Converts any thrown value into the error document and exit code (PRD §10.5, §13). */
function describeError(e: unknown): { exitCode: number; doc: Record<string, unknown> } {
  let code: string = "INTERNAL";
  let message = e instanceof Error ? e.message : "Unexpected failure.";
  let extra: Record<string, unknown> = {};
  if (e instanceof CliError) {
    code = e.code;
    extra = e.extra;
  } else if (e instanceof Error && CORE_CODES.has(String((e as { code?: unknown }).code))) {
    code = String((e as { code?: unknown }).code);
  }
  if (code === "TIMEOUT") message = "The active processing budget was exceeded.";
  return {
    exitCode: code === "TIMEOUT" ? EXIT_TIMEOUT : GATE_CODES.has(code) ? EXIT_GATE : 1,
    doc: { ok: false, schemaVersion: CONTRACT_VERSION, error: code, message, ...extra },
  };
}

/** What one wrapped command produces before it is rendered into {@link CliOutcome}. */
interface RunOutput {
  doc: Record<string, unknown>;
  /** The human status block for stderr. */
  status: string;
  exitCode: number;
  /** Plain-text stdout replacing the JSON document, when set. */
  text?: string;
  /** One-line error text for stderr in front of the status block, for a saved failure. */
  failure?: string;
}

/**
 * Completes a command that succeeded: stage timing, completed step, terminal reports, save.
 * Order matters: nothing is saved before every write that could fail has succeeded, so a failure
 * leaves the previous `session.json` untouched.
 */
async function finish(
  def: CommandDef,
  store: SessionStore,
  state: SessionState,
  result: CommandResult,
  startedAt: number,
  now: () => number,
): Promise<RunOutput> {
  const end = now();
  if (def.stage) recordStage(state, def.stage, Math.max(0, end - startedAt));
  // An ended session stops its clock before the reports are built, so the reported active time
  // is final and `status` shows the same number later (no-op if the handler already stopped it).
  if (hasEnded(state)) stopClock(state, end);
  if (def.step && result.recordStep !== false) state.completedSteps.push(def.step);
  try {
    if (result.writeReports) await writeTerminalReports(store, state, end);
    if (result.save !== false) await store.save(state);
  } catch (e) {
    await result.cleanup?.().catch(() => undefined);
    throw e;
  }
  const failure = result.error;
  return {
    doc: {
      ok: result.ok ?? failure === undefined,
      schemaVersion: CONTRACT_VERSION,
      ...(failure ? { error: failure.code, message: failure.message } : {}),
      ...result.data,
    },
    status: renderStatus(state, end),
    exitCode: result.exitCode ?? 0,
    text: result.text,
    failure: failure ? `Error ${failure.code}: ${failure.message}` : undefined,
  };
}

/**
 * Terminal timeout (PRD §10.1, §10.7): the unvalidated skill is deleted, reports are written and
 * the session is saved as `timeout`. Verified context files are kept.
 */
async function failOnTimeout(store: SessionStore, state: SessionState, now: number): Promise<void> {
  await rm(join(store.dir(state.id), "skills"), { recursive: true, force: true });
  await writeTerminalReports(store, state, now);
  await store.save(state);
}

/** Runs one session command under the session lock with the shared wrapper. */
async function runSessionCommand(
  def: Extract<CommandDef, { kind: "session" }>,
  env: Required<CliEnv>,
  opts: Record<string, string | boolean | undefined>,
): Promise<RunOutput> {
  const store = new SessionStore(env.home);
  const id = String(opts.session);
  // The home is checked first: an unsafe home is reported as such, never as an unknown session.
  await store.prepare();
  // withLock creates the directory, so an unknown id must be rejected before taking the lock.
  // lstat, so a symlinked session directory is unknown and no lock is written into its target.
  const exists = await lstat(store.dir(id)).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!exists) throw new SessionNotFoundError(id);

  return store.withLock(id, async () => {
    const state = await store.load(id);
    const startedAt = env.now();

    // A finished session keeps its outcome: its clock is stopped when it ends, and the deadline
    // only applies to sessions that are still in progress (PRD §10.1).
    if (!def.bypassDeadline && !isTerminal(state)) {
      const already = state.status === "timeout";
      if (already || enforceDeadline(state, startedAt)) {
        if (!already) await failOnTimeout(store, state, startedAt);
        const err = describeError(new CliError("TIMEOUT", "", { fallback: FALLBACK }));
        return { ...err, status: renderStatus(state, startedAt) };
      }
    }
    assertCanRun(state, def.name);
    // Handlers mutate `state` in place; a throw skips `finish`, so nothing is saved.
    const result = await def.run({
      store,
      state,
      opts,
      cwd: env.cwd,
      userHome: env.userHome,
      now: env.now,
    });
    return finish(def, store, state, result, startedAt, env.now);
  });
}

/** Runs the session-creating command (`assess`). */
async function runCreateCommand(
  def: Extract<CommandDef, { kind: "create" }>,
  env: Required<CliEnv>,
  opts: Record<string, string | boolean | undefined>,
): Promise<RunOutput> {
  const store = new SessionStore(env.home);
  const startedAt = env.now();
  const result = await def.run({
    store,
    opts,
    cwd: env.cwd,
    userHome: env.userHome,
    now: env.now,
  });
  try {
    return await finish(def, store, result.state, result, startedAt, env.now);
  } catch (e) {
    await store.remove(result.state.id);
    throw e;
  }
}

/** Runs a session-less command (`report perf`): no lock, no state machine, nothing saved. */
async function runGlobalCommand(
  def: Extract<CommandDef, { kind: "global" }>,
  env: Required<CliEnv>,
  opts: Record<string, string | boolean | undefined>,
): Promise<RunOutput> {
  const result = await def.run({ home: env.home, opts });
  return {
    doc: { ok: true, schemaVersion: CONTRACT_VERSION, ...result.data },
    status: "",
    exitCode: result.exitCode ?? 0,
  };
}

/** Registers every command on a commander program; `onParsed` receives the chosen command. */
function buildProgram(
  onParsed: (def: CommandDef, opts: Record<string, string | boolean | undefined>) => void,
  write: (s: string) => void,
): Command {
  const program = new Command("dynamic-skills")
    .description("Agent-driven just-in-time skill generation (JSON on stdout, status on stderr).")
    .exitOverride()
    // Help and usage text are not JSON: keep them off stdout so stdout stays machine-readable.
    // Parse errors are reported by `runCliRaw` as `Error USAGE: <message>`, not as commander text.
    .configureOutput({ writeOut: write, writeErr: write, outputError: () => undefined });
  const groups = new Map<string, Command>();
  for (const def of COMMANDS) {
    const words = def.name.split(" ");
    let parent = program;
    if (words.length === 2) {
      const group = words[0] as string;
      let g = groups.get(group);
      if (!g) {
        g = program.command(group).description(`${group} commands`);
        groups.set(group, g);
      }
      parent = g;
    }
    const cmd = parent.command(words.at(-1) as string).description(def.description);
    if (def.kind === "session") {
      cmd.addOption(new Option("--session <id>", "Session id.").makeOptionMandatory());
    }
    for (const spec of def.options) {
      const option = new Option(spec.flags, spec.description);
      if (spec.required) option.makeOptionMandatory();
      if (spec.choices) option.choices(spec.choices);
      if (spec.default !== undefined) option.default(spec.default);
      cmd.addOption(option);
    }
    cmd.action((opts: Record<string, string | boolean | undefined>) => onParsed(def, opts));
  }
  return program;
}

/** The `a | b` list of subcommands when `argv` names a command group, else `null`. */
function missingSubcommand(argv: string[]): string | null {
  const group = argv[0];
  const subs = COMMANDS.map((c) => c.name.split(" ")).filter(
    (w) => w.length === 2 && w[0] === group,
  );
  return subs.length > 0 ? subs.map((w) => w[1]).join(" | ") : null;
}

/**
 * In-process CLI entry (PRD §10.5, §13). Parses `argv`, runs the command through the shared
 * wrapper and returns the exit code with stdout (one JSON object, except plain-text `status`) and
 * stderr (the human status block, help text, or `Error USAGE: <message>` for a parse error).
 * Never throws and never writes to the real streams, so tests drive it directly.
 *
 * Wrapper order: load the session under its lock, enforce the deadline, check the state machine,
 * run, record stage and step, save, print. A failed command saves nothing; only the terminal
 * paths (`TIMEOUT`, exhausted evaluation attempts, a refused activation) save a failed session.
 * Everything written to stderr has C0 and C1 control characters removed (except newline), because
 * ids and option values are agent-controlled and could otherwise drive the terminal.
 *
 * @param argv - Arguments after the program name.
 * @param env - Injectable `home`, `cwd`, `userHome` and `now`; each defaults to the real value.
 */
export async function runCli(argv: string[], env: CliEnv = {}): Promise<CliOutcome> {
  const out = await runCliRaw(argv, env);
  return { ...out, stderr: stripControlChars(out.stderr) };
}

async function runCliRaw(argv: string[], env: CliEnv): Promise<CliOutcome> {
  const resolved: Required<CliEnv> = {
    home: env.home ?? resolveHome(),
    cwd: env.cwd ?? process.cwd(),
    userHome: env.userHome ?? homedir(),
    now: env.now ?? Date.now,
  };
  let usageText = "";
  let chosen: { def: CommandDef; opts: Record<string, string | boolean | undefined> } | null = null;
  const program = buildProgram(
    (def, opts) => (chosen = { def, opts }),
    (s) => (usageText += s),
  );
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.exitCode === 0) {
        // Help text is for humans on stderr; stdout stays one machine-readable object.
        return {
          exitCode: 0,
          stdout: jsonLine({ ok: true, schemaVersion: CONTRACT_VERSION, help: true }),
          stderr: usageText,
        };
      }
      // `commander.help` is commander showing help because a command or group was given no
      // subcommand; its own message is just "(outputHelp)".
      const message =
        e.code === "commander.help"
          ? missingSubcommand(argv) !== null
            ? `missing subcommand: ${missingSubcommand(argv)}`
            : "A command is required."
          : e.message.replace(/^error: /, "");
      const err = describeError(new CliError("USAGE", message));
      return {
        exitCode: err.exitCode,
        stdout: jsonLine(err.doc),
        stderr: `Error USAGE: ${String(err.doc.message)}\n`,
      };
    }
    const err = describeError(e);
    return { exitCode: err.exitCode, stdout: jsonLine(err.doc), stderr: "" };
  }
  if (chosen === null) {
    const err = describeError(new CliError("USAGE", "A command is required."));
    return {
      exitCode: err.exitCode,
      stdout: jsonLine(err.doc),
      stderr: `Error USAGE: ${String(err.doc.message)}\n`,
    };
  }
  const { def, opts } = chosen as {
    def: CommandDef;
    opts: Record<string, string | boolean | undefined>;
  };
  try {
    const out =
      def.kind === "create"
        ? await runCreateCommand(def, resolved, opts)
        : def.kind === "global"
          ? await runGlobalCommand(def, resolved, opts)
          : await runSessionCommand(def, resolved, opts);
    const stdout = out.text !== undefined ? `${out.text}\n` : jsonLine(out.doc);
    const stderr =
      out.text !== undefined || out.status === ""
        ? ""
        : `${out.failure ? `${out.failure}\n` : ""}${out.status}\n`;
    return { exitCode: out.exitCode, stdout, stderr };
  } catch (e) {
    const err = describeError(e);
    return {
      exitCode: err.exitCode,
      stdout: jsonLine(err.doc),
      stderr: `Error ${String(err.doc.error)}: ${String(err.doc.message)}\n`,
    };
  }
}
