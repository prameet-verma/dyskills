/* eslint-disable @typescript-eslint/no-explicit-any */
import { ContextAnalysisResultSchema, ContextPacketSchema } from "@dynamic-skills/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysisFixture, discovered, harness } from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

const request = (...paths: string[]) => ({
  schemaVersion: "1",
  action: "request_context",
  requests: paths.map((path) => ({ type: "documentation", path, reason: "needed" })),
});

async function ask(id: string, ...paths: string[]) {
  const file = await h.doc("req.json", request(...paths));
  return h.run(["context", "request", "--session", id, "--file", file]);
}

async function submit(id: string, doc: unknown) {
  const file = await h.doc("analysis.json", doc);
  return h.run(["context", "submit", "--session", id, "--file", file]);
}

describe("context request", () => {
  it("rejects a secret file and adds a plain one as a new packet revision", async () => {
    const id = await discovered(h);
    const secret = await ask(id, ".env");
    expect(secret.exitCode).toBe(0);
    expect(secret.out.rejected).toEqual([{ path: ".env", reason: "secret" }]);
    expect(secret.out.added).toEqual([]);
    expect(secret.out.packetRevision).toBe(1);

    const ok = await ask(id, "README.md");
    expect(ok.out.added).toEqual(["README.md"]);
    expect(ok.out.packetRevision).toBe(2);
    const packet = ContextPacketSchema.parse(await h.readJson(id, "context-packet.json"));
    expect(packet.relevantFiles.map((f) => f.path)).toContain("README.md");
    expect(JSON.stringify(packet)).not.toContain("FAKE_SECRET_VALUE_123");

    const state = await h.readJson(id, "session.json");
    expect(state.completedSteps.at(-1)).toBe("context-request");
    expect(state.metrics).toMatchObject({
      contextRequestRounds: 2,
      contextRequests: 1,
      llmInteractions: 2,
    });
  });

  it("limits the rounds: the fourth request is rejected entirely", async () => {
    const id = await discovered(h);
    await ask(id, ".env");
    await ask(id, ".npmrc");
    await ask(id, "README.md");
    const fourth = await ask(id, "package.json", "nx.json");
    expect(fourth.out.roundsRemaining).toBe(0);
    expect(fourth.out.added).toEqual([]);
    expect(fourth.out.rejected.map((r: any) => r.reason)).toEqual(["round-limit", "round-limit"]);
    expect((await h.readJson(id, "session.json")).metrics.contextRequestRounds).toBe(3);
  });

  it("rejects a request without schemaVersion and changes nothing", async () => {
    const id = await discovered(h);
    const before = await h.read(id, "session.json");
    const file = await h.doc("bad.json", { action: "request_context", requests: [] });
    const r = await h.run(["context", "request", "--session", id, "--file", file]);
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("SCHEMA_INVALID");
    expect(r.out.issues.length).toBeGreaterThan(0);
    expect(await h.read(id, "session.json")).toBe(before);
  });

  it("reports unparseable JSON as one invalid-JSON issue", async () => {
    const id = await discovered(h);
    const file = await h.doc("junk.json", "{ nope");
    const r = await h.run(["context", "request", "--session", id, "--file", file]);
    expect(r.out).toMatchObject({
      error: "SCHEMA_INVALID",
      issues: [{ path: "", message: "invalid JSON" }],
    });
  });

  it("reports a missing --file as USAGE", async () => {
    const id = await discovered(h);
    const r = await h.run(["context", "request", "--session", id, "--file", "absent.json"]);
    expect(r.out.error).toBe("USAGE");
  });
});

