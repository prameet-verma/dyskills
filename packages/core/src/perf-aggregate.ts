import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PerformanceReportSchema } from "./contracts";
import type { PerformanceReport } from "./contracts";

/** Largest `performance.json` read, in bytes; a real report is well under 1 KiB. */
const MAX_REPORT_BYTES = 1_048_576;

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
 * Reads one session's performance report, or `null` when it is absent or untrusted. The session
 * directory and the file are checked with `lstat` so a symlink planted under the home cannot make
 * this read outside it; oversized, unparseable or wrong-`schemaVersion` files are skipped.
 */
async function readReport(sessionDir: string): Promise<PerformanceReport | null> {
  try {
    if (!(await lstat(sessionDir)).isDirectory()) return null;
    const file = join(sessionDir, "reports", "performance.json");
    const st = await lstat(file);
    if (!st.isFile() || st.size > MAX_REPORT_BYTES) return null;
    const parsed = PerformanceReportSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Aggregates the performance reports of every session under `<home>/sessions` (PRD §10.8, §17).
 * Never throws for bad data: a missing sessions directory yields `count: 0`, and any session whose
 * report is missing, symlinked, oversized, unparseable or not `schemaVersion: "1"` is skipped.
 * Sessions still in progress have no report and are not counted.
 *
 * @param home - The session home (`DYNAMIC_SKILLS_HOME`).
 */
export async function aggregatePerformance(home: string): Promise<PerformanceAggregate> {
  const root = join(home, "sessions");
  const names = await readdir(root).catch(() => [] as string[]);
  const reports: PerformanceReport[] = [];
  for (const name of names.sort()) {
    const r = await readReport(join(root, name));
    if (r) reports.push(r);
  }
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
