import { archivePerformanceReport, hasEnded, stopClock } from "@dynamic-skills/core";
import { writeTerminalReports } from "../io";
import type { SessionCommandDef } from "./types";

/**
 * `clean`: archives the session's `reports/performance.json` (when the session has ended with a
 * valid report) to `<home>/reports/<sessionId>.json`, then removes the session directory
 * (PRD §11.1, Ruling R21: cleaning never erases the PRD §17 metrics). A session that has not
 * ended is first ended as `failed` with terminal reports (Ruling R22), so it is archived too. It
 * always works, even on a timed-out session (Ruling R3), and saves nothing afterwards. A failed archive write throws and
 * removes nothing, so the metrics are never lost silently.
 */
export const cleanCommand: SessionCommandDef = {
  name: "clean",
  kind: "session",
  description: "Remove the session directory.",
  options: [],
  step: null,
  stage: null,
  bypassDeadline: true,
  async run({ store, state, now }) {
    // Catch-all (Ruling R22): a session abandoned before it ended is counted as `failed`, so
    // `report perf` does not under-count the fallback rate. An ended session keeps its outcome.
    if (!hasEnded(state)) {
      const at = now();
      state.status = "failed";
      state.metrics.outcome = "failed";
      stopClock(state, at);
      await writeTerminalReports(store, state, at);
    }
    const archived = await archivePerformanceReport(store.home, state.id);
    await store.remove(state.id);
    return { data: { removed: true, archived }, save: false, recordStep: false };
  },
};
