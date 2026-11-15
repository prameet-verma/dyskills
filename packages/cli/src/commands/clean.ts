import { archivePerformanceReport } from "@dynamic-skills/core";
import type { SessionCommandDef } from "./types";

/**
 * `clean`: archives the session's `reports/performance.json` (when the session has ended with a
 * valid report) to `<home>/reports/<sessionId>.json`, then removes the session directory
 * (PRD §11.1, Ruling R21: cleaning never erases the PRD §17 metrics). It always works, even on a
 * timed-out session (Ruling R3), and saves nothing afterwards. A failed archive write throws and
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
  async run({ store, state }) {
    const archived = await archivePerformanceReport(store.home, state.id);
    await store.remove(state.id);
    return { data: { removed: true, archived }, save: false, recordStep: false };
  },
};
