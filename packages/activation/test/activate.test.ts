import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AssumptionsReportSchema,
  DiscoveryReportSchema,
  EvaluationReportSchema,
  MAX_BASE_FILE_BYTES,
  PerformanceReportSchema,
  SlaClock,
  type EvalResult,
  type EvaluationReport,
  type SessionState,
} from "@dynamic-skills/core";
import { parseSkillBundle } from "@dynamic-skills/skill-compiler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activate } from "../src/index";

const ROOT = resolve(import.meta.dirname, "../../..");
const NEW_SKILL = resolve(ROOT, "fixtures/skills/valid");
const AUG_SKILL = resolve(ROOT, "fixtures/skills/augmentation");
const BASE_SKILL = resolve(ROOT, "fixtures/skills/augmentation-base/order-caching/SKILL.md");
const NOW = 10_000;

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

function makeState(over: Partial<SessionState> = {}): SessionState {
  return {
    schemaVersion: "1",
    id: "ds-1",
    task: "t",
    mode: "auto",
    explicit: false,
    repo: "/r",
    revision: "x",
    status: "evaluating",
    createdAt: "2026-01-01T00:00:00.000Z",
    sla: SlaClock.start(60_000, 1_000).snapshot(1_000),
    completedSteps: [],
    clarification: { round: 0, asked: [], pending: [], answers: [] },
    assumptions: [],
    gaps: [],
    blockedBy: [],
    evalAttempts: 1,
    requirements: [],
    sufficiency: null,
    metrics: {
      wallStartedAt: 1_000,
      stageMs: { discovery: 5 },
      humanWaitMs: 0,
      llmInteractions: 0,
      parallelOps: 0,
      cacheHits: 0,
      cacheLookups: 0,
      evaluationMs: 0,
      activationMs: 0,
      contextRequests: 0,
      contextRequestRounds: 0,
      analysisSubmissions: 0,
      packetTokens: 0,
      analysisStartedAtActiveMs: null,
    },
    ...over,
  };
}

const report = (over: Partial<EvaluationReport> = {}): EvaluationReport => ({
  schemaVersion: "1",
  results: [],
  overall: "pass",
  activatable: true,
  limitations: [],
  revisionHints: [],
  durationMs: 3,
  parallelOps: 1,
  ...over,
});

const pass: EvalResult = {
  id: "behavioural",
  outcome: "pass",
  mandatory: true,
  messages: [],
  durationMs: 1,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "activation-"));
  await mkdir(join(dir, "reports"), { recursive: true });
  for (const f of ["evidence.json", "context-packet.json", "context-analysis.json"]) {
    await writeFile(join(dir, f), "{}");
  }
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function stageSkill(root: string) {
  await cp(root, join(dir, "skills"), { recursive: true });
  return parseSkillBundle(join(dir, "skills"));
}

async function stageBase(): Promise<string> {
  const p = join(dir, "base", "SKILL.md");
  await mkdir(join(dir, "base"), { recursive: true });
  await cp(BASE_SKILL, p);
  return p;
}

const readJson = async (rel: string): Promise<unknown> =>
  JSON.parse(await readFile(join(dir, rel), "utf8"));

function partial(path: string, sha256: string): SessionState["sufficiency"] {
  return {
    outcome: "partial",
    baseSkill: { name: "order-caching", path, sha256 },
    baseInstructionFile: null,
    approval: "not-required",
  };
}

