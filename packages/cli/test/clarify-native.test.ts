/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysed, harness, verdict } from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

const option = (n: number) => ({ label: `Option ${n}`, description: `Choice number ${n}` });
const q = (over: Record<string, unknown>) => ({
  id: "q-text",
  text: "What migration rollout policy applies?",
  requirement: "migration-policy",
  material: true,
  blocking: false,
  ...over,
});

async function ready(): Promise<string> {
  const id = await analysed(h, "Add a database migration for the orders table");
  const file = await h.doc("verdict.json", verdict({ outcome: "insufficient" }));
  expect((await h.run(["sufficiency", "submit", "--session", id, "--file", file])).exitCode).toBe(
    0,
  );
  return id;
}

async function ask(id: string, args: string[], env: Record<string, string>, ...qs: unknown[]) {
  const file = await h.doc("q.json", { schemaVersion: "1", questions: qs });
  return h.runWith(["clarify", "ask", "--session", id, "--file", file, ...args], { vars: env });
}

const two = [
  q({ id: "r1-q1", requirement: "r-one", options: [option(1), option(2)] }),
  q({ id: "r1-q2", text: "Who approves a rollback?", requirement: "r-two" }),
];

describe("clarify ask native plan", () => {
  it("maps an option question and leaves the text question as text (claude-code)", async () => {
    const id = await ready();
    const r = await ask(id, ["--harness", "claude-code"], {}, ...two);
    expect(r.exitCode).toBe(0);
    expect(r.out.native.tool).toBe("AskUserQuestion");
    expect(r.out.native.calls).toHaveLength(1);
    expect(r.out.native.textOnly).toEqual(["r1-q2"]);
    expect(Object.values(r.out.native.idMap)).toContain("r1-q1");
  });

  it("maps ids for codex", async () => {
    const id = await ready();
    const r = await ask(id, ["--harness", "codex"], {}, ...two);
    expect(r.out.native.tool).toBe("request_user_input");
    expect(r.out.native.idMap).toEqual({ r1_q1: "r1-q1" });
    expect(r.out.native.textOnly).toEqual(["r1-q2"]);
  });

  it("sends a multiSelect question to text for codex", async () => {
    const id = await ready();
    const multi = q({
      id: "r1-q1",
      requirement: "r-one",
      options: [option(1), option(2)],
      multiSelect: true,
    });
    const r = await ask(id, ["--harness", "codex"], {}, multi);
    expect(r.out.native.textOnly).toEqual(["r1-q1"]);
    expect(r.out.native.calls).toEqual([]);
  });

  it("takes the harness from DYNAMIC_SKILLS_HARNESS, and the flag wins", async () => {
    const id = await ready();
    const env = { DYNAMIC_SKILLS_HARNESS: "codex" };
    expect((await ask(id, [], env, two[0])).out.native.tool).toBe("request_user_input");
    const id2 = await ready();
    expect((await ask(id2, ["--harness", "claude-code"], env, two[0])).out.native.tool).toBe(
      "AskUserQuestion",
    );
  });

  it("is null without a harness", async () => {
    const id = await ready();
    const r = await ask(id, [], {}, ...two);
    expect(r.exitCode).toBe(0);
    expect(r.out.native).toBeNull();
    expect(r.out.accepted).toHaveLength(2);
  });

  it("rejects an unknown --harness as USAGE", async () => {
    const id = await ready();
    const r = await ask(id, ["--harness", "nope"], {}, ...two);
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("USAGE");
  });

  it("asks every accepted question exactly once, however many there are (claude-code)", async () => {
    const id = await ready();
    const many = Array.from({ length: 6 }, (_, i) =>
      q({
        id: `r1-q${i + 1}`,
        text: `Question number ${i + 1}?`,
        requirement: `r-${i}`,
        options: [option(1), option(2)],
      }),
    );
    const r = await ask(id, ["--harness", "claude-code"], {}, ...many);
    const plan = r.out.native;
    const ids = [
      ...plan.calls.flatMap((c: any) => c.questions.map((x: any) => plan.idMap[x.question])),
      ...plan.textOnly,
    ];
    expect(plan.calls).toHaveLength(2);
    expect(ids.sort()).toEqual(r.out.accepted.map((a: any) => a.id).sort());
  });

  it("is null when nothing was accepted", async () => {
    const id = await ready();
    const r = await ask(id, ["--harness", "claude-code"], {}, q({ material: false }));
    expect(r.out.accepted).toEqual([]);
    expect(r.out.native).toBeNull();
  });
});
