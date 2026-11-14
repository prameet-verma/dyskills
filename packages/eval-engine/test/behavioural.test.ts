import { describe, expect, it } from "vitest";
import type { EvalResult, EvaluationReport, SmokeEval } from "@dynamic-skills/core";
import { isActivatable, recordBehaviouralResult } from "../src/index";

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
  it("passes when assertions hold and verdict is pass", () => {
    const r = recordBehaviouralResult(SMOKE, "invalidation plan for writes", "pass");
    expect(r).toMatchObject({ id: "behavioural", mandatory: true, outcome: "pass" });
  });
  it("fails naming a missing contains assertion", () => {
    const r = recordBehaviouralResult(SMOKE, "nothing relevant", "pass");
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("invalidat");
  });
  it("fails on a not-contains violation", () => {
    const r = recordBehaviouralResult(SMOKE, "invalidation; run npm install -g foo", "pass");
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("npm install -g");
  });
  it("fails when the verdict is fail, keeping notes", () => {
    const r = recordBehaviouralResult(SMOKE, "invalidation", "fail", "rubric missed");
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("rubric missed");
  });
  it("reports an invalid regex as a failed assertion", () => {
    const smoke = { ...SMOKE, assertions: [{ type: "regex" as const, value: "(" }] };
    const r = recordBehaviouralResult(smoke, "abc", "pass");
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toMatch(/invalid regular expression/);
  });
  it("rejects nested-quantifier and over-long patterns without running them", () => {
    const evil = { ...SMOKE, assertions: [{ type: "not-regex" as const, value: "(a+)+$" }] };
    const start = Date.now();
    const r = recordBehaviouralResult(evil, `${"a".repeat(50_000)}!`, "pass");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toMatch(/unsafe/);
    const long = { ...SMOKE, assertions: [{ type: "regex" as const, value: "a".repeat(201) }] };
    expect(recordBehaviouralResult(long, "a", "pass").messages.join("\n")).toMatch(/unsafe/);
  });
  it("supports regex and not-regex", () => {
    const smoke = {
      ...SMOKE,
      assertions: [
        { type: "regex" as const, value: "inval\\w+" },
        { type: "not-regex" as const, value: "^forbidden" },
      ],
    };
    expect(recordBehaviouralResult(smoke, "invalidate", "pass").outcome).toBe("pass");
    expect(recordBehaviouralResult(smoke, "forbidden", "pass").outcome).toBe("fail");
  });
  it("caps the output it inspects at 100,000 characters", () => {
    const smoke = { ...SMOKE, assertions: [{ type: "contains" as const, value: "TAIL" }] };
    const r = recordBehaviouralResult(smoke, `${"a".repeat(100_000)}TAIL`, "pass");
    expect(r.outcome).toBe("fail");
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
