/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SufficiencyReportSchema } from "@dynamic-skills/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysed, discovered, harness, hashTree, verdict } from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
let userBefore: Record<string, string> | undefined;
beforeEach(async () => {
  userBefore = undefined;
  h = await harness();
});
afterEach(async () => {
  // Skills and instruction files are only ever read.
  if (userBefore) expect(await hashTree(h.userHome)).toEqual(userBefore);
  await h.cleanup();
});

/** Installs the base skill, records the user-home hashes and returns the scanned path. */
async function withBase(): Promise<string> {
  const path = await h.installBase();
  userBefore = await hashTree(h.userHome);
  return path;
}

async function submit(id: string, doc: unknown) {
  const file = await h.doc("verdict.json", doc);
  return h.run(["sufficiency", "submit", "--session", id, "--file", file]);
}

/** The scanned path of the base skill, read from the session's scan. */
async function scannedPath(id: string): Promise<string> {
  return (await h.readJson(id, "skills-scan.json")).skills[0].path;
}

describe("sufficiency state rules", () => {
  it("is not allowed straight after discover", async () => {
    await withBase();
    const id = await discovered(h);
    const r = await submit(id, verdict({ outcome: "insufficient" }));
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatchObject({ error: "INVALID_STATE", expected: ["context-submit"] });
  });

  it("is required before clarify ask and compile", async () => {
    await withBase();
    const id = await analysed(h);
    const q = await h.doc("q.json", { schemaVersion: "1", questions: [] });
    const ask = await h.run(["clarify", "ask", "--session", id, "--file", q]);
    expect(ask.out).toMatchObject({ error: "INVALID_STATE", expected: ["sufficiency-submit"] });
  });

  it("accepts one verdict only", async () => {
    await withBase();
    const id = await analysed(h);
    const base = await scannedPath(id);
    const doc = verdict({
      outcome: "partial",
      baseSkill: { name: "order-caching", path: base },
      missingAspects: ["Invalidation on update"],
    });
    expect((await submit(id, doc)).exitCode).toBe(0);
    const again = await submit(id, doc);
    expect(again.exitCode).toBe(1);
    expect(again.out.error).toBe("INVALID_STATE");
  });
});

