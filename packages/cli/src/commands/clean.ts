import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { removePlacedBundle } from "@dynamic-skills/adapter-sdk";
import {
  SlaClock,
  archivePerformanceReport,
  hasEnded,
  readNativeReferences,
  stopClock,
} from "@dynamic-skills/core";
import type { SessionState, SessionStore } from "@dynamic-skills/core";
import { writeTerminalReports } from "../io";
import type { SessionCommandDef } from "./types";

/**
 * Ends a session that is still open so abandoning it is counted (Ruling R22): `timeout` when its
 * budget has run out, otherwise `failed`. Idle time after the budget ran out is not active time.
 * A session that already ended is left alone.
 * @param store - Session store.
 * @param state - The loaded session (mutated, not saved: the session is about to be removed).
 * @param at - Current time (epoch ms).
 */
export async function endAbandonedSession(
  store: SessionStore,
  state: SessionState,
  at: number,
): Promise<void> {
  if (hasEnded(state)) return;
  const clock = SlaClock.from(state.sla);
  const outcome = clock.isExpired(at) ? "timeout" : "failed";
  state.status = outcome;
  state.metrics.outcome = outcome;
  stopClock(state, at - Math.max(0, clock.activeMs(at) - clock.snapshot(at).budgetMs));
  await writeTerminalReports(store, state, at);
}

/**
 * Discards a session: archives its performance report (Ruling R21), removes its native placement
 * when nothing else uses it, then removes the session directory. A failed archive write throws
 * before anything is removed.
 *
 * The placement is kept when another session references the same directory, or when any other
 * `session.json` cannot be read (it may reference it; fail safe, D5). Its path comes from session
 * state, so it is removed only through `removePlacedBundle` bound to `<realpath home>/native`
 * (Ruling R29): a tampered path outside that root, or one using `..` or a symlink, removes nothing.
 * @param store - Session store.
 * @param state - The session to discard.
 * @returns `archived`: the archive path, or `null` when the session had no valid report.
 */
export async function discardSession(
  store: SessionStore,
  state: SessionState,
): Promise<{ archived: string | null }> {
  const archived = (await archivePerformanceReport(store.home, state.id))
    ? join(store.home, "reports", `${state.id}.json`)
    : null;
  if (state.native !== undefined) {
    const refs = await readNativeReferences(store.home, { exclude: state.id });
    if (refs.unparsable === 0 && !refs.byDir.has(state.native.dir)) {
      const within = join(await realpath(store.home).catch(() => store.home), "native");
      await removePlacedBundle(state.native.dir, state.native.manifestSha256, within);
    }
  }
  await store.remove(state.id);
  return { archived };
}

/**
 * `clean`: archives the session's `reports/performance.json` (when the session has ended with a
 * valid report) to `<home>/reports/<sessionId>.json`, then removes the session directory
 * (PRD §11.1, Ruling R21: cleaning never erases the PRD §17 metrics). A session that has not
 * ended is first ended with terminal reports (Ruling R22): `timeout` if its budget has run out,
 * otherwise `failed`; idle time after the budget ran out is not counted as active time. It
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
    // Catch-all (Ruling R22): a session abandoned before it ended is counted.
    await endAbandonedSession(store, state, now());
    const { archived } = await discardSession(store, state);
    return { data: { removed: true, archived: archived !== null }, save: false, recordStep: false };
  },
};
