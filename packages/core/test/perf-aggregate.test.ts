import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregatePerformance, archivePerformanceReport } from "../src/index";
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

  it("computes the reuse and augmentation rates", async () => {
    for (const outcome of ["activated", "augmented", "reused", "reused"] as const) {
      await put(report({ outcome }));
    }
    expect(await aggregatePerformance(home)).toMatchObject({
      reuseRate: 0.5,
      augmentationRate: 0.25,
    });
  });

  it("skips a symlinked reports directory", async () => {
    await put(report({ activeMs: 5 }));
    const outside = await mkdtemp(join(tmpdir(), "ds-agg-out-"));
    try {
      await writeFile(join(outside, "performance.json"), JSON.stringify(report()));
      await mkdir(join(home, "sessions", "ds-rl"), { recursive: true });
      await symlink(outside, join(home, "sessions", "ds-rl", "reports"));
      expect((await aggregatePerformance(home)).count).toBe(1);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("skips a FIFO performance.json without blocking", async () => {
    await put(report({ activeMs: 5 }));
    await mkdir(join(home, "sessions", "ds-fifo", "reports"), { recursive: true });
    execFileSync("mkfifo", [join(home, "sessions", "ds-fifo", "reports", "performance.json")]);
    expect((await aggregatePerformance(home)).count).toBe(1);
  }, 5_000);

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

describe("archived reports (R21)", () => {
  async function archive(doc: unknown, id: string): Promise<string> {
    const dir = join(home, "reports");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}.json`);
    await writeFile(file, typeof doc === "string" ? doc : JSON.stringify(doc));
    return file;
  }

  it("counts archived reports with live ones, once per session id", async () => {
    const live = await put(report({ activeMs: 5 }), "ds-live");
    await archive(report({ activeMs: 5 }), live); // same session archived and still present
    await archive(report({ activeMs: 9, outcome: "failed" }), "ds-gone");
    const a = await aggregatePerformance(home);
    expect(a.count).toBe(2);
    expect(a.maxActiveMs).toBe(9);
    expect(a.fallbackRate).toBe(0.5);
  });

  it("applies the same safe-read rules to the archive", async () => {
    await archive(report({ activeMs: 1 }), "ds-ok");
    await archive("{not json", "ds-bad");
    await archive({ ...report(), schemaVersion: "2" }, "ds-v2");
    await archive(JSON.stringify({ ...report(), padding: "x".repeat(2_000_000) }), "ds-big");
    execFileSync("mkfifo", [join(home, "reports", "ds-fifo.json")]);
    const outside = await mkdtemp(join(tmpdir(), "ds-agg-out-"));
    try {
      await writeFile(join(outside, "r.json"), JSON.stringify(report()));
      await symlink(join(outside, "r.json"), join(home, "reports", "ds-link.json"));
      expect((await aggregatePerformance(home)).count).toBe(1);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 5_000);

  it("skips a symlinked archive directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ds-agg-out-"));
    try {
      await writeFile(join(outside, "ds-a.json"), JSON.stringify(report()));
      await symlink(outside, join(home, "reports"));
      expect((await aggregatePerformance(home)).count).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("archivePerformanceReport", () => {
  it("copies a valid report to <home>/reports/<id>.json, 0600 in a 0700 directory", async () => {
    await put(report({ sessionId: "ds-a", activeMs: 3 }), "ds-a");
    expect(await archivePerformanceReport(home, "ds-a")).toBe(true);
    const file = join(home, "reports", "ds-a.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ activeMs: 3 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "reports"))).mode & 0o777).toBe(0o700);
  });

  it("archives nothing for a missing or invalid report", async () => {
    await mkdir(join(home, "sessions", "ds-none"), { recursive: true });
    expect(await archivePerformanceReport(home, "ds-none")).toBe(false);
    await put("{not json", "ds-bad");
    expect(await archivePerformanceReport(home, "ds-bad")).toBe(false);
    expect(await stat(join(home, "reports", "ds-bad.json")).catch(() => null)).toBeNull();
  });

  it("refuses to write through a symlinked archive file", async () => {
    await put(report(), "ds-a");
    const outside = await mkdtemp(join(tmpdir(), "ds-agg-out-"));
    try {
      await mkdir(join(home, "reports"), { recursive: true });
      await symlink(join(outside, "victim"), join(home, "reports", "ds-a.json"));
      await expect(archivePerformanceReport(home, "ds-a")).rejects.toThrow();
      expect(await stat(join(outside, "victim")).catch(() => null)).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
