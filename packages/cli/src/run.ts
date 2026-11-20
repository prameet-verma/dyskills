import { lstat, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  CONTRACT_VERSION,
  SessionNotFoundError,
  SessionStore,
  enforceDeadline,
  hasEnded,
  SlaClock,
  recordStage,
  renderStatus,
  stopClock,
} from "@dynamic-skills/core";
import type { SessionState } from "@dynamic-skills/core";
import { createHostProbe } from "@dynamic-skills/adapter-sdk";
import { Command, CommanderError, Option } from "commander";
import { removeUnreadableSession } from "./commands/clean";
import { COMMANDS } from "./commands/index";
import type { CommandDef, CommandResult } from "./commands/types";
import { CliError, FALLBACK, stripControlChars, writeTerminalReports } from "./io";
import type { CliEnv } from "./io";
import { resolveEtcDir } from "./host";
import { CLI_VERSION } from "./version";
import { assertCanRun, inProgressStage, isTerminal } from "./state-machine";

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

/** The message of every `INTERNAL` error that is not one of our own `CliError`s. */
const INTERNAL_MESSAGE = "unexpected internal error; see `status`";

/** Appended to {@link INTERNAL_MESSAGE}: only an errno-style code, never any text of the error. */
function errnoSuffix(e: unknown): string {
  const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^E[A-Z0-9]{2,15}$/.test(code) ? ` (${code})` : "";
}

/**
 * The session home: `DYNAMIC_SKILLS_HOME` when it is set, non-empty and absolute, otherwise the
 * default under the OS temp directory. A relative value counts as unset like an empty one
 * (Ruling R42): it would resolve against the working directory and put `sessions/` and the native
 * sweep inside whatever repo the agent runs in.
 */
function homeFromVars(vars: NodeJS.ProcessEnv): string {
  const value = vars.DYNAMIC_SKILLS_HOME;
  if (value !== undefined && value !== "" && isAbsolute(value)) return value;
  // Core's `resolveHome` reads `process.env`, which may hold a relative value of its own.
  return join(tmpdir(), `dynamic-skills-${process.getuid?.() ?? "user"}`);
}

/** Line-terminated JSON for stdout. */
function jsonLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

