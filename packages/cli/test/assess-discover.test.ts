/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { ContextPacketSchema, SkillsScanSchema } from "@dynamic-skills/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHING_TASK, assess, discovered, harness, hashTree } from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

describe("assess", () => {
  it("creates a session, scans skills and recommends discover", async () => {
    await h.installBase();
    const r = await h.run(["assess", "--task", CACHING_TASK]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatchObject({ ok: true, schemaVersion: "1", recommendation: "discover" });
    expect(r.out.sessionId).toMatch(/^ds-\d{14}-[0-9a-f]{6}$/);
    // PRD §5.5: a matching skill is a hint, not an early exit.
    expect(r.out.candidates[0].name).toBe("order-caching");
    expect(r.out.skills).toEqual([
      expect.objectContaining({ name: "order-caching", scope: "personal" }),
    ]);
    expect(r.stderr).toContain("Dynamic Skills");

    const scan = SkillsScanSchema.parse(await h.readJson(r.out.sessionId, "skills-scan.json"));
    expect(scan.skills.map((s) => s.name)).toEqual(["order-caching"]);
    expect(scan.skills[0]?.path).toBe(r.out.skills[0].path);
    const state = await h.readJson(r.out.sessionId, "session.json");
    expect(state.completedSteps).toEqual(["assess"]);
    expect(state.status).toBe("assessing");
  });

  it("stores instruction files repo-relative and resolves --repo to an absolute path", async () => {
    await readFile(h.repo + "/README.md"); // fixture sanity
    const { writeFile } = await import("node:fs/promises");
    await writeFile(h.repo + "/AGENTS.md", "# Agents\n");
    const r = await h.run(["assess", "--task", CACHING_TASK, "--repo", "../repo"]);
    expect(r.out.instructionFiles).toEqual(["AGENTS.md"]);
    const state = await h.readJson(r.out.sessionId, "session.json");
    expect(state.repo).toBe(h.repo);
    expect(relative(h.repo, state.repo)).toBe("");
  });

  it("never lists the bootstrap skill", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = h.userHome + "/.agents/skills/dynamic-skill-bootstrap";
    await mkdir(dir, { recursive: true });
    await writeFile(
      dir + "/SKILL.md",
      "---\nname: dynamic-skill-bootstrap\ndescription: caching orders bootstrap\n---\nbody\n",
    );
    const r = await h.run(["assess", "--task", CACHING_TASK]);
    expect(r.out.skills).toEqual([]);
    expect(r.out.candidates).toEqual([]);
  });

  it("manual mode without --explicit recommends none, ends the session and blocks discover", async () => {
    const r = await h.run(["assess", "--task", CACHING_TASK, "--mode", "manual"]);
    expect(r.exitCode).toBe(0);
    expect(r.out.recommendation).toBe("none");
    const id = r.out.sessionId as string;
    const state = await h.readJson(id, "session.json");
    expect(state).toMatchObject({ status: "completed" });
    expect(state.metrics.outcome).toBe("skipped");
    expect((await h.readJson(id, "reports/performance.json")).outcome).toBe("skipped");
    const next = await h.run(["discover", "--session", id]);
    expect(next.exitCode).toBe(1);
    expect(next.out.error).toBe("INVALID_STATE");
  });

  it("manual mode with --explicit continues", async () => {
    const r = await h.run(["assess", "--task", CACHING_TASK, "--mode", "manual", "--explicit"]);
    expect(r.out.recommendation).toBe("discover");
  });

  it("rejects a bad --repo, --mode and budget without leaving a session behind", async () => {
    const repo = await h.run(["assess", "--task", "x", "--repo", "/definitely/not/here"]);
    expect(repo.exitCode).toBe(1);
    expect(repo.out.error).toBe("USAGE");
    const mode = await h.run(["assess", "--task", "x", "--mode", "weird"]);
    expect(mode.out.error).toBe("USAGE");
    process.env.DYNAMIC_SKILLS_BUDGET_MS = "abc";
    try {
      const budget = await h.run(["assess", "--task", "x"]);
      expect(budget.out.error).toBe("USAGE");
    } finally {
      delete process.env.DYNAMIC_SKILLS_BUDGET_MS;
    }
    expect(await hashTree(h.home + "/sessions")).toEqual({});
  });

  it("honours DYNAMIC_SKILLS_BUDGET_MS", async () => {
    process.env.DYNAMIC_SKILLS_BUDGET_MS = "5000";
    try {
      const id = await assess(h);
      expect((await h.readJson(id, "session.json")).sla.budgetMs).toBe(5000);
    } finally {
      delete process.env.DYNAMIC_SKILLS_BUDGET_MS;
    }
  });
});

describe("discover", () => {
  it("builds evidence, gaps, the packet and the agent schemas", async () => {
    const id = await assess(h);
    const before = await hashTree(h.repo);
    const r = await h.run(["discover", "--session", id]);
    expect(r.exitCode).toBe(0);
    expect(r.out.ok).toBe(true);
    expect(r.out.schemaVersion).toBe("1");
    expect(r.out.evidenceCount).toBeGreaterThan(5);
    expect(r.out.packetRevision).toBe(1);
    expect(r.out.gaps.find((g: any) => g.requirement === "architecture")).toMatchObject({
      status: "verified",
    });
    expect(r.out.gaps.find((g: any) => g.requirement === "testing")).toMatchObject({
      resolution: "inspect",
    });

    const raw = await h.read(id, "context-packet.json");
    const packet = ContextPacketSchema.parse(JSON.parse(raw));
    expect(packet.relevantFiles.map((f) => f.path)).toContain("packages/orders/src/index.ts");
    expect(raw).not.toContain("FAKE_SECRET_VALUE_123");
    expect(raw).not.toContain("harness");
    expect(r.out.packetTokens).toBe(packet.size.estimatedTokens);

    for (const key of [
      "analysis",
      "request",
      "sufficiency",
      "clarificationRequest",
      "clarificationResponse",
      "smokeEval",
    ]) {
      const schema = JSON.parse(await readFile(r.out.schemaPaths[key], "utf8"));
      expect(schema.$id).toMatch(/^dynamic-skills\/v1\//);
    }
    const evidence = await h.readJson(id, "evidence.json");
    expect(evidence.schemaVersion).toBe("1");
    expect(evidence.items).toHaveLength(r.out.evidenceCount);

    const state = await h.readJson(id, "session.json");
    expect(state.completedSteps).toEqual(["assess", "discover"]);
    expect(state.requirements.length).toBeGreaterThan(0);
    expect(state.metrics.packetTokens).toBe(packet.size.estimatedTokens);
    expect(state.metrics.parallelOps).toBeGreaterThan(0);
    expect(state.metrics.analysisStartedAtActiveMs).not.toBeNull();
    // Discovery only reads the repository.
    expect(await hashTree(h.repo)).toEqual(before);
  });

  it("rejects a second discover", async () => {
    const id = await discovered(h);
    const r = await h.run(["discover", "--session", id]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatchObject({ error: "INVALID_STATE", expected: ["assess"] });
  });

  it("writes only inside the session directory", async () => {
    const userBefore = await hashTree(h.userHome);
    const repoBefore = await hashTree(h.repo);
    await discovered(h);
    expect(await hashTree(h.userHome)).toEqual(userBefore);
    expect(await hashTree(h.repo)).toEqual(repoBefore);
  });
});
