import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  ClarificationRequestSchema,
  SessionState,
  SessionStateSchema,
  SessionStore,
  generateSchemas,
} from "../src/index";

const q = {
  id: "r1-q1",
  text: "Which cache backend?",
  requirement: "cache-backend",
  material: true,
  blocking: false,
};
const req = (extra: object) => ({ schemaVersion: "1", questions: [{ ...q, ...extra }] });

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("question options", () => {
  it("accepts options and multiSelect", () =>
    expect(
      ClarificationRequestSchema.parse(
        req({
          options: [
            { label: "Redis", description: "Shared" },
            { label: "In-process", description: "Per pod" },
          ],
          multiSelect: false,
        }),
      ).questions[0]!.options,
    ).toHaveLength(2));

  it("keeps Phase 1 text-only requests valid", () =>
    expect(ClarificationRequestSchema.parse(req({}))).toEqual(req({})));

  it("accepts multiSelect with options", () =>
    expect(
      ClarificationRequestSchema.safeParse(
        req({
          multiSelect: true,
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        }),
      ).success,
    ).toBe(true));

  it("accepts exactly four options", () =>
    expect(
      ClarificationRequestSchema.safeParse(
        req({ options: ["A", "B", "C", "D"].map((label) => ({ label, description: "" })) }),
      ).success,
    ).toBe(true));

  it("accepts multiSelect false without options", () =>
    expect(ClarificationRequestSchema.safeParse(req({ multiSelect: false })).success).toBe(true));

  it.each([
    [
      "blank label",
      {
        options: [
          { label: "   ", description: "" },
          { label: "B", description: "" },
        ],
      },
    ],
    [
      "multi-line label",
      {
        options: [
          { label: "a\nb", description: "" },
          { label: "B", description: "" },
        ],
      },
    ],
    ["one option", { options: [{ label: "A", description: "" }] }],
    [
      "five options",
      { options: ["A", "B", "C", "D", "E"].map((label) => ({ label, description: "" })) },
    ],
    [
      "duplicate labels",
      {
        options: [
          { label: "Redis", description: "" },
          { label: "redis ", description: "" },
        ],
      },
    ],
    [
      "reserved Other",
      {
        options: [
          { label: "A", description: "" },
          { label: "Other", description: "" },
        ],
      },
    ],
    [
      "reserved other with spaces",
      {
        options: [
          { label: "A", description: "" },
          { label: " OTHER ", description: "" },
        ],
      },
    ],
    [
      "separator in a label",
      {
        options: [
          { label: "A; B", description: "" },
          { label: "C", description: "" },
        ],
      },
    ],
    ["multiSelect without options", { multiSelect: true }],
    [
      "unknown option key",
      {
        options: [
          { label: "A", description: "", value: 1 },
          { label: "B", description: "" },
        ],
      },
    ],
  ])("rejects %s", (_n, extra) =>
    expect(ClarificationRequestSchema.safeParse(req(extra)).success).toBe(false),
  );

  it("reports the issue at questions.<i>.options", () => {
    const r = ClarificationRequestSchema.safeParse(
      req({
        options: [
          { label: "A", description: "" },
          { label: "a", description: "" },
        ],
      }),
    );
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some((i) => i.path.join(".") === "questions.0.options")).toBe(true);
  });

  it("leaves native absent on a Phase 1 session", async () => {
    const home = await mkdtemp(join(tmpdir(), "ds-qo-"));
    tmps.push(home);
    const state: SessionState = await new SessionStore(home).create({
      task: "t",
      mode: "auto",
      explicit: false,
      repo: "/r",
      revision: "untracked",
    });
    expect(SessionStateSchema.parse(JSON.parse(JSON.stringify(state))).native).toBeUndefined();
  });

  it("keeps CONTRACT_VERSION 1 and options optional in JSON Schema", () => {
    expect(CONTRACT_VERSION).toBe("1");
    const s = generateSchemas()["question.schema.json"] as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(s.properties).toHaveProperty("options");
    expect(s.required).not.toContain("options");
  });
});