describe("sufficiency validation", () => {
  it("rejects a partial verdict naming a different directory with VERDICT_INVALID at baseSkill", async () => {
    await withBase();
    const id = await analysed(h);
    const base = await scannedPath(id);
    const r = await submit(
      id,
      verdict({
        outcome: "partial",
        baseSkill: { name: "order-caching", path: base.replace("order-caching", "elsewhere") },
        missingAspects: ["x"],
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("VERDICT_INVALID");
    expect(r.out.issues.map((i: any) => i.path)).toContain("baseSkill");
    expect(await h.exists(id, "sufficiency.json")).toBe(false);
    expect((await h.readJson(id, "session.json")).sufficiency).toBeNull();
  });

  it("rejects a relative or dotted spelling of the scanned path", async () => {
    await withBase();
    const id = await analysed(h);
    const base = await scannedPath(id);
    const r = await submit(
      id,
      verdict({
        outcome: "partial",
        baseSkill: { name: "order-caching", path: `${dirname(base)}/../order-caching/SKILL.md` },
        missingAspects: ["x"],
      }),
    );
    expect(r.out.error).toBe("VERDICT_INVALID");
  });

  it("rejects partial with no missing aspects as SCHEMA_INVALID", async () => {
    await withBase();
    const id = await analysed(h);
    const base = await scannedPath(id);
    const r = await submit(
      id,
      verdict({ outcome: "partial", baseSkill: { name: "order-caching", path: base } }),
    );
    expect(r.out.error).toBe("SCHEMA_INVALID");
  });

  it("rejects sufficient for an explicit session at outcome", async () => {
    const base = await withBase();
    const id = await analysed(h, undefined, ["--explicit"]);
    const r = await submit(
      id,
      verdict({ outcome: "sufficient", baseSkill: { name: "order-caching", path: base } }),
    );
    expect(r.out.error).toBe("VERDICT_INVALID");
    expect(r.out.issues.map((i: any) => i.path)).toContain("outcome");
  });

  it("rejects a scanned skill whose frontmatter name is ../evil", async () => {
    const dir = join(h.userHome, ".agents/skills/evil");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: ../evil\ndescription: Evil caching skill\n---\nbody\n",
    );
    userBefore = await hashTree(h.userHome);
    const id = await analysed(h);
    const scan = await h.readJson(id, "skills-scan.json");
    expect(scan.skills[0].name).toBe("../evil");
    const r = await submit(
      id,
      verdict({
        outcome: "partial",
        baseSkill: { name: "../evil", path: scan.skills[0].path },
        missingAspects: ["x"],
      }),
    );
    expect(r.out.error).toBe("SCHEMA_INVALID");
    expect(await hashTree(h.home + "/sessions")).not.toHaveProperty("../evil");
    expect(await h.exists(id, "sufficiency.json")).toBe(false);
  });
});

describe("sufficient verdicts", () => {
  it("reuses a repository instruction file unchanged", async () => {
    await writeFile(join(h.repo, "AGENTS.md"), "# Agents\nUse pnpm.\n");
    const id = await analysed(h);
    const r = await submit(
      id,
      verdict({ outcome: "sufficient", baseInstructionFile: "AGENTS.md" }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.out.outcome).toBe("sufficient");
    expect(r.out.reused.content).toBe("# Agents\nUse pnpm.\n");
    expect(r.out.reused.notice).toContain("unchanged");
    expect(r.out.next).toBe("done");
    expect((await h.readJson(id, "session.json")).metrics.outcome).toBe("reused");
    expect(await readFile(join(h.repo, "AGENTS.md"), "utf8")).toBe("# Agents\nUse pnpm.\n");
  });

  it("reuses a scanned skill, completes the session and blocks compile", async () => {
    const base = await withBase();
    const id = await analysed(h);
    const r = await submit(
      id,
      verdict({
        outcome: "sufficient",
        baseSkill: { name: "order-caching", path: await scannedPath(id) },
        coveredAspects: ["Keys", "TTLs"],
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.out.reused.content).toBe(await readFile(base, "utf8"));
    expect(r.out.reused.path).toBe(base);
    const state = await h.readJson(id, "session.json");
    expect(state.status).toBe("completed");
    expect(state.completedSteps.at(-1)).toBe("sufficiency-submit");
    expect((await h.readJson(id, "reports/performance.json")).outcome).toBe("reused");
    expect(await h.exists(id, "reports/discovery.json")).toBe(true);
    SufficiencyReportSchema.parse(await h.readJson(id, "reports/sufficiency.json"));
    expect(await h.exists(id, "brief.md")).toBe(false);
    expect(await h.exists(id, "skills")).toBe(false);

    // compile is a Task 16 command; the state machine already refuses it on a finished session.
    const { assertCanRun } = await import("../src/state-machine");
    const { SessionStore } = await import("@dynamic-skills/core");
    const loaded = await new SessionStore(h.home).load(id);
    expect(() => assertCanRun(loaded, "compile")).toThrowError(
      expect.objectContaining({ code: "INVALID_STATE", extra: { expected: [] } }),
    );
    const next = await h.run(["clarify", "ask", "--session", id, "--file", "x.json"]);
    expect(next.out).toMatchObject({ error: "INVALID_STATE", expected: [] });
  });

  it("refuses a base that resolves to a non-SKILL.md file", async () => {
    const base = await withBase();
    const secret = join(h.userHome, "secret.txt");
    await writeFile(secret, "TOP SECRET");
    userBefore = await hashTree(h.userHome);
    const id = await analysed(h);
    // Swap the scanned SKILL.md for a symlink after the scan, as an attacker could.
    const { rm } = await import("node:fs/promises");
    await rm(base);
    await symlink(secret, base);
    const r = await submit(
      id,
      verdict({
        outcome: "sufficient",
        baseSkill: { name: "order-caching", path: await scannedPath(id) },
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("VERDICT_INVALID");
    expect(JSON.stringify(r.out)).not.toContain("TOP SECRET");
    expect(r.stderr).not.toContain("TOP SECRET");
    expect(await readFile(secret, "utf8")).toBe("TOP SECRET");
    userBefore = undefined; // this test rewrites the skill file itself
  });

  it("refuses an instruction file that is a symlink to a secret", async () => {
    await writeFile(join(h.repo, "real.txt"), "x");
    await symlink(join(h.repo, ".env"), join(h.repo, "AGENTS.md"));
    const id = await analysed(h);
    const r = await submit(
      id,
      verdict({ outcome: "sufficient", baseInstructionFile: "AGENTS.md" }),
    );
    expect(r.out.error).toBe("VERDICT_INVALID");
    expect(JSON.stringify(r.out)).not.toContain("FAKE_SECRET_VALUE_123");
  });

  it("fails clearly when the base exceeds the size cap", async () => {
    await writeFile(join(h.repo, "AGENTS.md"), "a".repeat(250_000));
    const id = await analysed(h);
    const r = await submit(
      id,
      verdict({ outcome: "sufficient", baseInstructionFile: "AGENTS.md" }),
    );
    expect(r.out.error).toBe("VERDICT_INVALID");
    expect(r.out.issues[0].message).toContain("exceeds");
  });
});

describe("partial and insufficient verdicts", () => {
  it("records a partial verdict in auto mode with the scanned path and base hash", async () => {
    const base = await withBase();
    const id = await analysed(h);
    const r = await submit(
      id,
      verdict({
        outcome: "partial",
        baseSkill: { name: "order-caching", path: await scannedPath(id) },
        missingAspects: ["Invalidation on update"],
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatchObject({
      outcome: "partial",
      approval: "not-required",
      next: "clarify-or-compile",
      reused: null,
    });
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256")
      .update(await readFile(base))
      .digest("hex");
    const state = await h.readJson(id, "session.json");
    expect(state.sufficiency.baseSkill).toEqual({ name: "order-caching", path: base, sha256: sha });
    expect(state.status).not.toBe("completed");
    expect(state.metrics.llmInteractions).toBe(2);
    const report = SufficiencyReportSchema.parse(await h.readJson(id, "reports/sufficiency.json"));
    expect(report).toMatchObject({ mode: "auto", explicit: false, approval: "not-required" });
    expect((await h.readJson(id, "sufficiency.json")).outcome).toBe("partial");
  });
});

describe("suggest mode approval", () => {
  const insufficient = verdict({ outcome: "insufficient" });

  it("pauses the SLA, blocks the pipeline and resumes on approve", async () => {
    await withBase();
    const id = await analysed(h, undefined, ["--mode", "suggest"]);
    const r = await submit(id, insufficient);
    expect(r.out).toMatchObject({ approval: "pending", next: "approve" });
    expect(r.stderr).toContain("Status: Waiting for approval");
    expect(r.stderr).toContain("Processing SLA: PAUSED");
    const state = await h.readJson(id, "session.json");
    expect(state.status).toBe("waiting-for-approval");
    expect(state.sla.paused).toBe(true);

    const q = await h.doc("q.json", { schemaVersion: "1", questions: [] });
    const blocked = await h.run(["clarify", "ask", "--session", id, "--file", q]);
    expect(blocked.out).toMatchObject({
      error: "INVALID_STATE",
      expected: ["sufficiency-approve"],
    });

    h.clock.t += 30_000;
    const ok = await h.run(["sufficiency", "approve", "--session", id, "--decision", "approve"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.out).toMatchObject({ approval: "approved", fallback: null });
    expect(ok.stderr).toContain("Processing SLA: RESUMED");
    const after = await h.readJson(id, "session.json");
    expect(after.metrics.humanWaitMs).toBe(30_000);
    expect(after.status).toBe("resuming");
    expect(after.sla.paused).toBe(false);
    expect(after.completedSteps.at(-1)).toBe("sufficiency-approve");
    expect((await h.readJson(id, "reports/sufficiency.json")).approval).toBe("approved");
    // Clarification is allowed again after approval.
    const asked = await h.run(["clarify", "ask", "--session", id, "--file", q]);
    expect(asked.out.error).not.toBe("INVALID_STATE");
  });

  it("ends the session as skipped on decline", async () => {
    const id = await analysed(h, undefined, ["--mode", "suggest"]);
    await submit(id, insufficient);
    const r = await h.run(["sufficiency", "approve", "--session", id, "--decision", "decline"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatchObject({
      approval: "declined",
      fallback: "Continue the original task with existing capabilities.",
    });
    const state = await h.readJson(id, "session.json");
    expect(state).toMatchObject({ status: "completed" });
    expect(state.metrics.outcome).toBe("skipped");
    expect((await h.readJson(id, "reports/sufficiency.json")).approval).toBe("declined");
    expect((await h.readJson(id, "reports/performance.json")).outcome).toBe("skipped");
  });

  it("rejects approve when nothing is pending and a bad decision", async () => {
    const id = await analysed(h);
    await submit(id, insufficient);
    const none = await h.run(["sufficiency", "approve", "--session", id, "--decision", "approve"]);
    expect(none.out.error).toBe("INVALID_STATE");
    const bad = await h.run(["sufficiency", "approve", "--session", id, "--decision", "maybe"]);
    expect(bad.out.error).toBe("USAGE");
  });

  it("requires no approval in auto mode or for sufficient verdicts", async () => {
    const id = await analysed(h);
    expect((await submit(id, insufficient)).out.approval).toBe("not-required");
  });
});
