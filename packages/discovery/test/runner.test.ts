import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCOVERY_CONCURRENCY } from "@dynamic-skills/core";
import { describe, expect, it } from "vitest";
import { ALL_DETECTORS, runDiscovery, selectDetectors, type Detector } from "../src/index";
import { fixture } from "./helpers";

describe("runDiscovery", () => {
  it("discovers the TS monorepo", async () => {
    const { registry } = await runDiscovery({
      repo: fixture("ts-monorepo"),
      task: "add vitest tests for orders",
    });
    expect(registry.get("runtime.node")?.value).toBe("20.11.0");
    expect(registry.get("package-manager")).toMatchObject({
      value: "pnpm",
      confidence: "verified",
    });
    for (const k of ["framework.react", "testing.vitest", "monorepo.nx", "build.script.test"]) {
      expect(registry.get(k), k).toBeDefined();
    }
    expect(registry.get("framework.react")).toMatchObject({
      value: "^18.3.1",
      confidence: "inferred",
    });
    expect(registry.get("runtime.node.engines")?.value).toBe("›=20"); // sanitiser swaps < and > for lookalikes
    expect(registry.get("monorepo.pnpm-workspace")?.value).toBe("packages/*");
    expect(registry.get("monorepo.workspaces")).toBeUndefined();
  });

  it("discovers the Python service", async () => {
    const repo = fixture("python-service");
    const { registry } = await runDiscovery({ repo, task: "add an endpoint" });
    expect(registry.get("runtime.python")?.value).toBe("3.12");
    expect(registry.get("framework.fastapi")).toBeDefined();
    expect(registry.get("testing.pytest")).toMatchObject({ confidence: "verified" });
    expect(registry.get("database.alembic")).toBeUndefined();

    const data = await runDiscovery({ repo, task: "write a database migration" });
    expect(data.registry.get("database.alembic")).toBeDefined();
    expect(data.registry.get("database.sqlalchemy")).toBeDefined();
  });

  it("records conflicts", async () => {
    const { registry } = await runDiscovery({ repo: fixture("conflicting"), task: "x" });
    expect(registry.get("package-manager")?.confidence).toBe("conflicting");
    expect(registry.get("runtime.node")?.confidence).toBe("conflicting");
  });

  it("handles an empty repo", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ds-empty-"));
    const r = await runDiscovery({ repo: empty, task: "x" });
    expect(r.errors).toEqual([]);
    expect(r.registry.toJSON()).toEqual([]);
    expect(r.files.files).toEqual([]);
  });

  it("isolates a throwing detector", async () => {
    const boom: Detector = {
      id: "boom",
      categories: ["runtime"],
      always: true,
      run: () => Promise.reject(new Error("kaput")),
    };
    const r = await runDiscovery({
      repo: fixture("python-service"),
      task: "x",
      detectors: [boom, ...ALL_DETECTORS],
    });
    expect(r.errors).toEqual([{ detector: "boom", message: "kaput" }]);
    expect(r.registry.get("runtime.python")).toBeDefined();
    expect(r.detectorsRun).toContain("boom");
    expect(Object.keys(r.durations)).toContain("boom");
  });

  it("selects the database detector only for data tasks", () => {
    const ids = (t: string) => selectDetectors(t, ALL_DETECTORS).map((d) => d.id);
    expect(ids("fix README typo")).not.toContain("database");
    expect(ids("write a database migration")).toContain("database");
    expect(ids("fix README typo")).toContain("runtime");
  });

  describe("concurrency", () => {
    const slow = (inflight: { cur: number; max: number }): Detector[] =>
      Array.from({ length: 12 }, (_, i) => ({
        id: `d${i}`,
        categories: [],
        always: true,
        async run() {
          inflight.cur++;
          inflight.max = Math.max(inflight.max, inflight.cur);
          await new Promise((r) => setTimeout(r, 15));
          inflight.cur--;
          return [];
        },
      }));

    it("runs detectors in parallel, bounded by DISCOVERY_CONCURRENCY", async () => {
      const inflight = { cur: 0, max: 0 };
      await runDiscovery({ repo: fixture("ts-monorepo"), task: "x", detectors: slow(inflight) });
      expect(inflight.max).toBeGreaterThan(1);
      expect(inflight.max).toBeLessThanOrEqual(DISCOVERY_CONCURRENCY);
    });

    it("merges evidence and errors in detector order even when detectors finish in reverse", async () => {
      const n = 6;
      const detectors: Detector[] = Array.from({ length: n }, (_, i) => ({
        id: `d${i}`,
        categories: ["runtime"],
        always: true,
        async run(ctx) {
          await new Promise((r) => setTimeout(r, (n - i) * 15));
          if (i % 2 === 1) throw new Error(`boom${i}`);
          return [
            {
              key: "runtime.order",
              value: `v${i}`,
              category: "runtime",
              source: `d${i}`,
              confidence: "inferred",
              revision: ctx.revision,
            },
          ];
        },
      }));
      const r = await runDiscovery({
        repo: fixture("ts-monorepo"),
        task: "x",
        detectors,
        concurrency: n,
      });
      const e = r.registry.get("runtime.order");
      expect(e?.conflicts[0]).toBe("v0 (d0)");
      expect(e?.conflicts[1]).toBe("v2 (d2)");
      expect(e?.conflicts[2]).toBe("v4 (d4)");
      expect(r.detectorsRun).toEqual(detectors.map((d) => d.id));
      // Errors are recorded as detectors fail (reverse completion), which proves the delays bite.
      expect(r.errors.map((x) => x.detector)).toEqual(["d5", "d3", "d1"]);
    });

    it("honours an explicit concurrency of 1", async () => {
      const inflight = { cur: 0, max: 0 };
      await runDiscovery({
        repo: fixture("ts-monorepo"),
        task: "x",
        detectors: slow(inflight),
        concurrency: 1,
      });
      expect(inflight.max).toBe(1);
    });

    it("rejects with an AbortError when aborted mid-run, before all detectors start", async () => {
      const started: string[] = [];
      const ac = new AbortController();
      const detectors: Detector[] = Array.from({ length: 12 }, (_, i) => ({
        id: `d${i}`,
        categories: [],
        always: true,
        async run() {
          started.push(`d${i}`);
          if (i === 0) ac.abort();
          await new Promise((r) => setTimeout(r, 5));
          return [];
        },
      }));
      await expect(
        runDiscovery({
          repo: fixture("ts-monorepo"),
          task: "x",
          detectors,
          concurrency: 1,
          signal: ac.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(started.length).toBeLessThan(12);
    });
  });
});
