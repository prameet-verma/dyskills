import { describe, expect, it } from "vitest";
import { codexAdapter } from "../src/index";

const opts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `L${i + 1}`, description: `D${i + 1}` }));

describe("codex questions", () => {
  it("uses request_user_input", () => {
    expect(codexAdapter.questions([]).tool).toBe("request_user_input");
  });

  it("sends a 4-option question to text", () => {
    const plan = codexAdapter.questions([{ id: "r1-q1", text: "Q?", options: opts(4) }]);
    expect(plan.textOnly).toEqual(["r1-q1"]);
    expect(plan.calls).toEqual([]);
    expect(plan.idMap).toEqual({});
  });

  it("sends a multiSelect question to text", () => {
    const plan = codexAdapter.questions([
      { id: "r1-q1", text: "Q?", options: opts(2), multiSelect: true },
    ]);
    expect(plan.textOnly).toEqual(["r1-q1"]);
    expect(plan.calls).toEqual([]);
  });

  it("sends a question without options to text, and a 1-option one too", () => {
    const plan = codexAdapter.questions([
      { id: "a", text: "A?" },
      { id: "b", text: "B?", options: opts(1) },
    ]);
    expect(plan.textOnly).toEqual(["a", "b"]);
  });

  it("maps r1-q1 to r1_q1 and back", () => {
    const plan = codexAdapter.questions([{ id: "r1-q1", text: "Which?", options: opts(3) }]);
    expect(plan.idMap).toEqual({ r1_q1: "r1-q1" });
    expect(plan.calls).toEqual([
      {
        questions: [{ id: "r1_q1", header: "r1-q1", question: "Which?", options: opts(3) }],
      },
    ]);
    expect(plan.textOnly).toEqual([]);
  });

  it("truncates the header to 12 characters", () => {
    const plan = codexAdapter.questions([
      { id: "r1-q1-very-long-id", text: "Q?", options: opts(2) },
    ]);
    const q = (plan.calls[0]!.questions as { header: string }[])[0]!;
    expect(q.header).toBe("r1-q1-very-l");
  });

  it("chunks five eligible questions into calls of 3 and 2", () => {
    const qs = [1, 2, 3, 4, 5].map((n) => ({ id: `r1-q${n}`, text: `Q${n}?`, options: opts(2) }));
    const plan = codexAdapter.questions(qs);
    expect(plan.calls.map((c) => (c.questions as unknown[]).length)).toEqual([3, 2]);
    expect(Object.keys(plan.idMap)).toEqual(["r1_q1", "r1_q2", "r1_q3", "r1_q4", "r1_q5"]);
  });

  it("keeps text-only questions out of the calls and mentions Plan mode", () => {
    const plan = codexAdapter.questions([
      { id: "x", text: "X?" },
      { id: "y", text: "Y?", options: opts(2) },
    ]);
    expect(plan.textOnly).toEqual(["x"]);
    expect(Object.values(plan.idMap)).toEqual(["y"]);
    expect(plan.notes.join(" ")).toMatch(/Plan mode/);
  });
});
