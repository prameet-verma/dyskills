import type { SessionState, SessionStore, StageName } from "@dynamic-skills/core";
import type { CliErrorCode } from "../io";
import type { CliCommand, CompletedStep } from "../state-machine";

/** Everything a command handler may use. */
export interface CommandContext {
  /** Session store rooted at the invocation's `home`. */
  store: SessionStore;
  /**
   * The loaded session. Handlers mutate it in place; the wrapper saves it only when the handler
   * resolves, so a throw discards every mutation.
   */
  state: SessionState;
  /** Parsed command-line options (`--file`, `--task`, ...). */
  opts: Record<string, string | boolean | undefined>;
  /** Working directory for resolving relative `--file` and `--repo` values. */
  cwd: string;
  /** User home searched for personal skills. */
  userHome: string;
  /** Reads the injected clock (epoch ms). Call it afresh for every timestamp that matters. */
  now: () => number;
}

/** What a handler returns to the wrapper. */
export interface CommandResult {
  /** Fields merged into the stdout JSON after `ok` and `schemaVersion`. */
  data: Record<string, unknown>;
  /**
   * Set when the command ended the session (status `completed`, outcome set): the wrapper then
   * writes `reports/performance.json` and `reports/discovery.json`.
   */
  writeReports?: boolean;
  /** Set to `false` when the command changed nothing and must not append its completed step. */
  recordStep?: boolean;
  /**
   * Process exit code; defaults to 0. A non-zero code is for a gate failure that must still be
   * saved (a failed evaluation attempt, a refused activation), as opposed to a thrown `CliError`
   * which discards the handler's changes.
   */
  exitCode?: number;
  /** Set for a saved failure: `ok` becomes false and `error` and `message` lead the document. */
  error?: { code: CliErrorCode; message: string };
  /** Overrides `ok` when it must differ from "no `error` set" (a refused activation). */
  ok?: boolean;
  /** Plain text printed on stdout instead of the JSON document (only `status`). */
  text?: string;
  /**
   * Undoes artifacts the handler already wrote. The wrapper calls it when its own tail (terminal
   * reports, save) fails, so a failed command leaves nothing behind.
   */
  cleanup?: () => Promise<void>;
  /** Set to `false` when the command must not write `session.json` (`status`, `clean`). */
  save?: boolean;
}

/** Declarative description of one option, mirrored into commander. */
export interface OptionSpec {
  /** Commander flag string, e.g. `--file <path>`. */
  flags: string;
  /** Help text. */
  description: string;
  /** Whether commander enforces the option. */
  required?: boolean;
  /** Allowed values, enforced by commander. */
  choices?: string[];
  /** Default value. */
  default?: string;
}

/** Fields shared by every command definition. */
interface CommandBase {
  /** Command name, one or two words (`discover`, `context request`). */
  name: CliCommand;
  /** One-line help. */
  description: string;
  /** Options beyond the implicit `--session <id>`. */
  options: OptionSpec[];
  /** Step appended to `completedSteps` on success; `null` for commands that do not advance. */
  step: CompletedStep | null;
  /** Stage whose duration is added to the metrics; `null` when the command records none. */
  stage: StageName | null;
}

/**
 * A command on an existing session. Commands are data so the wrapper (lock, deadline, state
 * machine, stage timing, save, output) is written once and later tasks only append definitions.
 */
export interface SessionCommandDef extends CommandBase {
  kind: "session";
  /** True for `status` and `clean`, which skip the deadline check (Ruling R3). */
  bypassDeadline?: boolean;
  /** Runs the command. Throws `CliError` for expected failures; the wrapper then saves nothing. */
  run(ctx: CommandContext): Promise<CommandResult>;
}

/**
 * The command that creates a session (only `assess`). It returns the new state; the wrapper
 * completes the common tail and removes the session directory if that tail fails.
 */
export interface CreateCommandDef extends CommandBase {
  kind: "create";
  /** Runs the command and returns the freshly created session with the result. */
  run(ctx: Omit<CommandContext, "state">): Promise<CommandResult & { state: SessionState }>;
}

/** Any registered command. */
export type CommandDef = SessionCommandDef | CreateCommandDef;
