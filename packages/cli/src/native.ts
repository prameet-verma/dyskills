import { lstat, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  STALE_TEMP_MS,
  bundleManifest,
  placeBundle,
  removePlacedBundle,
} from "@dynamic-skills/adapter-sdk";
import type { HarnessAdapter, HostEnv, PlaceInput } from "@dynamic-skills/adapter-sdk";
import {
  NATIVE_FUTURE_SKEW_MS,
  readNativeReferences,
  SkillNameSchema,
  selectExpiredPlacements,
} from "@dynamic-skills/core";
import type { NativePlacement } from "@dynamic-skills/core";
import { ADAPTERS, HARNESS_IDS } from "./adapters";

/** Most directories the sweep looks at in one run; keeps it far below the 60 s budget. */
const SWEEP_MAX_DIRS = 2_000;

/** Real-clock budget of one sweep (2 s); it stops enumerating and removing once it is spent. */
const SWEEP_BUDGET_MS = 2_000;

/** Name of the marker file `placeNative` creates in `<home>/native` (Ruling R42). */
export const NATIVE_MARKER = ".dynamic-skills-native";

/**
 * Grace period (10 min, real clock) for a fresh placement (Ruling R39). A session's placement is
 * unreferenced between `placeNative` and its save, so a sweep in another process must not take a
 * directory whose mtime is younger than this. Ages from `-NATIVE_FUTURE_SKEW_MS` (small forward
 * clock skew) up to the grace count; a mtime further ahead gets no grace, so it cannot keep a
 * placement forever.
 */
export const NATIVE_PLACEMENT_GRACE_MS = 600_000;

/**
 * True when a directory last modified at `mtimeMs` is inside the R39 grace window at real time
 * `wallNow`. mtime has sub-millisecond digits that `Date.now()` lacks; floor so "just now" is 0.
 */
export function inPlacementGrace(mtimeMs: number, wallNow: number = Date.now()): boolean {
  const age = wallNow - Math.floor(mtimeMs);
  return age >= -NATIVE_FUTURE_SKEW_MS && age < NATIVE_PLACEMENT_GRACE_MS;
}

/** Optional limits and test seams of {@link sweepNativePlacements}; tests set them. */
export interface SweepOptions {
  /** Real-clock budget in ms; default 2000. */
  budgetMs?: number;
  /** Most directories to look at; default 2000. */
  maxDirs?: number;
  /**
   * Called for each placement just before its mtime is re-checked and it is removed.
   *
   * @internal Test seam; never wire user input into it.
   */
  beforeRemove?: (dir: string) => Promise<void> | void;
}

/** True for an in-flight `.<name>.tmp-<hex>` directory left by `placeBundle`; never a placement. */
function isTempDir(name: string): boolean {
  return name.startsWith(".") && name.includes(".tmp-");
}

/** True for a `.<skill-name>.tmp-<8 hex>` directory, the shape `placeBundle` leaves behind. */
function isPlaceBundleTemp(name: string): boolean {
  const m = /^\.(.+)\.tmp-[0-9a-f]{8}$/.exec(name);
  return m !== null && SkillNameSchema.safeParse(m[1]).success;
}

/**
 * The directories each adapter places native skills in, computed the way `clean` does (Ruling
 * R42). An adapter without a native layout, or one that throws, contributes nothing.
 */
function nativeLayouts(realHome: string): string[] {
  const layouts = new Set<string>();
  for (const id of HARNESS_IDS) {
    try {
      const layout = ADAPTERS[id].nativeSessionRoot({
        sessionHome: realHome,
        vars: { DYNAMIC_SKILLS_NATIVE: "1" },
      } as unknown as HostEnv);
      if (layout !== null) layouts.add(layout);
    } catch {
      // An adapter that needs more of the environment has no layout the sweep can name.
    }
  }
  return [...layouts];
}