/** Converts any thrown value into the error document and exit code (PRD §10.5, §13). */
function describeError(e: unknown): { exitCode: number; doc: Record<string, unknown> } {
  let code: string = "INTERNAL";
  // Ruling R45: only our own CliErrors and the store's known errors may show their text; anything
  // else (a ZodError, an fs error) can carry repo or session content, so it gets a fixed message.
  let message = `${INTERNAL_MESSAGE}${errnoSuffix(e)}`;
  let extra: Record<string, unknown> = {};
  if (e instanceof CliError) {
    code = e.code;
    message = e.message;
    extra = e.extra;
  } else if (e instanceof Error && CORE_CODES.has(String((e as { code?: unknown }).code))) {
    code = String((e as { code?: unknown }).code);
    message = e.message;
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
  const recorded = def.step !== undefined && result.recordStep !== false;
  if (recorded) state.completedSteps.push(def.step!);
  // Start of the agent gap before the next command (see `attributeInProgressStage`): moved by
  // every saved command that booked its own run time or recorded a step, never by `status`.
  if (recorded || (def.stage && result.save !== false)) {
    state.metrics.lastCommandEndedAtActiveMs = SlaClock.from(state.sla).activeMs(end);
  }
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
  // Reports and the save come first (Ruling R45): if either fails the command fails with the
  // skill still in place and `session.json` untouched, never half applied.
  await writeTerminalReports(store, state, now);
  await store.save(state);
  await removeSkills(store, state);
}

/** Removes the session's unvalidated `skills/`; best effort when the session already timed out. */
async function removeSkills(store: SessionStore, state: SessionState): Promise<void> {
  await rm(join(store.dir(state.id), "skills"), { recursive: true, force: true });
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
    let state: SessionState;
    try {
      state = await store.load(id);
    } catch (e) {
      if (e instanceof SessionNotFoundError) throw e;
      // Ruling R45: `clean` and `save --scope discard` always work, even when `session.json` is
      // corrupt: the directory goes, nothing is archived (a dry run only reports).
      const discarding = def.name === "clean" || (def.name === "save" && opts.scope === "discard");
      if (!discarding) {
        throw new CliError(
          "INTERNAL",
          `The session could not be read; run \`clean --session ${id}\` to remove it.`,
        );
      }
      const dry = def.name === "save" && opts.dryRun === true;
      const notes = dry
        ? [
            "Dry run: session.json could not be read; the session would be removed, nothing was changed.",
          ]
        : await removeUnreadableSession(store, id);
      return {
        doc: {
          ok: true,
          schemaVersion: CONTRACT_VERSION,
          ...(def.name === "save" ? { scope: "discard", dryRun: dry } : {}),
          removed: !dry,
          archived: false,
          notes,
        },
        status: "",
        exitCode: 0,
      };
    }
    const startedAt = env.now();

    // A finished session keeps its outcome: its clock is stopped when it ends, and the deadline
    // only applies to sessions that are still in progress (PRD §10.1).
    if (!def.bypassDeadline && !isTerminal(state)) {
      const already = state.status === "timeout";
      if (already || enforceDeadline(state, startedAt, inProgressStage(state, def.name))) {
        if (!already) await failOnTimeout(store, state, startedAt);
        // A timeout saved by an earlier run whose removal failed: try again, never fail on it.
        else await removeSkills(store, state).catch(() => undefined);
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
      vars: env.vars,
      probe: env.probe,
      etcDir: env.etcDir,
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
    vars: env.vars,
    probe: env.probe,
    etcDir: env.etcDir,
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
  const result = await def.run({
    home: env.home,
    opts,
    cwd: env.cwd,
    userHome: env.userHome,
    vars: env.vars,
    probe: env.probe,
    etcDir: env.etcDir,
  });
  return {
    doc: { ok: true, schemaVersion: CONTRACT_VERSION, ...result.data },
    status: result.summary ?? "",
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
  // `--version` itself is answered before parsing (one JSON object); declared so help lists it.
  program.addOption(new Option("-V, --version", "Print the version as JSON."));
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

/** Options whose value is free text, so a leading `-` is legitimate. */
const FREE_TEXT_OPTIONS: ReadonlySet<string> = new Set(["--task", "--notes"]);

/**
 * The flag of the first value-taking option that swallowed one of its own command's flags (for
 * example `init --repo --dry-run`, or `save --session --scope=project`), else `null`. Commander
 * lets an option take a following flag as its value, which silently turns a typo into a different
 * command. A value given as one `--opt=value` token is never refused. Free-text options refuse
 * only a value that is, whole, one of the command's own flags.
 */
function optionValueStartingWithDash(
  def: CommandDef,
  opts: Record<string, string | boolean | undefined>,
  argv: string[],
): string | null {
  const specs = def.options.map((o) => new Option(o.flags));
  if (def.kind === "session") specs.push(new Option("--session <id>"));
  const own = new Set<string>(["--help", "-h"]);
  for (const o of specs) {
    if (o.long !== undefined) own.add(o.long);
    if (o.short !== undefined) own.add(o.short);
  }
  for (const o of specs) {
    if (!o.required || o.long === undefined) continue;
    const value = opts[o.attributeName()];
    if (typeof value !== "string" || !value.startsWith("-")) continue;
    if (argv.includes(`${o.long}=${value}`)) continue;
    if (FREE_TEXT_OPTIONS.has(o.long)) {
      // Free text may start with `-`, but a value that is exactly one of the command's own flags
      // and its own argv token means the flag was swallowed (`assess --task --explicit`).
      if (own.has(value) && argv.includes(value)) return o.long;
      continue;
    }
    const name = value.split("=")[0] as string;
    if (own.has(name)) return o.long;
  }
  return null;
}

/** The `a | b` list of subcommands when `argv` names a command group, else `null`. */
function missingSubcommand(argv: string[]): string | null {
  const group = argv[0];
  const subs = COMMANDS.map((c) => c.name.split(" ")).filter(
    (w) => w.length === 2 && w[0] === group,
  );
  return subs.length > 0 ? subs.map((w) => w[1]).join(" | ") : null;
}

/** True for exactly one `-V`, `--version`, `-h` or `--help` argument. */
function isLoneProgramFlag(argv: string[]): boolean {
  return argv.length === 1 && ["-V", "--version", "-h", "--help"].includes(argv[0] as string);
}

/** True when `word` names a registered top-level command, a command group, or `help`. */
function isSubcommandWord(word: string): boolean {
  return word === "help" || COMMANDS.some((c) => c.name.split(" ")[0] === word);
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
 * @param env - Injectable `home`, `cwd`, `userHome`, `now`, `vars`, `probe` and `etcDir`; each
 * defaults to the real value (`vars` to `process.env`, `probe` to `createHostProbe(vars)`, `etcDir`
 * to `DYNAMIC_SKILLS_ETC_DIR` or `/etc`).
 */
export async function runCli(argv: string[], env: CliEnv = {}): Promise<CliOutcome> {
  const out = await runCliRaw(argv, env);
  return { ...out, stderr: stripControlChars(out.stderr) };
}

async function runCliRaw(argv: string[], env: CliEnv): Promise<CliOutcome> {
  const vars = env.vars ?? process.env;
  const resolved: Required<CliEnv> = {
    // A caller-supplied `vars` is honoured first; a relative or empty home counts as unset (R42).
    home: env.home ?? homeFromVars(vars),
    cwd: env.cwd ?? process.cwd(),
    userHome: env.userHome ?? homedir(),
    now: env.now ?? Date.now,
    vars,
    probe: env.probe ?? createHostProbe(vars),
    etcDir: resolveEtcDir(env.etcDir, vars),
  };
  // `--version` prints one JSON object like every other command, not commander's bare text.
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    return {
      exitCode: 0,
      stdout: jsonLine({ ok: true, schemaVersion: CONTRACT_VERSION, version: CLI_VERSION }),
      stderr: "",
    };
  }
  // Ruling R31: nothing may precede the subcommand (except a lone version or help flag), or a
  // harness allow rule for `dynamic-skills *` would match `dynamic-skills -V save ...` while the
  // consent rules for `save` and `init` would not.
  const first = argv[0];
  if (first !== undefined && !isLoneProgramFlag(argv) && !isSubcommandWord(first)) {
    const err = describeError(
      new CliError(
        "USAGE",
        `The command must come first; "${first}" is not a command (program options are only accepted alone).`,
      ),
    );
    return {
      exitCode: err.exitCode,
      stdout: jsonLine(err.doc),
      stderr: `Error USAGE: ${String(err.doc.message)}\n`,
    };
  }
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
  const dashed = optionValueStartingWithDash(def, opts, argv);
  if (dashed !== null) {
    const err = describeError(
      new CliError(
        "USAGE",
        `${dashed} needs a value, but the next argument is one of this command's options.`,
      ),
    );
    return {
      exitCode: err.exitCode,
      stdout: jsonLine(err.doc),
      stderr: `Error USAGE: ${String(err.doc.message)}\n`,
    };
  }
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
