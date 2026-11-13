import { MAX_CLARIFICATION_ROUNDS } from "./constants";
import type { PipelineStatus, SessionState } from "./schemas";
import { SlaClock } from "./sla";

/** Human labels for statuses rendered with the generic running block. */
const LABELS: Partial<Record<PipelineStatus, string>> = {
  assessing: "Assessing skill coverage",
  discovering: "Discovering",
  generating: "Generating",
  evaluating: "Evaluating",
  activating: "Activating",
  completed: "Completed",
  warning: "Completed with warnings",
  timeout: "Timeout",
  failed: "Failed — returning control to the root agent",
};

/**
 * Renders the user-visible status block (PRD §9.5). The waiting and resuming blocks match the PRD
 * text exactly; every other status uses the generic block. Seconds are floored and the budget is
 * printed from the session's own SLA so a non-default budget is reported truthfully.
 */
export function renderStatus(s: SessionState, now: number): string {
  const clock = SlaClock.from(s.sla);
  const used = Math.floor(clock.activeMs(now) / 1000);
  const budget = Math.floor(s.sla.budgetMs / 1000);

  if (s.status === "waiting-for-clarification") {
    return [
      "Dynamic Skills",
      "",
      "Status: Waiting for clarification",
      "",
      `Round: ${s.clarification.round} of ${MAX_CLARIFICATION_ROUNDS}`,
      `Questions pending: ${s.clarification.pending.length}`,
      "",
      "Processing SLA: PAUSED",
      `Active processing used: ${used}s / ${budget}s`,
      "",
      "The root agent is waiting for your response.",
    ].join("\n");
  }

  if (s.status === "resuming") {
    return [
      "Dynamic Skills",
      "",
      "Status: Resuming generation",
      "",
      "Clarification: Received",
      "Processing SLA: RESUMED",
      "",
      `Active processing remaining: ${Math.floor(clock.remainingMs(now) / 1000)}s`,
    ].join("\n");
  }

  const sla = s.status === "timeout" ? "EXCEEDED" : "RUNNING";
  return [
    "Dynamic Skills",
    "",
    `Status: ${LABELS[s.status] ?? s.status}`,
    "",
    `Processing SLA: ${sla}`,
    `Active processing used: ${used}s / ${budget}s`,
  ].join("\n");
}