/**
 * Lists the placements in the adapters' native layouts, and the crash-orphaned temp directories
 * beside them (Ruling R42). Only direct children of a layout count: a child must have a valid
 * skill name, be a real directory (never a symlink) and hold a regular `SKILL.md`. A layout must
 * be a real directory whose realpath is itself. The walk is capped by directory count and time.
 */
async function listPlacements(
  root: string,
  limits: { maxDirs: number; deadline: number },
): Promise<{ placements: { dir: string; mtimeMs: number }[]; staleTemps: string[] }> {
  const placements: { dir: string; mtimeMs: number }[] = [];
  const staleTemps: string[] = [];
  let visited = 0;
  for (const layout of nativeLayouts(dirname(root))) {
    const rel = relative(root, layout);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    const info = await lstat(layout).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) continue;
    if ((await realpath(layout).catch(() => undefined)) !== layout) continue;
    const names = await readdir(layout).catch(() => [] as string[]);
    for (const name of names) {
      if (visited >= limits.maxDirs || Date.now() >= limits.deadline)
        return { placements, staleTemps };
      visited++;
      const child = join(layout, name);
      if (isTempDir(name)) {
        const st = await lstat(child).catch(() => undefined);
        if (
          st !== undefined &&
          st.isDirectory() &&
          isPlaceBundleTemp(name) &&
          Date.now() - st.mtimeMs > STALE_TEMP_MS
        ) {
          staleTemps.push(child);
        }
        continue;
      }
      if (!SkillNameSchema.safeParse(name).success) continue;
      const st = await lstat(child).catch(() => undefined);
      // `lstat` reports a symlink as a symlink, never as a directory, so links are skipped here.
      if (st === undefined || !st.isDirectory()) continue;
      const skill = await lstat(join(child, "SKILL.md")).catch(() => undefined);
      if (skill?.isFile() === true) placements.push({ dir: child, mtimeMs: st.mtimeMs });
    }
  }
  return { placements, staleTemps };
}

/**
 * Removes expired native placements under `<home>/native` (D5, Ruling R42). The sweep acts only
 * when `<realpath home>/native/.dynamic-skills-native` exists as a regular file (`placeNative`
 * creates it), and only on direct children of each adapter's native layout whose name is a valid
 * skill name, so a user-provided home that holds the user's own `native/` directory is never
 * touched. The policy is core's `selectExpiredPlacements`: a placement goes when no session
 * references it, when every referencing session ended without `activated` or `augmented`, or
 * when it is older than 24 h. A session file that cannot be parsed counts as a reference
 * (fail-safe), so it keeps young placements. Every removal goes through `removePlacedBundle`
 * contained in the real `<home>/native` (Ruling R29), so a placement that was swapped for a
 * symlink is left alone. In-flight temp directories (`.<name>.tmp-*`) are never touched, except
 * those in a layout that are older than the SDK's stale-temp threshold (crash orphans).
 *
 * A placement whose mtime is younger than {@link NATIVE_PLACEMENT_GRACE_MS} on the real clock is
 * kept regardless of the policy (Ruling R39); the mtime is read again right before each removal,
 * so a placement another session refreshed meanwhile is kept. The sweep stops after a 2 s
 * real-clock budget or 2000 directories. The budget is not a hard bound: it is checked between
 * steps, so reading the session files and hashing one placement before its removal can run past it.
 *
 * It may throw (an unreadable session home, say); callers treat it as best effort and must not
 * let it fail `assess` or `activate`.
 *
 * @param home - Session home.
 * @param now - Epoch ms used for the policy's age check (the invocation's clock).
 * @param opts - Limits, lowered by tests.
 * @returns The placement directories that were removed.
 */
