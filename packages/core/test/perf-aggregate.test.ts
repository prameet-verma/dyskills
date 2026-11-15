import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregatePerformance } from "../src/index";
import type { PerformanceReport } from "../src/index";

let home: string;
let n = 0;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ds-agg-"));
  n = 0;
});
afterEach(() => rm(home, { recursive: true, force: true }));

function report(over: Partial<PerformanceReport> = {}): PerformanceReport {
  return {
    schemaVersion: "1",
    sessionId: "ds-x",
    wallMs: 0,
    activeMs: 0,
    humanWaitMs: 0,
    clarificationRounds: 0,
    stageMs: {},
    llmInteractions: 0,
    parallelOps: 0,
    cacheHitRate: null,
    evaluationMs: 0,
    activationMs: 0,
    contextRequests: 0,
    contextRequestRounds: 0,
    analysisSubmissions: 0,
    packetTokens: 0,
    outcome: "activated",
    ...over,
  };
}

async function put(doc: unknown, name = `ds-${n++}`): Promise<string> {
  const dir = join(home, "sessions", name, "reports");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "performance.json"),
    typeof doc === "string" ? doc : JSON.stringify(doc),
  );
  return name;
}

describe("aggregatePerformance", () => {
  it("returns an empty aggregate for an empty home", async () => {
    expect(await aggregatePerformance(home)).toEqual({
      count: 0,
      p50ActiveMs: null,
      p95ActiveMs: null,
      maxActiveMs: null,
      timeoutRate: 0,
      fallbackRate: 0,
      reuseRate: 0,
      augmentationRate: 0,
      cacheHitRate: null,
      avgClarificationRounds: 0,
      avgContextRequests: 0,
    });
  });

  it("uses the nearest-rank percentile", async () => {
    for (const s of [10, 20, 30, 40, 50]) await put(report({ activeMs: s * 1000 }));
    const a = await aggregatePerformance(home);
    expect(a).toMatchObject({
      count: 5,
      p50ActiveMs: 30_000,
      p95ActiveMs: 50_000,
      maxActiveMs: 50_000,
    });
  });

  it("averages context requests and clarification rounds", async () => {
    for (const c of [0, 2, 4])
      await put(report({ contextRequests: c, clarificationRounds: c / 2 }));
    expect(await aggregatePerformance(home)).toMatchObject({
      avgContextRequests: 2,
      avgClarificationRounds: 1,
    });
  });

  it("computes outcome rates", async () => {
    for (const outcome of ["activated", "augmented", "reused", "reused"] as const) {
      await put(report({ outcome }));
    }
    await put(report({ outcome: "timeout" }));
    await put(report({ outcome: "failed" }));
    expect(await aggregatePerformance(home)).toMatchObject({
      count: 6,
      reuseRate: 2 / 6,
      augmentationRate: 1 / 6,
      timeoutRate: 1 / 6,
      fallbackRate: 2 / 6,
    });
  });

  it("averages the cache hit rate over sessions that had lookups", async () => {
    await put(report({ cacheHitRate: 0.5 }));
    await put(report({ cacheHitRate: 1 }));
    await put(report({ cacheHitRate: null }));
    expect((await aggregatePerformance(home)).cacheHitRate).toBe(0.75);
  });

  it("skips unparseable, wrong-version, oversized and symlinked reports", async () => {
    await put(report({ activeMs: 5 }));
    await put("{not json");
    await put({ ...report(), schemaVersion: "2" });
    await put(JSON.stringify({ ...report(), padding: "x".repeat(2_000_000) }));
    const outside = await mkdtemp(join(tmpdir(), "ds-agg-out-"));
    try {
      await mkdir(join(outside, "reports"), { recursive: true });
      await writeFile(join(outside, "reports/performance.json"), JSON.stringify(report()));
      await symlink(outside, join(home, "sessions", "ds-link"));
      const a = await aggregatePerformance(home);
      expect(a.count).toBe(1);
      expect(a.maxActiveMs).toBe(5);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
