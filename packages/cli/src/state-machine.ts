import type { SessionState, StageName } from "@dynamic-skills/core";
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
  | "report perf"
  | "init"
  | "save";

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

/**
 * Stage whose agent work follows each completed step: the time before the next command is the
 * agent working, so a deadline hit there belongs to that stage (PRD §10.8).
 * `context-submit` maps to the sufficiency judgement (`assessment`) while no verdict exists; once one
 * is recorded (a re-analysis after clarification) no assessment can run, so the next work is
 * `compilation`;
 * `compile` only writes the brief, so the bundle-writing that follows is `compilation`;
 * `evaluate` and `eval-record` precede the behavioural runs and their recording (`evaluation`).
 * Steps followed by a human wait (`clarify-ask`) have no entry; a paused clock attributes nothing.
 */
const STAGE_AFTER_STEP: Partial<Record<CompletedStep, StageName>> = {
  discover: "analysis",
  "context-request": "analysis",
  "context-submit": "assessment", // becomes "compilation" once a verdict exists, see below
  "sufficiency-submit": "compilation",
  "sufficiency-approve": "compilation",
  "clarify-answer": "compilation",
  compile: "compilation",
  evaluate: "evaluation",
  "eval-record": "evaluation",
};

/**
 * Commands whose own stage is unambiguous (re-analysis, revision, formulating clarification
 * questions). `clarify ask` is `clarification`: the agent drafting more questions after a verdict
 * or an answered round is clarification work, not compilation. Used only when the command is
 * legal after the last step (see {@link inProgressStage}).
 */
const STAGE_OF_COMMAND: Partial<Record<CliCommand, StageName>> = {
  "context request": "analysis",
  "context submit": "analysis",
  "clarify ask": "clarification",
  compile: "compilation",
};

/**
 * Stage whose agent work was in progress: the command about to run when it names one
 * unambiguously and is legal after the last completed step (an illegal command is refused, so it
 * says nothing about the agent's work), otherwise the one that follows the last completed step.
 */
export function inProgressStage(state: SessionState, command?: CliCommand): StageName | undefined {
  const last = state.completedSteps.at(-1) as CompletedStep | undefined;
  const own = command === undefined ? undefined : STAGE_OF_COMMAND[command];
  if (own && last !== undefined && PREDECESSORS[command as CliCommand]?.includes(last)) return own;
  if (last === "context-submit" && state.sufficiency) return "compilation";
  return last === undefined ? undefined : STAGE_AFTER_STEP[last];
}

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
  // `save` checks its own state with `assertCanSave`: its scopes differ in what they need.
  if (command === "status" || command === "clean" || command === "save") return;
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

/**
 * Checks that `save` may run with `scope` (D6, D8). `ephemeral` and `discard` are always allowed.
 * `project` and `personal` need an ended session (`completed` or `warning`) whose last step is
 * `activate` and whose outcome is `activated`.
 *
 * @param state - The loaded session.
 * @param scope - The requested scope.
 * @throws {CliError} `INVALID_STATE` with `expected: ["activate"]` before a successful activation,
 * `SAVE_UNSUPPORTED` for an augmentation (D8).
 */
export function assertCanSave(
  state: SessionState,
  scope: "project" | "personal" | "ephemeral" | "discard",
): void {
  if (scope === "ephemeral" || scope === "discard") return;
  const ended = state.status === "completed" || state.status === "warning";
  if (!ended || state.completedSteps.at(-1) !== "activate") {
    throw invalid('"save" needs a session that finished "activate".', ["activate"]);
  }
  if (state.metrics.outcome === "augmented") {
    throw new CliError(
      "SAVE_UNSUPPORTED",
      "Saving an augmentation arrives with freshness checks in Phase 3; the base skill was not modified.",
    );
  }
  if (state.metrics.outcome !== "activated") {
    throw invalid(
      `"save" needs an activated skill; the outcome is ${state.metrics.outcome ?? "unset"}.`,
      ["activate"],
    );
  }
}