export async function sweepNativePlacements(
  home: string,
  now: number,
  opts: SweepOptions = {},
): Promise<string[]> {
  const deadline = Date.now() + (opts.budgetMs ?? SWEEP_BUDGET_MS);
  const realHome = await realpath(home).catch(() => undefined);
  if (realHome === undefined) return [];
  const root = join(realHome, "native");
  const rootStat = await lstat(root).catch(() => undefined);
  // `lstat` never follows: a symlinked `native` is not a directory here (Ruling R38).
  if (rootStat === undefined || !rootStat.isDirectory()) return [];
  if ((await realpath(root)) !== root) return [];
  // No marker, no sweep: the directory was not made by this tool (Ruling R42).
  const marker = await lstat(join(root, NATIVE_MARKER)).catch(() => undefined);
  if (marker?.isFile() !== true) return [];
  const { placements, staleTemps } = await listPlacements(root, {
    maxDirs: opts.maxDirs ?? SWEEP_MAX_DIRS,
    deadline,
  });
  for (const tmp of staleTemps) {
    if (Date.now() >= deadline) break;
    try {
      // The listing is a snapshot: the layout may have become a symlink since (Ruling R42).
      const parent = dirname(tmp);
      if ((await realpath(parent)) !== parent) continue;
      if (!(await lstat(tmp)).isDirectory()) continue;
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // Vanished or unreadable: left for the next sweep.
    }
  }
  if (placements.length === 0) return [];
  const { byDir, unparsable } = await readNativeReferences(realHome);
  if (Date.now() >= deadline) return [];
  const mtimes = new Map(placements.map((p) => [p.dir, p.mtimeMs]));
  const wallNow = Date.now();
  const expired = selectExpiredPlacements({ placements, refs: byDir, unparsable, now }).filter(
    (dir) => !inPlacementGrace(mtimes.get(dir) ?? 0, wallNow),
  );
  const removed: string[] = [];
  for (const dir of expired) {
    if (Date.now() >= deadline) break;
    try {
      await opts.beforeRemove?.(dir);
      // The selection used a snapshot: another session may have refreshed this placement since.
      const fresh = await lstat(dir);
      if (!fresh.isDirectory() || inPlacementGrace(fresh.mtimeMs)) continue;
      const sha = (await bundleManifest(dir)).sha256;
      if (await removePlacedBundle(dir, sha, root)) removed.push(dir);
    } catch {
      // A bundle that cannot be hashed (odd entries, vanished) is left for the next sweep.
    }
  }
  return removed;
}

/** The limitation for a `placeBundle` conflict, by its fixed reason. */
function conflictLimitation(reason: string | undefined, name: string): string {
  const head = "Native registration skipped:";
  switch (reason) {
    case "outside project":
      return `${head} the native placement root resolves outside the session home.`;
    case "symlink":
      return `${head} ${name} in the native root is a symbolic link.`;
    case "differs":
    case "race":
    case undefined:
      return `${head} another session holds a different skill named ${name}.`;
    default:
      return `${head} the native placement root is unusable (${reason}).`;
  }
}

/** Input of {@link placeNative}. */
export interface PlaceNativeInput {
  /** Host environment (real paths). */
  env: HostEnv;
  /** Adapter of the current harness. */
  adapter: HarnessAdapter;
  /** The activated skill's directory inside the session. */
  skillDir: string;
  /** Skill name (the placement's directory name). */
  name: string;
  /** Epoch ms recorded as `placedAt`. */
  now: number;
  /**
   * Test seams passed to `placeBundle`.
   *
   * @internal Never wire user input into these.
   */
  testHooks?: PlaceInput["testHooks"];
}

/** Outcome of {@link placeNative}. */
export interface PlaceNativeResult {
  /** `{ name, path }` of the placed skill; `null` when nothing was placed. */
  native: { name: string; path: string } | null;
  /** Record to store in the session state; `null` when nothing was placed. */
  placement: NativePlacement | null;
  /** True when this call created the directory (as opposed to reusing identical bytes). */
  created?: boolean;
  /** Why registration was skipped; `null` when placed or when native mode is off. */
  limitation: string | null;
}