describe("activate", () => {
  it("activates a new skill and writes every report", async () => {
    const skill = await stageSkill(NEW_SKILL);
    const state = makeState();
    const r = await activate({
      state,
      sessionDir: dir,
      skill,
      report: report(),
      behavioural: pass,
      packet: null,
      evidence: [],
      now: NOW,
    });
    expect(r).toMatchObject({
      activated: true,
      kind: "generated",
      skillPath: skill.skillMdPath,
      content: skill.raw,
      base: null,
      loadOrder: [skill.skillMdPath],
      limitations: [],
    });
    expect(r.activated && r.notice).toBe(
      "Apply the skill below to the current task. It is ephemeral and lives only in this session.",
    );
    expect(state.status).toBe("completed");
    expect(state.metrics.outcome).toBe("activated");
    expect(PerformanceReportSchema.parse(await readJson("reports/performance.json")).outcome).toBe(
      "activated",
    );
    expect(DiscoveryReportSchema.safeParse(await readJson("reports/discovery.json")).success).toBe(
      true,
    );
    const ev = EvaluationReportSchema.parse(await readJson("reports/evaluation.json"));
    expect(ev.behavioural).toEqual(pass);
    expect(AssumptionsReportSchema.parse(await readJson("reports/assumptions.json")).items).toEqual(
      [],
    );
  });

  it("activates an augmentation with the unchanged base and never touches the base", async () => {
    const skill = await stageSkill(AUG_SKILL);
    const basePath = await stageBase();
    const before = sha(await readFile(basePath));
    const state = makeState({ sufficiency: partial(basePath, before) });
    const r = await activate({
      state,
      sessionDir: dir,
      skill,
      report: report(),
      behavioural: pass,
      packet: null,
      evidence: [],
      now: NOW,
    });
    expect(r.activated && r.kind).toBe("augmented");
    if (!r.activated) throw new Error("expected activation");
    expect(r.base).toEqual({
      name: "order-caching",
      path: basePath,
      content: await readFile(basePath, "utf8"),
    });
    expect(r.loadOrder).toEqual([basePath, skill.skillMdPath]);
    expect(r.content).toBe(skill.raw);
    expect(r.notice).toBe(
      "Load the unchanged base skill first, then this augmentation, and apply both to the current task. The augmentation is ephemeral and lives only in this session.",
    );
    expect(state.metrics.outcome).toBe("augmented");
    expect(PerformanceReportSchema.parse(await readJson("reports/performance.json")).outcome).toBe(
      "augmented",
    );
    expect(sha(await readFile(basePath))).toBe(before);
  });

  it("refuses with base-changed when the base was edited, leaving it as edited", async () => {
    const skill = await stageSkill(AUG_SKILL);
    const basePath = await stageBase();
    const state = makeState({ sufficiency: partial(basePath, sha(await readFile(basePath))) });
    await writeFile(basePath, "edited after the verdict\n");
    const r = await activate({
      state,
      sessionDir: dir,
      skill,
      report: report(),
      behavioural: pass,
      packet: null,
      evidence: [],
      now: NOW,
    });
    expect(r).toMatchObject({
      activated: false,
      reason: "base-changed",
      fallback: "Continue the original task with existing capabilities.",
    });
    expect(await readFile(basePath, "utf8")).toBe("edited after the verdict\n");
    expect(state.status).toBe("failed");
    expect(state.metrics.outcome).toBe("failed");
  });

  it("refuses with base-changed when the base is gone", async () => {
    const skill = await stageSkill(AUG_SKILL);
    const basePath = join(dir, "base", "missing", "SKILL.md");
    const state = makeState({ sufficiency: partial(basePath, "0".repeat(64)) });
    const r = await activate({
      state,
      sessionDir: dir,
      skill,
      report: report(),
      behavioural: pass,
      packet: null,
      evidence: [],
      now: NOW,
    });
    expect(r).toMatchObject({ activated: false, reason: "base-changed" });
  });

  it("refuses with base-changed, without hanging, when the base became a FIFO", async () => {
    const skill = await stageSkill(AUG_SKILL);
    const basePath = join(dir, "base", "SKILL.md");
    await mkdir(join(dir, "base"), { recursive: true });
    execFileSync("mkfifo", [basePath]);
    const state = makeState({ sufficiency: partial(basePath, "0".repeat(64)) });
    const r = await activate({
      state,
      sessionDir: dir,
      skill,
      report: report(),
      behavioural: pass,
      packet: null,
      evidence: [],
      now: NOW,
    });
    expect(r).toMatchObject({ activated: false, reason: "base-changed" });
  }, 5_000);

  it("refuses with base-changed when the base grew past the size cap", async () => {
    const skill = await stageSkill(AUG_SKILL);
    const basePath = join(dir, "base", "SKILL.md");
    await mkdir(join(dir, "base"), { recursive: true });
    const big = "x".repeat(MAX_BASE_FILE_BYTES + 1);
    await writeFile(basePath, big);
    const state = makeState({ sufficiency: partial(basePath, sha(big)) });
    const r = await activate({
      state,
      sessionDir: dir,
      skill,
      report: report(),
      behavioural: pass,
      packet: null,
      evidence: [],
      now: NOW,
    });
    expect(r).toMatchObject({ activated: false, reason: "base-changed" });
  });

  it("returns warnings as limitations with status warning", async () => {
    const skill = await stageSkill(NEW_SKILL);
    const state = makeState();
    const r = await activate({
      state,
      sessionDir: dir,
      skill,
      report: report({ limitations: ["skill is long"] }),
      behavioural: pass,
      packet: null,
      evidence: [],
      now: NOW,
    });
    expect(r.activated && r.limitations).toEqual(["skill is long"]);
    expect(state.status).toBe("warning");
  });

  it("times out: removes skills, keeps context files, writes reports", async () => {
    const skill = await stageSkill(NEW_SKILL);
    const state = makeState();
    const r = await activate({
      state,
      sessionDir: dir,
      skill,
      report: report(),
      behavioural: pass,
      packet: null,
      evidence: [],
      now: 1_000 + 60_001,
    });
    expect(r).toMatchObject({ activated: false, reason: "timeout" });
    expect(await exists(join(dir, "skills"))).toBe(false);
    for (const f of ["evidence.json", "context-packet.json", "context-analysis.json"]) {
      expect(await exists(join(dir, f))).toBe(true);
    }
    expect(state.status).toBe("timeout");
    expect(PerformanceReportSchema.parse(await readJson("reports/performance.json")).outcome).toBe(
      "timeout",
    );
    expect(DiscoveryReportSchema.safeParse(await readJson("reports/discovery.json")).success).toBe(
      true,
    );
  });

  it("refuses when a clarification blocks activation", async () => {
    const skill = await stageSkill(NEW_SKILL);
    const r = await activate({
      state: makeState({ blockedBy: ["q1"] }),
      sessionDir: dir,
      skill,
      report: report(),
      behavioural: pass,
      packet: null,
      evidence: [],
      now: NOW,
    });
    expect(r).toMatchObject({ activated: false, reason: "blocked-by-clarification" });
  });

  it("refuses a failing report or failing behavioural result", async () => {
    const skill = await stageSkill(NEW_SKILL);
    const base = {
      sessionDir: dir,
      skill,
      packet: null,
      evidence: [],
      now: NOW,
    };
    const failing = await activate({
      ...base,
      state: makeState(),
      report: report({ activatable: false, overall: "fail" }),
      behavioural: pass,
    });
    expect(failing).toMatchObject({ activated: false, reason: "evaluation-failed" });
    const failedBehaviour = await activate({
      ...base,
      state: makeState(),
      report: report(),
      behavioural: { ...pass, outcome: "fail" },
    });
    expect(failedBehaviour).toMatchObject({ activated: false, reason: "evaluation-failed" });
    const noReport = await activate({
      ...base,
      state: makeState(),
      report: null,
      behavioural: pass,
    });
    expect(noReport).toMatchObject({ activated: false, reason: "evaluation-failed" });
  });

  it("refuses when the behavioural result is missing", async () => {
    const skill = await stageSkill(NEW_SKILL);
    const r = await activate({
      state: makeState(),
      sessionDir: dir,
      skill,
      report: report(),
      behavioural: undefined,
      packet: null,
      evidence: [],
      now: NOW,
    });
    expect(r).toMatchObject({ activated: false, reason: "behavioural-missing" });
  });

  it("writes nothing under the home directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "activation-home-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const skill = await stageSkill(NEW_SKILL);
      await activate({
        state: makeState(),
        sessionDir: dir,
        skill,
        report: report(),
        behavioural: pass,
        packet: null,
        evidence: [],
        now: NOW,
      });
      expect(homedir()).toBe(home);
      for (const rel of [".claude", ".agents", ".config/opencode"]) {
        expect(await exists(join(home, rel))).toBe(false);
      }
    } finally {
      process.env.HOME = saved;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("activate report writes", () => {
  it("refuses a symlinked reports directory and writes nothing through it", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "activation-elsewhere-"));
    try {
      await rm(join(dir, "reports"), { recursive: true });
      await symlink(elsewhere, join(dir, "reports"));
      await expect(
        activate({
          state: makeState(),
          sessionDir: dir,
          skill: null,
          report: null,
          behavioural: undefined,
          packet: null,
          evidence: [],
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "HOME_UNSAFE" });
      expect(await readdir(elsewhere)).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not leave performance.json behind when another report cannot be written", async () => {
    await mkdir(join(dir, "reports", "discovery.json"));
    await expect(
      activate({
        state: makeState(),
        sessionDir: dir,
        skill: null,
        report: null,
        behavioural: undefined,
        packet: null,
        evidence: [],
        now: NOW,
      }),
    ).rejects.toThrow();
    expect(await exists(join(dir, "reports", "performance.json"))).toBe(false);
  });

  it("leaves no temp file in reports after a normal activation refusal", async () => {
    await activate({
      state: makeState(),
      sessionDir: dir,
      skill: null,
      report: null,
      behavioural: undefined,
      packet: null,
      evidence: [],
      now: NOW,
    });
    const names = await readdir(join(dir, "reports"));
    expect(names.sort()).toEqual(["assumptions.json", "discovery.json", "performance.json"]);
  });
});
