import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnswerSchema, SmokeEvalSchema } from "../src/index.js";
import { generateSchemas } from "../../../scripts/gen-schemas.js";

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
  it("rejects an unknown answer status", () =>
    expect(() => AnswerSchema.parse({ questionId: "q1", status: "maybe" })).toThrow());
  it("committed schemas/ match generated schemas", () => {
    for (const [file, schema] of Object.entries(generateSchemas()))
      expect(JSON.parse(readFileSync(`schemas/${file}`, "utf8"))).toEqual(schema);
  });
});
