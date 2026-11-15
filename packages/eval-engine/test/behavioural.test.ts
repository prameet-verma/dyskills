import { describe, expect, it } from "vitest";
import type { EvalResult, EvaluationReport, SmokeEval } from "@dynamic-skills/core";
import { ASSERTION_REGEX_BUDGET_MS, isActivatable, recordBehaviouralResult } from "../src/index";

const SMOKE: SmokeEval = {
  id: "smoke-1",
  scenario: "s",
  expectedBehaviour: "e",
  requiredOutputs: [],
  prohibited: ["x"],
  assertions: [
    { type: "contains", value: "invalidat" },
    { type: "not-contains", value: "npm install -g" },
  ],
  rubric: [],
};

describe("recordBehaviouralResult", () => {
  it("passes when assertions hold and verdict is pass", async () => {
    const r = await recordBehaviouralResult(SMOKE, "invalidation plan for writes", "pass");
    expect(r).toMatchObject({ id: "behavioural", mandatory: true, outcome: "pass" });
  });
  it("fails naming a missing contains assertion", async () => {
    const r = await recordBehaviouralResult(SMOKE, "nothing relevant", "pass");
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("invalidat");
  });
  it("fails on a not-contains violation", async () => {
    const r = await recordBehaviouralResult(SMOKE, "invalidation; run npm install -g foo", "pass");
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("npm install -g");
  });
  it("fails when the verdict is fail, keeping notes", async () => {
    const r = await recordBehaviouralResult(SMOKE, "invalidation", "fail", "rubric missed");
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("rubric missed");
  });
  it("reports an invalid regex as a failed assertion", async () => {
    const smoke = { ...SMOKE, assertions: [{ type: "regex" as const, value: "(" }] };
    const r = await recordBehaviouralResult(smoke, "abc", "pass");
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toMatch(/invalid regular expression/);
  });
  it("rejects nested-quantifier and over-long patterns without running them", async () => {
    const evil = { ...SMOKE, assertions: [{ type: "not-regex" as const, value: "(a+)+$" }] };
    const start = Date.now();
    const r = await recordBehaviouralResult(evil, `${"a".repeat(50_000)}!`, "pass");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toMatch(/unsafe/);
    const long = { ...SMOKE, assertions: [{ type: "regex" as const, value: "a".repeat(201) }] };
    expect((await recordBehaviouralResult(long, "a", "pass")).messages.join("\n")).toMatch(
      /unsafe/,
    );
  });
  it("supports regex and not-regex", async () => {
    const smoke = {
      ...SMOKE,
      assertions: [
        { type: "regex" as const, value: "inval\\w+" },
        { type: "not-regex" as const, value: "^forbidden" },
      ],
    };
    expect((await recordBehaviouralResult(smoke, "invalidate", "pass")).outcome).toBe("pass");
    expect((await recordBehaviouralResult(smoke, "forbidden", "pass")).outcome).toBe("fail");
  });
  it("finds a prohibited string located past the output cap", async () => {
    const smoke = {
      ...SMOKE,
      assertions: [{ type: "not-contains" as const, value: "npm install -g" }],
    };
    const r = await recordBehaviouralResult(
      smoke,
      `${"a".repeat(150_000)}npm install -g x`,
      "pass",
    );
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("output contains it");
  });
  it("fails regex assertions without evaluating them when output exceeds the cap", async () => {
    const smoke = { ...SMOKE, assertions: [{ type: "not-regex" as const, value: "zzz" }] };
    const r = await recordBehaviouralResult(smoke, "a".repeat(100_001), "pass");
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain(
      "output exceeds 100,000 characters; regex not evaluated",
    );
  });
  it("sanitises assertion values and notes and caps nothing else away", async () => {
    const value = `line1\n\nline2 ${"x".repeat(500)}`;
    const smoke = { ...SMOKE, assertions: [{ type: "contains" as const, value }] };
    const r = await recordBehaviouralResult(smoke, "nope", "fail", `a\n\tb ${"n".repeat(500)}`);
    for (const m of r.messages) {
      expect(m).not.toMatch(/[\n\t]/);
      expect(m).toContain("…");
    }
    expect(r.messages[0]).toContain("line1 line2");
    expect(r.messages[0]?.length).toBeLessThan(300);
    expect(r.messages[1]?.length).toBeLessThan(260);
  });
});

describe("regex assertions are worker-bounded", () => {
  const run = async (value: string, text: string, type: "regex" | "not-regex" = "regex") => {
    const smoke = { ...SMOKE, assertions: [{ type, value }] };
    const start = Date.now();
    const r = await recordBehaviouralResult(smoke, text, "pass");
    return { r, ms: Date.now() - start };
  };
  it("rejects ^(a|a)*$ on a x30 + ! quickly", async () => {
    const { r, ms } = await run("^(a|a)*$", `${"a".repeat(30)}!`);
    expect(ms).toBeLessThan(2000);
    expect(r.outcome).toBe("fail");
  });
  it("rejects (\\w|\\d)*$ on 1 x29 + ! quickly", async () => {
    const { r, ms } = await run("(\\w|\\d)*$", `${"1".repeat(29)}!`);
    expect(ms).toBeLessThan(2000);
    expect(r.outcome).toBe("fail");
  });
  it("times out \\s*\\s*x on 100k spaces within the budget", async () => {
    const { r, ms } = await run("\\s*\\s*x", " ".repeat(100_000));
    expect(ms).toBeLessThan(2000);
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("regex evaluation timed out");
  });
  it("times out a group-free pattern and fails every unevaluated assertion", async () => {
    const smoke = {
      ...SMOKE,
      assertions: [
        { type: "regex" as const, value: "ok" },
        { type: "not-regex" as const, value: "a*a*a*b" },
        { type: "regex" as const, value: "never" },
      ],
    };
    const start = Date.now();
    const r = await recordBehaviouralResult(smoke, `ok${"a".repeat(5_000)}`, "pass");
    expect(Date.now() - start).toBeLessThan(ASSERTION_REGEX_BUDGET_MS + 1500);
    expect(r.messages).toHaveLength(2);
    expect(r.messages.every((m) => m.includes("timed out"))).toBe(true);
  });
  it("rejects quantified groups with alternation or a ? quantifier inside", async () => {
    expect((await run("(a|b)+", "a")).r.messages.join()).toMatch(/unsafe/);
    expect((await run("(a?)+", "a")).r.messages.join()).toMatch(/unsafe/);
    expect((await run("(?:ab)c", "abc")).r.outcome).toBe("pass");
  });
});

describe("isActivatable", () => {
  const report = { activatable: true } as EvaluationReport;
  const mk = (outcome: EvalResult["outcome"]): EvalResult => ({
    id: "behavioural",
    outcome,
    mandatory: true,
    messages: [],
    durationMs: 0,
  });
  it("requires a behavioural result", () => {
    expect(isActivatable(report, undefined)).toBe(false);
    expect(isActivatable(report, mk("fail"))).toBe(false);
    expect(isActivatable(report, mk("pass"))).toBe(true);
    expect(isActivatable(report, mk("warning"))).toBe(true);
    expect(isActivatable({ ...report, activatable: false }, mk("pass"))).toBe(false);
  });
});
