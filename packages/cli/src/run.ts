import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONTRACT_VERSION,
  SessionNotFoundError,
  SessionStore,
  enforceDeadline,
  recordStage,
  renderStatus,
  resolveHome,
} from "@dynamic-skills/core";
import type { SessionState } from "@dynamic-skills/core";
import { Command, CommanderError, Option } from "commander";
import { COMMANDS } from "./commands/index";
import type { CommandDef, CommandResult } from "./commands/types";
import { CliError, writeTerminalReports } from "./io";
import type { CliEnv } from "./io";
import { assertCanRun, isTerminal } from "./state-machine";

/** What {@link runCli} returns: the process exit code and the two output streams as text. */
export interface CliOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Shown to the agent whenever the pipeline ends without a skill (PRD §10.7). */
const FALLBACK = "Continue the original task with existing capabilities.";

/** Exit code for a session that exceeded its active budget (PRD §10.1). */
const EXIT_TIMEOUT = 3;

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
  } else if (e instanceof Error && (e as { code?: unknown }).code === "SESSION_NOT_FOUND") {
    code = "SESSION_NOT_FOUND";
  } else if (e instanceof Error && (e as { code?: unknown }).code === "SESSION_LOCKED") {
    code = "SESSION_LOCKED";
  }
  if (code === "TIMEOUT") message = "The active processing budget was exceeded.";
  return {
    exitCode: code === "TIMEOUT" ? EXIT_TIMEOUT : 1,
    doc: { ok: false, schemaVersion: CONTRACT_VERSION, error: code, message, ...extra },
  };
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
): Promise<{ doc: Record<string, unknown>; status: string }> {
  const end = now();
  if (def.stage) recordStage(state, def.stage, Math.max(0, end - startedAt));
  if (def.step && result.recordStep !== false) state.completedSteps.push(def.step);
  if (result.writeReports) await writeTerminalReports(store, state, end);
  await store.save(state);
  return {
    doc: { ok: true, schemaVersion: CONTRACT_VERSION, ...result.data },
    status: renderStatus(state, end),
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
): Promise<{ doc: Record<string, unknown>; status: string; exitCode: number }> {
  const store = new SessionStore(env.home);
  const id = String(opts.session);
  // withLock creates the directory, so an unknown id must be rejected before taking the lock.
  const exists = await stat(store.dir(id)).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!exists) throw new SessionNotFoundError(id);

  return store.withLock(id, async () => {
    const state = await store.load(id);
    const startedAt = env.now();

    // A finished session keeps its outcome: the clock keeps running after completion, so the
    // deadline only applies to sessions that are still in progress (PRD §10.1).
    if (!def.bypassDeadline && !isTerminal(state)) {
      const already = state.status === "timeout";
      if (already || enforceDeadline(state, startedAt)) {
        if (!already) await failOnTimeout(store, state, startedAt);
        const err = describeError(new CliError("TIMEOUT", "", { fallback: FALLBACK }));
        return { ...err, doc: err.doc, status: renderStatus(state, startedAt) };
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
    return { ...(await finish(def, store, state, result, startedAt, env.now)), exitCode: 0 };
  });
}

/** Runs the session-creating command (`assess`). */
async function runCreateCommand(
  def: Extract<CommandDef, { kind: "create" }>,
  env: Required<CliEnv>,
  opts: Record<string, string | boolean | undefined>,
): Promise<{ doc: Record<string, unknown>; status: string; exitCode: number }> {
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
    return { ...(await finish(def, store, result.state, result, startedAt, env.now)), exitCode: 0 };
  } catch (e) {
    await store.remove(result.state.id);
    throw e;
  }
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
    .configureOutput({ writeOut: write, writeErr: write });
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

/**
 * In-process CLI entry (PRD §10.5, §13). Parses `argv`, runs the command through the shared
 * wrapper and returns the exit code with stdout (always one JSON object) and stderr (the human
 * status block). Never throws and never writes to the real streams, so tests drive it directly.
 *
 * Wrapper order: load the session under its lock, enforce the deadline, check the state machine,
 * run, record stage and step, save, print. A failed command saves nothing; only the terminal
 * `TIMEOUT` path saves a failed session.
 *
 * @param argv - Arguments after the program name.
 * @param env - Injectable `home`, `cwd`, `userHome` and `now`; each defaults to the real value.
 */
export async function runCli(argv: string[], env: CliEnv = {}): Promise<CliOutcome> {
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
      if (e.exitCode === 0) return { exitCode: 0, stdout: "", stderr: usageText };
      const message = e.message.replace(/^error: /, "");
      const err = describeError(new CliError("USAGE", message));
      return { exitCode: err.exitCode, stdout: jsonLine(err.doc), stderr: usageText };
    }
    const err = describeError(e);
    return { exitCode: err.exitCode, stdout: jsonLine(err.doc), stderr: "" };
  }
  if (chosen === null) {
    const err = describeError(new CliError("USAGE", "A command is required."));
    return { exitCode: err.exitCode, stdout: jsonLine(err.doc), stderr: usageText };
  }
  const { def, opts } = chosen as {
    def: CommandDef;
    opts: Record<string, string | boolean | undefined>;
  };
  try {
    const out =
      def.kind === "create"
        ? await runCreateCommand(def, resolved, opts)
        : await runSessionCommand(def, resolved, opts);
    return { exitCode: out.exitCode, stdout: jsonLine(out.doc), stderr: `${out.status}\n` };
  } catch (e) {
    const err = describeError(e);
    return {
      exitCode: err.exitCode,
      stdout: jsonLine(err.doc),
      stderr: `Error ${String(err.doc.error)}: ${String(err.doc.message)}\n`,
    };
  }
}
