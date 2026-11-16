import { describe, expect, it } from "vitest";
import type { JsonObject } from "@dynamic-skills/adapter-sdk";
import { mapQuestions } from "../src/questions";

describe("opencode mapQuestions", () => {
  it("maps multiSelect to multiple: true", () => {
    const plan = mapQuestions([
      {
        id: "a",
        text: "A?",
        multiSelect: true,
        options: [
          { label: "x", description: "dx" },
          { label: "y", description: "dy" },
        ],
      },
    ]);
    expect(plan.tool).toBe("question");
    expect(plan.calls).toHaveLength(1);
    const qs = plan.calls[0]!.questions as JsonObject[];
    expect(qs).toEqual([
      {
        question: "A?",
        header: "a",
        options: [
          { label: "x", description: "dx" },
          { label: "y", description: "dy" },
        ],
        multiple: true,
      },
    ]);
  });

  it("defaults multiple to false when multiSelect is absent", () => {
    const plan = mapQuestions([
      {
        id: "a",
        text: "A?",
        options: [
          { label: "x", description: "dx" },
          { label: "y", description: "dy" },
        ],
      },
    ]);
    const qs = plan.calls[0]!.questions as JsonObject[];
    expect(qs[0]!.multiple).toBe(false);
  });

  it("cuts the header at 30 characters", () => {
    const id = "q".repeat(40);
    const plan = mapQuestions([
      {
        id,
        text: "A?",
        options: [
          { label: "x", description: "dx" },
          { label: "y", description: "dy" },
        ],
      },
    ]);
    const header = Object.keys(plan.idMap)[0]!;
    expect(header).toHaveLength(30);
    expect(header).toBe(id.slice(0, 30));
    expect(plan.idMap[header]).toBe(id);
  });

  it("puts every question that has options into a single call", () => {
    const qs = Array.from({ length: 7 }, (_, i) => ({
      id: `q${i}`,
      text: `Q${i}?`,
      options: [
        { label: "x", description: "dx" },
        { label: "y", description: "dy" },
      ],
    }));
    const plan = mapQuestions(qs);
    expect(plan.calls).toHaveLength(1);
    expect((plan.calls[0]!.questions as JsonObject[]).length).toBe(7);
  });

  it("sends a question with no options as text, and idMap round-trips", () => {
    const plan = mapQuestions([
      { id: "a", text: "A?" },
      {
        id: "b",
        text: "B?",
        options: [
          { label: "x", description: "dx" },
          { label: "y", description: "dy" },
        ],
      },
    ]);
    expect(plan.textOnly).toEqual(["a"]);
    expect(Object.keys(plan.idMap)).toEqual(["b"]);
    expect(plan.idMap.b).toBe("b");
    const all = [...Object.values(plan.idMap), ...plan.textOnly].sort();
    expect(all).toEqual(["a", "b"]);
  });
});
