import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PerformanceReportSchema } from "./contracts";
import type { PerformanceReport } from "./contracts";
import { ensurePrivateDir, writeSessionFile } from "./session";

/** Largest `performance.json` read, in bytes; a real report is well under 1 KiB. */
const MAX_REPORT_BYTES = 1_048_576;

/** Directory under the home that keeps the performance reports of cleaned sessions (Ruling R21). */
const ARCHIVE_DIR = "reports";

/** Aggregate over every session's `reports/performance.json` (PRD §10.8, §17). */
export interface PerformanceAggregate {
  /** Number of valid reports aggregated. */
  count: number;
  /** Median active time in ms (nearest rank), `null` when `count` is 0. */
  p50ActiveMs: number | null;
  /** 95th percentile active time in ms (nearest rank), `null` when `count` is 0. */
  p95ActiveMs: number | null;
  /** Largest active time in ms, `null` when `count` is 0. */
  maxActiveMs: number | null;
  /** Share of sessions whose outcome is `timeout`. */
  timeoutRate: number;
  /** Share of sessions that fell back to the original task: outcome `timeout` or `failed`. */
  fallbackRate: number;
  /** Share of sessions that reused an existing skill unchanged. */
  reuseRate: number;
  /** Share of sessions that activated an augmentation of an existing skill. */
  augmentationRate: number;
  /** Mean cache hit rate over sessions that had cache lookups; `null` when none did. */
  cacheHitRate: number | null;
  /** Mean human clarification rounds per session. */
  avgClarificationRounds: number;
  /** Mean targeted context requests per session. */
  avgContextRequests: number;
}

/**
 * Nearest-rank percentile of an ascending list: `sorted[ceil(q * n) - 1]`. Always returns a value
 * that was actually observed, which suits small samples better than interpolation.
 */
function nearestRank(sorted: number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;
}

/** Mean of a list; 0 for an empty list so callers never produce NaN. */
function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Opens `file` once with `O_NOFOLLOW | O_NONBLOCK` and checks it through that same handle (regular
 * file, size cap), so the file checked is the file read, a symlink is refused and a FIFO swapped
 * in cannot hang the command. Oversized, unparseable or wrong-`schemaVersion` files read as `null`.
 */
async function readReportFile(file: string): Promise<PerformanceReport | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_REPORT_BYTES) return null;
    const parsed = PerformanceReportSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** True when `dir` is a real directory (`lstat`: a symlink is not). */
async function isRealDir(dir: string): Promise<boolean> {
  return lstat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/**
 * Reads one session's performance report, or `null` when it is absent or untrusted. The session
 * directory and `reports/` are checked with `lstat` (a symlink in either is skipped, so nothing
 * outside the home is read); the file itself is read by {@link readReportFile}.
 */
async function readReport(sessionDir: string): Promise<PerformanceReport | null> {
  if (!(await isRealDir(sessionDir))) return null;
  const reportsDir = join(sessionDir, "reports");
  if (!(await isRealDir(reportsDir))) return null;
  return readReportFile(join(reportsDir, "performance.json"));
}

/**
 * Archives a session's `reports/performance.json` to `<home>/reports/<sessionId>.json` before the
 * session is cleaned (Ruling R21), so `clean` never erases the PRD §17 metrics. The report is read
 * with the same rules as {@link aggregatePerformance} and re-serialised from its validated form;
 * the archive directory is made private (mode 0700, see {@link ensurePrivateDir}) and the file is
 * written 0600 without following a symlink.
 *
 * @param home - The session home.
 * @param sessionId - A validated session id (the caller resolved it through the session store).
 * @returns `true` when a report was archived, `false` when the session has no valid report (it
 *   has not ended, or its report is missing or untrusted).
 * @throws {UnsafeHomeError} if `<home>/reports` is unsafe; any write error.
 */
export async function archivePerformanceReport(home: string, sessionId: string): Promise<boolean> {
  const report = await readReport(join(home, "sessions", sessionId));
  if (report === null) return false;
  const dir = join(home, ARCHIVE_DIR);
  await ensurePrivateDir(dir);
  // A random exclusive temp plus rename: a pre-planted hard link or symlink at the final name is
  // replaced, never truncated or written through.
  await writeSessionFile(
    home,
    `${ARCHIVE_DIR}/${sessionId}.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return true;
}

/** Reads every `<home>/reports/*.json` archive, keyed by session id (the file name stem). */
async function readArchive(home: string): Promise<Map<string, PerformanceReport>> {
  const out = new Map<string, PerformanceReport>();
  const dir = join(home, ARCHIVE_DIR);
  if (!(await isRealDir(dir))) return out;
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const r = await readReportFile(join(dir, name));
    if (r) out.set(name.slice(0, -".json".length), r);
  }
  return out;
}

/**
 * Aggregates the performance reports of every session under `<home>/sessions` and of every
 * cleaned session archived under `<home>/reports` (PRD §10.8, §17; Ruling R21). Reports are
 * de-duplicated by session id (the session directory name or the archive file name), a live
 * session winning over its archive, so a session is counted once whether or not it was cleaned.
 * Never throws for bad data: a missing directory yields no reports, and any report that is
 * missing, symlinked, oversized, unparseable or not `schemaVersion: "1"` is skipped. Sessions
 * still in progress have no report and are not counted.
 *
 * @param home - The session home (`DYNAMIC_SKILLS_HOME`).
 */
export async function aggregatePerformance(home: string): Promise<PerformanceAggregate> {
  const root = join(home, "sessions");
  const names = await readdir(root).catch(() => [] as string[]);
  const byId = new Map<string, PerformanceReport>();
  for (const name of names.sort()) {
    const r = await readReport(join(root, name));
    if (r) byId.set(name, r);
  }
  for (const [id, r] of await readArchive(home)) {
    if (!byId.has(id)) byId.set(id, r);
  }
  const reports = [...byId.values()];
  const n = reports.length;
  const active = reports.map((r) => r.activeMs).sort((a, b) => a - b);
  const share = (...outcomes: Array<PerformanceReport["outcome"]>): number =>
    n === 0 ? 0 : reports.filter((r) => outcomes.includes(r.outcome)).length / n;
  const cache = reports.flatMap((r) => (r.cacheHitRate === null ? [] : [r.cacheHitRate]));
  return {
    count: n,
    p50ActiveMs: n === 0 ? null : nearestRank(active, 0.5),
    p95ActiveMs: n === 0 ? null : nearestRank(active, 0.95),
    maxActiveMs: n === 0 ? null : (active.at(-1) as number),
    timeoutRate: share("timeout"),
    fallbackRate: share("timeout", "failed"),
    reuseRate: share("reused"),
    augmentationRate: share("augmented"),
    cacheHitRate: cache.length === 0 ? null : mean(cache),
    avgClarificationRounds: mean(reports.map((r) => r.clarificationRounds)),
    avgContextRequests: mean(reports.map((r) => r.contextRequests)),
  };
}
