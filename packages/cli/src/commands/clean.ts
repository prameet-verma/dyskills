import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { HostEnv } from "@dynamic-skills/adapter-sdk";
import { removePlacedBundle } from "@dynamic-skills/adapter-sdk";
import {
  SlaClock,
  archivePerformanceReport,
  hasEnded,
  readNativeReferences,
  stopClock,
} from "@dynamic-skills/core";
import type { SessionState, SessionStore } from "@dynamic-skills/core";
import { ADAPTERS } from "../adapters";
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
 * Decides whether the native placement of `state` may be removed, and why not (Ruling R38).
 * The native root must be a real directory under the real home (never a symlink, which could
 * lead to a user's own skills); the target must sit exactly at the adapter's
 * placement path; no other session may reference it (or anything
 * inside it); and no other `session.json` may be unreadable (fail safe, D5).
 */
async function nativeRemovalBlocker(
  store: SessionStore,
  state: SessionState & { native: NonNullable<SessionState["native"]> },
  within: string,
): Promise<string | null> {
  const info = await lstat(within).catch(() => null);
  if (info === null) return null; // nothing there; removal is a no-op
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(within)) !== within) {
    return "the native placement root is not a plain directory; the placement was not removed";
  }
  const { dir, harness } = state.native;
  // The adapter owns its placement layout: the recorded path must be exactly what it plans.
  const root = ADAPTERS[harness].nativeSessionRoot({
    sessionHome: dirname(within),
    vars: { DYNAMIC_SKILLS_NATIVE: "1" },
  } as unknown as HostEnv);
  if (root === null || dir !== join(root, basename(dir))) {
    return "the recorded native placement is not at its expected location; it was not removed";
  }
  const refs = await readNativeReferences(store.home, { exclude: state.id });
  if (refs.unparsable > 0) {
    return "another session could not be read; the native placement was kept";
  }
  const target = resolve(dir);
  for (const other of refs.byDir.keys()) {
    const o = resolve(other);
    if (o === target || o.startsWith(`${target}${sep}`)) {
      return "another session still uses the native placement; it was kept";
    }
  }
  return null;
}

/**
 * Discards a session: archives its performance report (Ruling R21), removes its native placement
 * when nothing else uses it, then removes the session directory. A failed archive write throws
 * before anything is removed.
 *
 * The placement path comes from session state, so it is removed only when `<realpath home>/native`
 * is a plain directory, the path is exactly the adapter's planned placement, and
 * `removePlacedBundle` (bound to that root, Ruling R29) accepts it; otherwise it is kept and a
 * note says why. It is also kept while another session references it or any other `session.json`
 * cannot be read (D5).
 * @param store - Session store.
 * @param state - The session to discard.
 * @returns `archived`: the archive path, or `null` when the session had no valid report; `notes`:
 * why a native placement was kept, when it was.
 */
export async function discardSession(
  store: SessionStore,
  state: SessionState,
): Promise<{ archived: string | null; notes: string[] }> {
  const archived = (await archivePerformanceReport(store.home, state.id))
    ? join(store.home, "reports", `${state.id}.json`)
    : null;
  const notes: string[] = [];
  if (state.native !== undefined) {
    const within = join(await realpath(store.home).catch(() => store.home), "native");
    const why = await nativeRemovalBlocker(store, { ...state, native: state.native }, within);
    if (why !== null) notes.push(why);
    else await removePlacedBundle(state.native.dir, state.native.manifestSha256, within);
  }
  await store.remove(state.id);
  return { archived, notes };
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
    const { archived, notes } = await discardSession(store, state);
    return {
      data: { removed: true, archived: archived !== null, notes },
      save: false,
      recordStep: false,
    };
  },
};
