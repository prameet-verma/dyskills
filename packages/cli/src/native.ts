import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { bundleManifest, placeBundle, removePlacedBundle } from "@dynamic-skills/adapter-sdk";
import type { HarnessAdapter, HostEnv } from "@dynamic-skills/adapter-sdk";
import { readNativeReferences, selectExpiredPlacements } from "@dynamic-skills/core";
import type { NativePlacement } from "@dynamic-skills/core";

/** Deepest directory level (below `<home>/native`) at which a placement is looked for. */
const SWEEP_MAX_DEPTH = 4;

/** Most directories the sweep looks at in one run; keeps it far below the 60 s budget. */
const SWEEP_MAX_DIRS = 2_000;

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
async function listPlacements(root: string): Promise<{ dir: string; mtimeMs: number }[]> {
  const found: { dir: string; mtimeMs: number }[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (visited >= SWEEP_MAX_DIRS) return;
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
      if (st === undefined || st.isSymbolicLink() || !st.isDirectory()) continue;
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
 * @param now - Epoch ms used for the age check.
 * @returns The placement directories that were removed.
 */
export async function sweepNativePlacements(home: string, now: number): Promise<string[]> {
  const realHome = await realpath(home).catch(() => undefined);
  if (realHome === undefined) return [];
  const root = join(realHome, "native");
  const rootStat = await lstat(root).catch(() => undefined);
  if (rootStat === undefined || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
  const placements = await listPlacements(root);
  if (placements.length === 0) return [];
  const { byDir, unparsable } = await readNativeReferences(realHome);
  const expired = selectExpiredPlacements({ placements, refs: byDir, unparsable, now });
  const removed: string[] = [];
  const realRoot = await realpath(root);
  for (const dir of expired) {
    try {
      const sha = (await bundleManifest(dir)).sha256;
      if (await removePlacedBundle(dir, sha, realRoot)) removed.push(dir);
    } catch {
      // A bundle that cannot be hashed (odd entries, vanished) is left for the next sweep.
    }
  }
  return removed;
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
}

/** Outcome of {@link placeNative}. */
export interface PlaceNativeResult {
  /** `{ name, path }` of the placed skill; `null` when nothing was placed. */
  native: { name: string; path: string } | null;
  /** Record to store in the session state; `null` when nothing was placed. */
  placement: NativePlacement | null;
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
    });
    if (placed.action === "conflict") {
      return none(
        `Native registration skipped: another session holds a different skill named ${name}.`,
      );
    }
    return {
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
