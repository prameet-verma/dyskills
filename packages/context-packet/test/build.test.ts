import { basename } from "node:path";
import { ContextPacketSchema, DISCOVERY_CONCURRENCY, type SkillsScan } from "@dynamic-skills/core";
import { ALL_DETECTORS, buildFileIndex } from "@dynamic-skills/discovery";
import { describe, expect, it } from "vitest";
import { buildContextPacket, SECRET_POLICY } from "../src/index";
import { buildFor, CACHING_TASK, EMPTY_SCAN, fixture, put, tmpRepo } from "./helpers";

const TS = fixture("ts-monorepo");

describe("buildContextPacket", () => {
  it("builds a schema-valid packet with the probe file excerpt", async () => {
    const p = await buildFor(TS, CACHING_TASK);
    expect(ContextPacketSchema.parse(p)).toEqual(p);
    expect(p).toMatchObject({
      packetRevision: 1,
      trust: "untrusted",
      repository: { identity: basename(TS) },
    });
    expect(p.relevantFiles.map((f) => f.path)).toEqual([
      "package.json",
      "packages/orders/src/index.ts",
    ]);
    expect(
      p.relevantFiles.find((f) => f.path === "packages/orders/src/index.ts")?.excerpt,
    ).toContain("getOrder");
    expect(p.technology).toMatchObject({ packageManagers: ["pnpm"] });
    expect(p.technology.runtimes).toContain("node 20.11.0");
    expect(p.configuration).toEqual(
      expect.arrayContaining([
        { path: "nx.json", kind: "monorepo" },
        { path: ".github/workflows/ci.yml", kind: "ci" },
      ]),
    );
    expect(p.dependencies.some((d) => d.name === "react")).toBe(true);
  });

  it("contains no secrets and no harness identifiers", async () => {
    const repo = await tmpRepo();
    await put(repo, ".claude/skills/x/SKILL.md", "---\nname: x\ndescription: d\n---\nbody");
    await put(repo, "packages/orders/src/index.ts", "export const k = 'FAKE_SECRET_VALUE_123';\n");
    await put(repo, ".env", "TOKEN=FAKE_SECRET_VALUE_123");
    const scan: SkillsScan = {
      ...EMPTY_SCAN,
      skills: [
        {
          name: "x",
          description: "d",
          scope: "project",
          path: `${repo}/.claude/skills/x/SKILL.md`,
        },
      ],
    };
    const p = await buildFor(repo, CACHING_TASK, { scan });
    const json = JSON.stringify(p);
    expect(json).not.toContain('.env"');
    expect(json).not.toContain('"harness"');
    expect(json).not.toContain(".claude/");
    expect(p.existingSkills).toEqual([{ name: "x", description: "d", scope: "project" }]);
    // The secret file itself is never read into an excerpt.
    expect(p.relevantFiles.every((f) => !f.path.includes(".env"))).toBe(true);
  });

  it("reads project instruction files through the sanitiser", async () => {
    const repo = await tmpRepo();
    await put(repo, "AGENTS.md", `rules ghp_${"a".repeat(36)} ok`);
    const p = await buildFor(repo, CACHING_TASK, {
      scan: { ...EMPTY_SCAN, instructionFiles: ["AGENTS.md", "missing.md"] },
    });
    expect(p.projectInstructions).toEqual([
      { path: "AGENTS.md", excerpt: "rules [REDACTED] ok", truncated: false },
    ]);
  });

  it("stays within the token budget by dropping low-priority excerpts", async () => {
    const repo = await tmpRepo();
    const names = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    for (const n of names) await put(repo, n, "y".repeat(40_000));
    const files = await buildFileIndex(repo);
    const p = await buildContextPacket({
      task: "t",
      repo,
      revision: "r",
      evidence: [],
      files,
      gaps: [],
      probes: [{ requirement: "architecture", question: "q", suggestedFiles: names }],
      scan: EMPTY_SCAN,
      detectorsRun: [],
      detectorErrors: [],
      budgetTokens: 4_000,
    });
    expect(p.size.estimatedTokens).toBeLessThanOrEqual(4_000);
    expect(p.limitations.excerptsDropped[0]).toBe("e.ts");
    for (const f of p.relevantFiles)
      if (f.excerpt) expect(f.excerpt.length).toBeLessThanOrEqual(6_000);
    expect(p.relevantFiles.find((f) => f.path === "e.ts")).toMatchObject({ truncated: true });
  });

  it("terminates when evidence alone exceeds the budget", async () => {
    const repo = await tmpRepo();
    const p = await buildFor(repo, CACHING_TASK, { budgetTokens: 1 });
    expect(p.relevantFiles.every((f) => f.excerpt === undefined)).toBe(true);
    expect(p.limitations.excerptsDropped.at(-1)).toBe("<all excerpts dropped>");
  });

  it("reads relevant files with bounded concurrency", async () => {
    const repo = await tmpRepo();
    const names = Array.from({ length: 8 }, (_, i) => `f${i}.ts`);
    let inFlight = 0;
    let max = 0;
    const readFile = async (): Promise<string | null> => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return "x";
    };
    const files = await buildFileIndex(repo);
    const p = await buildContextPacket({
      task: "t",
      repo,
      revision: "r",
      evidence: [],
      files,
      gaps: [],
      probes: [{ requirement: "architecture", question: "q", suggestedFiles: names }],
      scan: EMPTY_SCAN,
      detectorsRun: [],
      detectorErrors: [],
      readFile,
    });
    expect(p.relevantFiles).toHaveLength(8);
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(DISCOVERY_CONCURRENCY);
  });

  it("reports limitations", async () => {
    const p = await buildFor(TS, CACHING_TASK);
    expect(p.limitations.secretPolicy).toBe(SECRET_POLICY);
    expect(p.limitations.detectorsNotRun).toContain("database");
    expect(p.limitations.detectorsNotRun.length).toBeLessThan(ALL_DETECTORS.length);
    expect(p.limitations.skippedDirs).toContain("node_modules");
    expect(p.limitations.excerptsDropped).toEqual([]);
    expect(p.limitations.filesIndexed).toBeGreaterThan(0);
  });
});
