import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AnswerSchema,
  AssumptionSchema,
  EvalIdSchema,
  EvidenceSchema,
  SmokeEvalSchema,
  generateSchemas,
} from "../src/index";

const validSmoke = {
  id: "s1",
  scenario: "User asks to add a test",
  expectedBehaviour: "Runs the test runner",
  requiredOutputs: ["pnpm test"],
  prohibited: ["npm test"],
  assertions: [{ type: "contains" as const, value: "pnpm" }],
  rubric: ["Uses pnpm"],
};

describe("schemas", () => {
  it("accepts a valid SmokeEval and rejects one without scenario", () => {
    expect(SmokeEvalSchema.parse(validSmoke)).toEqual(validSmoke);
    expect(() => SmokeEvalSchema.parse({ ...validSmoke, scenario: undefined })).toThrow();
  });
  it("caps SmokeEval lists at 50 entries", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `v${i}`);
    expect(SmokeEvalSchema.safeParse({ ...validSmoke, prohibited: fifty }).success).toBe(true);
    expect(SmokeEvalSchema.safeParse({ ...validSmoke, prohibited: [...fifty, "x"] }).success).toBe(
      false,
    );
    expect(
      SmokeEvalSchema.safeParse({ ...validSmoke, requiredOutputs: [...fifty, "x"] }).success,
    ).toBe(false);
    expect(SmokeEvalSchema.safeParse({ ...validSmoke, rubric: [...fifty, "x"] }).success).toBe(
      false,
    );
    const assertions = Array.from({ length: 51 }, () => ({
      type: "contains" as const,
      value: "a",
    }));
    expect(SmokeEvalSchema.safeParse({ ...validSmoke, assertions }).success).toBe(false);
  });
  it("rejects an unknown answer status", () =>
    expect(() => AnswerSchema.parse({ questionId: "q1", status: "maybe" })).toThrow());
  it("defaults evidence origin to programmatic", () => {
    const e = EvidenceSchema.parse({
      key: "k",
      value: "v",
      category: "build",
      source: "s",
      confidence: "verified",
      timestamp: "t",
      revision: "r",
      conflicts: [],
    });
    expect(e.origin).toBe("programmatic");
  });
  it("accepts assumption status not-asked", () =>
    expect(
      AssumptionSchema.parse({
        questionId: "q",
        question: "?",
        assumption: "a",
        basis: "b",
        impact: "i",
        status: "not-asked",
      }).status,
    ).toBe("not-asked"));
  it("lists evidence-classification right after role", () =>
    expect(EvalIdSchema.options.indexOf("evidence-classification")).toBe(
      EvalIdSchema.options.indexOf("role") + 1,
    ));
  it("committed schemas/ match generated schemas", () => {
    const schemasDir = new URL("../../../schemas/", import.meta.url);
    for (const [file, schema] of Object.entries(generateSchemas()))
      expect(JSON.parse(readFileSync(fileURLToPath(new URL(file, schemasDir)), "utf8"))).toEqual(
        schema,
      );
  });
});
