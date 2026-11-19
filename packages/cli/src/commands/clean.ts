import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
import { inPlacementGrace } from "../native";
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

const GRACE_NOTE =
  "the native placement was placed or refreshed within the last 10 minutes; it was kept";

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
  let root: string | null;
  try {
    root = ADAPTERS[harness].nativeSessionRoot({
      sessionHome: dirname(within),
      vars: { DYNAMIC_SKILLS_NATIVE: "1" },
    } as unknown as HostEnv);
  } catch {
    // `clean` is always safe (Ruling R3): an adapter needing more of the environment keeps the placement.
    return "the native placement layout could not be determined; it was not removed";
  }
  if (root === null || dir !== join(root, basename(dir))) {
    return "the recorded native placement is not at its expected location; it was not removed";
  }
  // Every directory between the native root and the placement must be a plain directory, so a
  // symlink inside native cannot redirect the removal (the SDK only checks the final parent).
  let walk = within;
  for (const part of relative(within, dirname(dir)).split(sep)) {
    walk = join(walk, part);
    const st = await lstat(walk).catch(() => null);
    if (st === null) return null; // missing: nothing to remove
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return "a directory on the native placement path is a symlink; it was not removed";
    }
  }
  // Ruling R45: another session may have just placed or reused this directory and not saved its
  // reference yet; a placement inside the R39 grace window (real clock) is kept.
  const placed = await lstat(dir).catch(() => null);
  if (placed !== null && inPlacementGrace(placed.mtimeMs)) {
    return GRACE_NOTE;
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
    else {
      // Ruling R45: look again right before removing; another session may have reused the
      // placement since the check above (a microsecond window remains, see cli-reference).
      const again = await lstat(state.native.dir).catch(() => null);
      if (again !== null && inPlacementGrace(again.mtimeMs)) notes.push(GRACE_NOTE);
      else await removePlacedBundle(state.native.dir, state.native.manifestSha256, within);
    }
  }
  await store.remove(state.id);
  return { archived, notes };
}

/**
 * Removes a session whose `session.json` cannot be loaded (corrupt or unreadable), Ruling R45:
 * `clean` must always work. Nothing is archived (there is no state to build a report from) and no
 * native placement is removed (the state that names it is gone), so the session's directory goes
 * and a note says so; the TTL sweep takes a placement that nothing references anymore.
 * @param store - Session store.
 * @param id - Session id.
 * @returns The notes for the command's output.
 */
export async function removeUnreadableSession(store: SessionStore, id: string): Promise<string[]> {
  await store.remove(id);
  return [
    "session.json could not be read; the session directory was removed, nothing was archived and no native placement was touched.",
  ];
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