describe("context submit", () => {
  it("shows Analysing once the analysis is accepted, not before (M3)", async () => {
    const id = await discovered(h);
    expect((await h.readJson(id, "session.json")).status).toBe("discovering");
    await submit(id, { schemaVersion: "1" });
    expect((await h.readJson(id, "session.json")).status).toBe("discovering");
    const r = await submit(id, await analysisFixture("minimal.json"));
    expect(r.stderr).toContain("Status: Analysing");
    expect((await h.readJson(id, "session.json")).status).toBe("analysing");
  });

  it("rejects an invalid analysis and leaves evidence untouched", async () => {
    const id = await discovered(h);
    const count = (await h.readJson(id, "evidence.json")).items.length;
    const r = await submit(id, { schemaVersion: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("SCHEMA_INVALID");
    expect(r.out.issues.length).toBeGreaterThan(0);
    expect((await h.readJson(id, "evidence.json")).items).toHaveLength(count);
    expect(await h.exists(id, "context-analysis.json")).toBe(false);

    const prose = { ...(await analysisFixture("ts-monorepo-caching.json")), summary: "prose" };
    expect((await submit(id, prose)).out.error).toBe("SCHEMA_INVALID");
  });

  it("rejects an unknown packet revision and accepts an older one with a warning", async () => {
    const id = await discovered(h);
    const fixture = await analysisFixture("minimal.json");
    const future = await submit(id, { ...fixture, analysedPacketRevision: 2 });
    expect(future.out.error).toBe("SCHEMA_INVALID");
    expect(future.out.issues[0].path).toBe("analysedPacketRevision");

    await ask(id, "README.md");
    const old = await submit(id, fixture);
    expect(old.exitCode).toBe(0);
    expect(old.out.warnings).toContain("analysis based on packet revision 1 of 2");
  });

  it("consolidates the caching analysis", async () => {
    const id = await discovered(h);
    const r = await submit(id, await analysisFixture("ts-monorepo-caching.json"));
    expect(r.exitCode).toBe(0);
    expect(r.out.evidenceAdded).toContain("agentic.architecture.order-read-path");
    expect(r.out.gaps.find((g: any) => g.requirement === "testing")).toMatchObject({
      resolution: "none",
    });
    expect(r.out.inspectGapsRemaining).toBe(0);
    expect(r.out.submissionsRemaining).toBe(3);
    expect(r.out.unknowns).toEqual([expect.stringMatching(/^unknown\./)]);

    const state = await h.readJson(id, "session.json");
    expect(state.completedSteps.at(-1)).toBe("context-submit");
    expect(state.metrics).toMatchObject({ analysisSubmissions: 1, llmInteractions: 1 });
    expect(state.metrics.stageMs.analysis).toBe(0);
    ContextAnalysisResultSchema.parse(await h.readJson(id, "context-analysis.json"));
    const evidence = await h.readJson(id, "evidence.json");
    expect(evidence.items.map((e: any) => e.key)).toContain("agentic.architecture.order-read-path");
  });

  it("drops an unknown, its requirement and its gap when the analysis is resubmitted without it", async () => {
    const id = await discovered(h);
    const first = await submit(id, await analysisFixture("ts-monorepo-caching.json"));
    const [unknownId] = first.out.unknowns as string[];
    expect(unknownId).toMatch(/^unknown\./);
    expect(first.out.gaps.map((g: any) => g.requirement)).toContain(unknownId);
    expect((await h.readJson(id, "session.json")).requirements.map((r: any) => r.id)).toContain(
      unknownId,
    );

    const second = await submit(id, {
      ...(await analysisFixture("ts-monorepo-caching.json")),
      unknowns: [],
    });
    expect(second.exitCode).toBe(0);
    expect(second.out.unknowns).toEqual([]);
    expect(second.out.gaps.map((g: any) => g.requirement)).not.toContain(unknownId);
    const state = await h.readJson(id, "session.json");
    expect(state.requirements.map((r: any) => r.id)).not.toContain(unknownId);
    expect(state.gaps.map((g: any) => g.requirement)).not.toContain(unknownId);
  });

  it("measures the analysis stage from the end of discovery, excluding nothing else", async () => {
    const id = await discovered(h);
    h.clock.t += 7_000;
    await submit(id, await analysisFixture("minimal.json"));
    expect((await h.readJson(id, "session.json")).metrics.stageMs.analysis).toBe(7_000);
  });

  it("downgrades an observed claim with an unresolvable source", async () => {
    const id = await discovered(h);
    const doc = await analysisFixture("ts-monorepo-caching.json");
    doc.evidence.push({
      key: "ghost",
      claim: "A file that does not exist holds the cache",
      source: "src/nope.ts",
      type: "observed",
      category: "architecture",
    });
    const r = await submit(id, doc);
    expect(r.out.downgraded).toEqual(["agentic.architecture.ghost"]);
  });

  it("accepts the minimal document", async () => {
    const id = await discovered(h);
    const r = await submit(id, await analysisFixture("minimal.json"));
    expect(r.exitCode).toBe(0);
  });

  it("replaces the previous analysis instead of accumulating", async () => {
    const id = await discovered(h);
    const first = await analysisFixture("ts-monorepo-caching.json");
    await submit(id, first);
    const second = structuredClone(first);
    second.evidence[0].claim = "The order read path is getOrder in the orders package";
    const r = await submit(id, second);
    const items = (await h.readJson(id, "evidence.json")).items;
    const keys = items.map((e: any) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      items.find((e: any) => e.key === "agentic.architecture.order-read-path").confidence,
    ).not.toBe("conflicting");
    expect(keys.filter((k: string) => k.startsWith("agentic."))).toHaveLength(2);
    expect(r.out.conflicts).not.toContain("agentic.architecture.order-read-path");

    const withAssumption = structuredClone(first);
    withAssumption.assumptions = [
      { subject: "Cache", assumption: "In-memory", basis: "No config found", impact: "Not shared" },
    ];
    await submit(id, withAssumption);
    await submit(id, withAssumption);
    const state = await h.readJson(id, "session.json");
    const notAsked = state.assumptions.filter((a: any) => a.status === "not-asked");
    expect(notAsked.map((a: any) => a.questionId)).toEqual(["analysis-1"]);
  });

  it("drops a conflict that the next submission no longer reports", async () => {
    const id = await discovered(h);
    const conflicted = await analysisFixture("ts-monorepo-caching.json");
    conflicted.conflicts = [
      {
        subject: "Cache backend",
        observations: ["Redis", "Memcached"],
        sources: ["docs/cache.md", "src/cache.ts"],
        category: "architecture",
      },
    ];
    const first = await submit(id, conflicted);
    expect(first.out.conflicts).toContain("agentic.conflict.cache-backend");
    const gapsFirst = first.out.gaps.find((g: any) => g.requirement === "architecture");
    expect(gapsFirst.status).toBe("conflicting");

    const second = await submit(id, await analysisFixture("ts-monorepo-caching.json"));
    const keys = (await h.readJson(id, "evidence.json")).items.map((e: any) => e.key);
    expect(keys).not.toContain("agentic.conflict.cache-backend");
    expect(second.out.gaps.find((g: any) => g.requirement === "architecture").status).not.toBe(
      "conflicting",
    );
  });

  it("limits accepted submissions to four", async () => {
    const id = await discovered(h);
    const doc = await analysisFixture("minimal.json");
    for (let i = 0; i < 4; i++) expect((await submit(id, doc)).exitCode).toBe(0);
    const fifth = await submit(id, doc);
    expect(fifth.exitCode).toBe(1);
    expect(fifth.out.error).toBe("ANALYSIS_LIMIT");
    expect((await h.readJson(id, "session.json")).metrics.analysisSubmissions).toBe(4);
  });

  it("refuses a context request once the last analysis has been submitted", async () => {
    const id = await discovered(h);
    const doc = await analysisFixture("minimal.json");
    for (let i = 0; i < 4; i++) expect((await submit(id, doc)).exitCode).toBe(0);
    const before = await h.readJson(id, "session.json");
    const r = await ask(id, "README.md");
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("ANALYSIS_LIMIT");
    expect(await h.readJson(id, "session.json")).toEqual(before);
  });

  it("allows another request and another submit after a submit", async () => {
    const id = await discovered(h);
    await submit(id, await analysisFixture("minimal.json"));
    expect((await ask(id, "README.md")).exitCode).toBe(0);
    expect((await submit(id, await analysisFixture("minimal.json"))).exitCode).toBe(0);
  });
});
