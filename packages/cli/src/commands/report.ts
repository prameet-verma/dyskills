import { aggregatePerformance } from "@dynamic-skills/core";
import type { GlobalCommandDef } from "./types";

/**
 * `report perf`: aggregates every session's `reports/performance.json` under the session home
 * (PRD §10.8, §17). It needs no session, takes no lock and is allowed in any state, so the
 * wrapper skips the state machine for it. Read-only.
 */
export const reportPerfCommand: GlobalCommandDef = {
  name: "report perf",
  kind: "global",
  description: "Aggregate performance across all sessions.",
  options: [],
  step: null,
  stage: null,
  async run({ home }) {
    return { data: { ...(await aggregatePerformance(home)) } };
  },
};
