import type { SessionState } from "@dynamic-skills/core";
import { CliError } from "./io";

/** Every CLI command the state machine knows. Task 16 commands are registered here up front. */
export type CliCommand =
  | "assess"
  | "discover"
  | "context request"
  | "context submit"
  | "sufficiency submit"
  | "sufficiency approve"
  | "clarify ask"
  | "clarify answer"
  | "compile"
  | "evaluate"
  | "eval record"
  | "activate"
  | "status"
  | "clean"
  | "report perf";

/** Names appended to `SessionState.completedSteps` by a successful command (amends Ruling R2). */
export type CompletedStep =
  | "assess"
  | "discover"
  | "context-request"
  | "context-submit"
  | "sufficiency-submit"
  | "sufficiency-approve"
  | "clarify-ask"
  | "clarify-answer"
  | "compile"
  | "evaluate"
  | "eval-record"
  | "activate";

/** Session statuses that end the session: no pipeline command may run afterwards. */
const TERMINAL: ReadonlySet<string> = new Set(["completed", "warning", "failed"]);

/** True when the session has already ended (`completed`, `warning` or `failed`). */
export function isTerminal(state: SessionState): boolean {
  return TERMINAL.has(state.status);
}

/**
 * Allowed predecessor (the last `completedSteps` entry) per command, in the order reported as
 * `expected` on an `INVALID_STATE` error. `assess` creates the session and has no predecessor;
 * `status` and `clean` are always allowed (PRD §10.5).
 */
const PREDECESSORS: Partial<Record<CliCommand, CompletedStep[]>> = {
  discover: ["assess"],
  "context request": ["discover", "context-request", "context-submit"],
  "context submit": ["discover", "context-request", "context-submit", "clarify-answer"],
  "sufficiency submit": ["context-submit"],
  "sufficiency approve": ["sufficiency-submit"],
  "clarify ask": ["context-submit", "sufficiency-submit", "sufficiency-approve", "clarify-answer"],
  "clarify answer": ["clarify-ask"],
  compile: [
    "context-submit",
    "sufficiency-submit",
    "sufficiency-approve",
    "clarify-answer",
    "evaluate",
  ],
  // PRD §9.4: a failed behavioural result is revised and re-evaluated (bounded by MAX_EVAL_ATTEMPTS).
  evaluate: ["compile", "evaluate", "eval-record"],
  "eval record": ["evaluate"],
  activate: ["eval-record"],
};

/** Commands that need a recorded, not-pending sufficiency verdict (PRD §5.5). */
const NEEDS_VERDICT: ReadonlySet<CliCommand> = new Set(["clarify ask", "compile"]);

/** Builds the `INVALID_STATE` error. */
function invalid(message: string, expected: string[]): CliError {
  return new CliError("INVALID_STATE", message, { expected });
}

/**
 * Checks that `command` may run in the session's current state (PRD §5.5, §10.4 #3).
 *
 * Order: terminal session (`expected: []`), then the predecessor rule, then the verdict guard for
 * `clarify ask` and `compile`, then the one-verdict and pending-approval rules. `status` and
 * `clean` are always allowed.
 *
 * @param state - The loaded session.
 * @param command - The command about to run.
 * @throws {CliError} `INVALID_STATE` with the `expected` predecessor steps (or the step that
 * unblocks the command).
 */
export function assertCanRun(state: SessionState, command: CliCommand): void {
  if (command === "status" || command === "clean") return;
  if (isTerminal(state)) {
    throw invalid(`The session has ended (status ${state.status}); "${command}" cannot run.`, []);
  }
  const allowed = PREDECESSORS[command];
  if (!allowed) throw invalid(`"${command}" cannot run on an existing session.`, []);
  const last = state.completedSteps.at(-1);
  if (last === undefined || !(allowed as string[]).includes(last)) {
    throw invalid(
      `"${command}" cannot run after "${last ?? "nothing"}"; expected one of: ${allowed.join(", ")}.`,
      allowed,
    );
  }
  if (NEEDS_VERDICT.has(command)) {
    if (state.sufficiency === null) {
      throw invalid(`"${command}" needs a sufficiency verdict first.`, ["sufficiency-submit"]);
    }
    if (state.sufficiency.approval === "pending") {
      throw invalid(`"${command}" needs the pending approval first.`, ["sufficiency-approve"]);
    }
  }
  // PRD §5.5: one verdict per session.
  if (command === "sufficiency submit" && state.sufficiency !== null) {
    throw invalid("A sufficiency verdict was already recorded for this session.", []);
  }
  if (command === "sufficiency approve" && state.sufficiency?.approval !== "pending") {
    throw invalid("No approval is pending for this session.", []);
  }
}
