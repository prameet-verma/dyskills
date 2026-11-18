import { lstat, readdir, realpath, utimes } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { bundleManifest, placeBundle, removePlacedBundle } from "@dynamic-skills/adapter-sdk";
import type { HarnessAdapter, HostEnv, PlaceInput } from "@dynamic-skills/adapter-sdk";
import { readNativeReferences, selectExpiredPlacements } from "@dynamic-skills/core";
import type { NativePlacement } from "@dynamic-skills/core";

/** Deepest directory level (below `<home>/native`) at which a placement is looked for. */
const SWEEP_MAX_DEPTH = 4;

/** Most directories the sweep looks at in one run; keeps it far below the 60 s budget. */
const SWEEP_MAX_DIRS = 2_000;

/** Real-clock budget of one sweep (2 s); it stops enumerating and removing once it is spent. */
const SWEEP_BUDGET_MS = 2_000;

/**
 * Grace period (10 min, real clock) for a fresh placement (Ruling R39). A session's placement is
 * unreferenced between `placeNative` and its save, so a sweep in another process must not take a
 * directory whose mtime is younger than this. Only `0 <= age < grace` counts: a future-dated
 * mtime gets no grace, so it cannot keep a placement forever.
 */
export const NATIVE_PLACEMENT_GRACE_MS = 600_000;

/** Optional limits of {@link sweepNativePlacements}; tests lower them. */
export interface SweepOptions {
  /** Real-clock budget in ms; default 2000. */
  budgetMs?: number;
  /** Most directories to look at; default 2000. */
  maxDirs?: number;
}

/** True for an in-flight `.<name>.tmp-<hex>` directory left by `placeBundle`; never swept. */
function isTempDir(name: string): boolean {
  return name.startsWith(".") && name.includes(".tmp-");
}

/**
 * Lists every placement under `root`: a real directory that directly contains a regular
 * `SKILL.md`. Symlinks are never followed (every entry is `lstat`ed and non-directories skipped),
 * in-flight temp directories are skipped, the walk is capped by depth and by directory count, and
 * a directory that cannot be read is skipped.
 */
async function listPlacements(
  root: string,
  limits: { maxDirs: number; deadline: number },
): Promise<{ dir: string; mtimeMs: number }[]> {
  const found: { dir: string; mtimeMs: number }[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (visited >= limits.maxDirs || Date.now() >= limits.deadline) return;
    visited++;
    const skill = await lstat(join(dir, "SKILL.md")).catch(() => undefined);
    if (skill?.isFile() === true) {
      const st = await lstat(dir).catch(() => undefined);
      if (st !== undefined) found.push({ dir, mtimeMs: st.mtimeMs });
      return;
    }
    if (depth >= SWEEP_MAX_DEPTH) return;
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (isTempDir(name)) continue;
      const child = join(dir, name);
      const st = await lstat(child).catch(() => undefined);
      // `lstat` reports a symlink as a symlink, never as a directory, so links are skipped here.
      if (st === undefined || !st.isDirectory()) continue;
      await walk(child, depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

/**
 * Removes expired native placements under `<home>/native` (D5). Placements are found generically
 * (no harness path is built in), and the policy is core's `selectExpiredPlacements`: a placement
 * goes when no session references it, when every referencing session ended without `activated` or
 * `augmented`, or when it is older than 24 h. A session file that cannot be parsed counts as a
 * reference (fail-safe), so it keeps young placements. Every removal goes through
 * `removePlacedBundle` contained in the real `<home>/native` (Ruling R29), so a placement that
 * was swapped for a symlink, or whose name is not a skill name, is left alone. In-flight temp
 * directories (`.<name>.tmp-*`) are never touched.
 *
 * It may throw (an unreadable session home, say); callers treat it as best effort and must not
 * let it fail `assess` or `activate`.
 *
 * @param home - Session home.
 * A placement whose mtime is younger than {@link NATIVE_PLACEMENT_GRACE_MS} on the real clock is
 * kept regardless of the policy (Ruling R39), and the sweep stops after a 2 s real-clock budget
 * or 2000 directories. The budget is not a hard bound: it is checked between steps, so reading
 * the session files and hashing one placement before its removal can run past it.
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
  const placements = await listPlacements(root, {
    maxDirs: opts.maxDirs ?? SWEEP_MAX_DIRS,
    deadline,
  });
  if (placements.length === 0) return [];
  const { byDir, unparsable } = await readNativeReferences(realHome);
  if (Date.now() >= deadline) return [];
  const mtimes = new Map(placements.map((p) => [p.dir, p.mtimeMs]));
  const wallNow = Date.now();
  const expired = selectExpiredPlacements({ placements, refs: byDir, unparsable, now }).filter(
    (dir) => {
      // mtime has sub-millisecond digits that `Date.now()` lacks; floor so "just now" is age 0.
      const age = wallNow - Math.floor(mtimes.get(dir) ?? 0);
      return !(age >= 0 && age < NATIVE_PLACEMENT_GRACE_MS);
    },
  );
  const removed: string[] = [];
  const realRoot = root;
  for (const dir of expired) {
    if (Date.now() >= deadline) break;
    try {
      const sha = (await bundleManifest(dir)).sha256;
      if (await removePlacedBundle(dir, sha, realRoot)) removed.push(dir);
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
    const placed = await placeBundle({
      srcDir: skillDir,
      destRoot: root,
      name,
      mode: "native",
      within,
      ...(input.testHooks === undefined ? {} : { testHooks: input.testHooks }),
    });
    if (placed.action === "conflict") return none(conflictLimitation(placed.reason, name));
    if (placed.action === "unchanged") {
      // Reuse restarts the grace period; best effort.
      const t = new Date();
      await utimes(placed.path, t, t).catch(() => undefined);
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
