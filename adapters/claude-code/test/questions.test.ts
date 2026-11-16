import { describe, expect, it } from "vitest";
import type { NativeQuestionInput } from "@dynamic-skills/adapter-sdk";
import { claudeCodeAdapter } from "../src/index";

const opts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `L${i + 1}`, description: `D${i + 1}` }));
const q = (id: string, extra: Partial<NativeQuestionInput> = {}): NativeQuestionInput => ({
  id,
  text: `Text of ${id}?`,
  options: opts(2),
  ...extra,
});

describe("claude-code questions", () => {
  it("chunks five option questions into 4 + 1 in input order", () => {
    const plan = claudeCodeAdapter.questions(["a", "b", "c", "d", "e"].map((id) => q(id)));
    expect(plan.tool).toBe("AskUserQuestion");
    expect(plan.calls).toHaveLength(2);
    expect((plan.calls[0]!.questions as unknown[]).length).toBe(4);
    expect((plan.calls[1]!.questions as unknown[]).length).toBe(1);
    expect(plan.textOnly).toEqual([]);
  });

  it("shapes each question and truncates the header to 12 characters", () => {
    const plan = claudeCodeAdapter.questions([
      q("r12-question-long", { multiSelect: true }),
      q("short"),
    ]);
    expect(plan.calls).toEqual([
      {
        questions: [
          {
            question: "Text of r12-question-long?",
            header: "r12-question",
            options: opts(2),
            multiSelect: true,
          },
          { question: "Text of short?", header: "short", options: opts(2), multiSelect: false },
        ],
      },
    ]);
  });

  it("asks a question without options as text", () => {
    const plan = claudeCodeAdapter.questions([q("a"), { id: "free", text: "Free?" }]);
    expect(plan.textOnly).toEqual(["free"]);
    expect(Object.values(plan.idMap)).toEqual(["a"]);
  });

  it("never truncates: out-of-range option counts and duplicate texts go to text", () => {
    const plan = claudeCodeAdapter.questions([
      q("five", { options: opts(5) }),
      q("one", { options: opts(1) }),
      q("none", { options: [] }),
      q("a", { text: "Same?" }),
      q("b", { text: "Same?" }),
    ]);
    expect(plan.textOnly).toEqual(["five", "one", "none", "b"]);
    expect(plan.idMap).toEqual({ "Same?": "a" });
  });

  it("maps every call question back to its id", () => {
    const qs = ["a", "b", "c", "d", "e"].map((id) => q(id));
    const plan = claudeCodeAdapter.questions(qs);
    const asked = plan.calls.flatMap((c) => c.questions as { question: string }[]);
    expect(asked.map((x) => plan.idMap[x.question])).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("notes the tool's limits", () => {
    const plan = claudeCodeAdapter.questions([q("a")]);
    expect(plan.notes.join(" ")).toMatch(/subagents or non-interactive/);
  });
});