/**
 * Places the activated skill where the harness can list it natively (D2). Native placement is
 * additive: the agent still reads `loadOrder`, so every failure here degrades to a skip with a
 * limitation and never fails the activation.
 *
 * - The adapter has no native root (native mode off, or unsupported): nothing placed, no
 *   limitation.
 * - A skill with the same name is already installed in a root the host reads: skipped, because the
 *   host would list the placement under a prefixed name.
 * - Otherwise the bundle is copied with `placeBundle` (`native` mode, 0600/0700) contained in
 *   `<sessionHome>/native`. `create` and `unchanged` yield a placement stamped `now`; a conflict
 *   (another session holds different bytes under that name) or any thrown error (including a
 *   bundle layout error) yields a skip.
 *
 * @param input - See {@link PlaceNativeInput}.
 * @returns See {@link PlaceNativeResult}.
 */
export async function placeNative(input: PlaceNativeInput): Promise<PlaceNativeResult> {
  const { env, adapter, skillDir, name, now } = input;
  const none = (limitation: string | null): PlaceNativeResult => ({
    native: null,
    placement: null,
    limitation,
  });
  try {
    const root = adapter.nativeSessionRoot(env);
    if (root === null) return none(null);
    const within = join(env.sessionHome, "native");
    const rel = relative(within, root);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return none("Native registration skipped: the native root is outside the session home.");
    }
    // R38 for writes: `native` must be absent or a real directory, or the bundle would land
    // wherever a symlink points and the sweep would refuse to clean it.
    const nativeStat = await lstat(within).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (nativeStat !== null) {
      if (!nativeStat.isDirectory() || (await realpath(within)) !== within) {
        return none(
          "Native registration skipped: the native directory of the session home is not a plain directory.",
        );
      }
    }
    for (const r of await adapter.readRoots(env)) {
      if ((await lstat(join(r.dir, name)).catch(() => undefined)) !== undefined) {
        return none(
          `Native registration skipped: a skill named ${name} is already installed for this host.`,
        );
      }
    }
    const place = (): ReturnType<typeof placeBundle> =>
      placeBundle({
        srcDir: skillDir,
        destRoot: root,
        name,
        mode: "native",
        // The realpath fixed when the host environment was built: `placeBundle` re-resolves its
        // `within`, so a `native` swapped for a symlink after the check above still lands outside.
        within: env.sessionHome,
        ...(input.testHooks === undefined ? {} : { testHooks: input.testHooks }),
      });
    let placed = await place();
    if (placed.action === "conflict") return none(conflictLimitation(placed.reason, name));
    // Ruling R42: the sweep acts only in a native directory this tool made. `wx` never follows a
    // symlink and never overwrites; an existing marker (EEXIST) is the normal case.
    await writeFile(join(within, NATIVE_MARKER), "", { flag: "wx", mode: 0o600 }).catch(
      () => undefined,
    );
    if (placed.action === "unchanged") {
      // Reuse restarts the grace period (Ruling R45). Another session's `clean` may have removed
      // the placement between `placeBundle` and here; a vanished directory is placed again once,
      // and a second failure is a skip, never a path that no longer exists.
      const refresh = async (): Promise<boolean> => {
        const t = new Date();
        try {
          await utimes(placed.path, t, t);
          return (await lstat(placed.path)).isDirectory();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
          return true; // best effort: any other failure leaves the (existing) placement as is
        }
      };
      if (!(await refresh())) {
        placed = await place();
        if (placed.action === "conflict") return none(conflictLimitation(placed.reason, name));
        if (placed.action === "unchanged" && !(await refresh())) {
          return none("Native registration skipped: the placement was removed by another session.");
        }
      }
    }
    return {
      created: placed.action === "create",
      native: { name, path: placed.path },
      placement: {
        harness: adapter.id,
        dir: placed.path,
        manifestSha256: placed.manifest.sha256,
        placedAt: new Date(now).toISOString(),
      },
      limitation: null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "unexpected error";
    return none(`Native registration skipped: ${message}.`);
  }
}
