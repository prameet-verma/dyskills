import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assumptionsEval,
  behaviouralDefinitionEval,
  completenessEval,
  duplicationEval,
  evidenceClassificationEval,
  groundingEval,
  roleEval,
  scopeEval,
  type GenerationEval,
} from "../src/index";
import { GOLDEN_AUGMENT_RAW, GOLDEN_RAW, ROOT, makeContext } from "./helpers";

const ALL: GenerationEval[] = [
  groundingEval,
  evidenceClassificationEval,
  assumptionsEval,
  completenessEval,
  scopeEval,
  roleEval,
  duplicationEval,
  behaviouralDefinitionEval,
];

const BASE_RAW = readFileSync(
  resolve(ROOT, "fixtures/skills/augmentation-base/order-caching/SKILL.md"),
  "utf8",
);

/** Appends a bullet to the end of the `## Project context` section (the last section). */
const withBullet = (raw: string, bullet: string): string => `${raw.trimEnd()}\n- ${bullet}\n`;

describe("golden fixtures", () => {
  it("declares ids and mandatory flags", () => {
    expect(ALL.map((e) => [e.id, e.mandatory])).toEqual([
      ["grounding", true],
      ["evidence-classification", true],
      ["assumptions", false],
      ["completeness", false],
      ["scope", false],
      ["role", false],
      ["duplication", false],
      ["behavioural-definition", true],
    ]);
  });

  for (const withAnalysis of [false, true]) {
    it(`new skill passes all (withAnalysis=${withAnalysis})`, async () => {
      const ctx = await makeContext({ withAnalysis });
      for (const e of ALL) {
        const r = await e.run(ctx);
        expect([e.id, r.outcome, r.messages]).toEqual([
          e.id,
          e.id === "duplication" ? "not-applicable" : "pass",
          r.messages,
        ]);
      }
    });
  }

  it("golden augmentation passes all in augmentation mode", async () => {
    const ctx = await makeContext({ augmentation: true });
    for (const e of ALL) {
      const r = await e.run(ctx);
      expect([e.id, r.outcome, r.messages]).toEqual([e.id, "pass", r.messages]);
    }
  });
});

describe("grounding", () => {
  it("fails an unknown [evidence:] key", async () => {
    const ctx = await makeContext({ raw: withBullet(GOLDEN_RAW, "Go [evidence: runtime.go].") });
    const r = await groundingEval.run(ctx);
    expect(r.outcome).toBe("fail");
    expect(r.messages).toContain("unknown evidence runtime.go");
  });

  it("fails an unknown [inferred:] key", async () => {
    const ctx = await makeContext({ raw: withBullet(GOLDEN_RAW, "Go [inferred: runtime.go].") });
    const r = await groundingEval.run(ctx);
    expect(r.outcome).toBe("fail");
    expect(r.messages).toContain("unknown evidence runtime.go");
  });

  it("fails a conflicting key", async () => {
    const base = await makeContext();
    const evidence = base.evidence.map((e) =>
      e.key === "language.typescript" ? { ...e, confidence: "conflicting" as const } : e,
    );
    const ctx = await makeContext({ evidence });
    const r = await groundingEval.run(ctx);
    expect(r.outcome).toBe("fail");
    expect(r.messages).toContain("cites conflicting evidence language.typescript");
  });

  it("fails an uncited project-context bullet", async () => {
    const ctx = await makeContext({ raw: withBullet(GOLDEN_RAW, "It is fast.") });
    const r = await groundingEval.run(ctx);
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("uncited project claim");
  });

  it("passes a matching [assumption:] and fails an unknown one", async () => {
    const assumptions = [
      {
        questionId: "analysis-1",
        question: "q",
        assumption: "a",
        basis: "b",
        impact: "i",
        status: "not-asked" as const,
      },
    ];
    const ok = await makeContext({
      raw: withBullet(GOLDEN_RAW, "Redis may be used [assumption: analysis-1]."),
      assumptions,
    });
    expect((await groundingEval.run(ok)).outcome).toBe("pass");
    const bad = await makeContext({
      raw: withBullet(GOLDEN_RAW, "Redis may be used [assumption: analysis-9]."),
      assumptions,
    });
    expect((await groundingEval.run(bad)).outcome).toBe("fail");
  });

  it("checks every Project context section, normalising the heading", async () => {
    const extra = "\n## Project context:\n- It is fast.\n";
    const fresh = await groundingEval.run(
      await makeContext({ raw: `${GOLDEN_RAW.trimEnd()}\n${extra}` }),
    );
    expect(fresh.outcome).toBe("fail");
    const aug = await groundingEval.run(
      await makeContext({
        raw: `${GOLDEN_AUGMENT_RAW.trimEnd()}\n${extra}`,
        augmentation: true,
      }),
    );
    expect(aug.outcome).toBe("fail");
    const only = GOLDEN_RAW.replace("## Project context", "## Project context:");
    expect((await groundingEval.run(await makeContext({ raw: only }))).outcome).toBe("pass");
    const uncited = only.replace(/\[evidence: package-manager\]/, "");
    expect((await groundingEval.run(await makeContext({ raw: uncited }))).outcome).toBe("fail");
  });

  it("fails malformed citations", async () => {
    for (const tag of [
      `[evidence:${" ".repeat(201)}language.typescript]`,
      "[Evidence: language.typescript]",
      "[evidence : language.typescript]",
      "[ evidence: language.typescript]",
      "[evidence: language.typescript, runtime.node]",
    ]) {
      const r = await groundingEval.run(
        await makeContext({ raw: withBullet(GOLDEN_RAW, `X ${tag}.`) }),
      );
      expect([tag.slice(0, 30), r.outcome]).toEqual([tag.slice(0, 30), "fail"]);
      expect(r.messages.join("\n")).toContain("malformed citation near:");
    }
  });

  it("ignores bullets inside a fenced block and closes fences by character and length", async () => {
    const fenced = `${GOLDEN_RAW.trimEnd()}\n\n\`\`\`\n- uncited in fence\n\`\`\`\n`;
    expect((await groundingEval.run(await makeContext({ raw: fenced }))).outcome).toBe("pass");
    // A shorter fence does not close a longer one, so the heading inside stays hidden.
    const long = `${GOLDEN_RAW.trimEnd()}\n\n\`\`\`\`\n\`\`\`\n## Project context\n- hidden\n\`\`\`\`\n`;
    expect((await groundingEval.run(await makeContext({ raw: long }))).outcome).toBe("pass");
  });

  it("does not let an unclosed fence hide a Project context section", async () => {
    const raw = `${GOLDEN_RAW.trimEnd()}\n\n\`\`\`\n## Project context\n- It is fast.\n`;
    expect((await groundingEval.run(await makeContext({ raw }))).outcome).toBe("fail");
  });

  it("handles a 90k-character heading line quickly", async () => {
    const raw = `${GOLDEN_RAW.trimEnd()}\n\n## ${"a".repeat(90_000)}\n`;
    const ctx = await makeContext({ raw });
    const t0 = performance.now();
    await groundingEval.run(ctx);
    await roleEval.run(ctx);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("fails zero-width and emphasis-split citation openers", async () => {
    for (const tag of [
      "[\u200Bevidence: language.typescript]",
      "[**evidence**: language.typescript]",
    ]) {
      const r = await groundingEval.run(
        await makeContext({ raw: withBullet(GOLDEN_RAW, `X ${tag}.`) }),
      );
      expect(r.outcome).toBe("fail");
      expect(r.messages.join("\n")).toContain("malformed citation near:");
    }
  });

  it("does not let a fence line with an info string close a fence", async () => {
    const raw = `${GOLDEN_RAW.trimEnd()}\n\n\`\`\`\n\`\`\`js\n## Project context\n- hidden\n\`\`\`\n`;
    expect((await groundingEval.run(await makeContext({ raw }))).outcome).toBe("pass");
  });

  it("normalises a long colon run in a heading in linear time", async () => {
    const raw = `${GOLDEN_RAW.trimEnd()}\n\n## a${":".repeat(90_000)} b\n`;
    const ctx = await makeContext({ raw });
    const t0 = performance.now();
    await groundingEval.run(ctx);
    await roleEval.run(ctx);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("stays linear on an unterminated tag followed by whitespace", async () => {
    const ctx = await makeContext({
      raw: withBullet(GOLDEN_RAW, `[evidence:${" ".repeat(90_000)}`),
    });
    const start = Date.now();
    await groundingEval.run(ctx);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("evidence-classification", () => {
  it("fails [evidence:] on an inferred key, while grounding passes", async () => {
    const ctx = await makeContext({
      raw: withBullet(GOLDEN_RAW, "React is used [evidence: framework.react]."),
    });
    const r = await evidenceClassificationEval.run(ctx);
    expect(r.outcome).toBe("fail");
    expect(r.messages).toContain("states inference framework.react as fact");
    expect((await groundingEval.run(ctx)).outcome).toBe("pass");
  });

  it("passes [inferred:] on an inferred key", async () => {
    const ctx = await makeContext({
      raw: withBullet(GOLDEN_RAW, "React appears used [inferred: framework.react]."),
    });
    expect((await evidenceClassificationEval.run(ctx)).outcome).toBe("pass");
    expect((await groundingEval.run(ctx)).outcome).toBe("pass");
  });

  it("warns [inferred:] on a verified key", async () => {
    const ctx = await makeContext({
      raw: withBullet(GOLDEN_RAW, "TS [inferred: language.typescript]."),
    });
    const r = await evidenceClassificationEval.run(ctx);
    expect(r.outcome).toBe("warning");
    expect(r.messages).toContain(
      "language.typescript is verified; cite it as [evidence: language.typescript]",
    );
  });

  it("separates agentic inferred and verified keys", async () => {
    const bad = await makeContext({
      withAnalysis: true,
      raw: withBullet(GOLDEN_RAW, "Writes [evidence: agentic.architecture.order-write-path]."),
    });
    expect((await evidenceClassificationEval.run(bad)).outcome).toBe("fail");
    const ok = await makeContext({
      withAnalysis: true,
      raw: withBullet(GOLDEN_RAW, "Reads [evidence: agentic.architecture.order-read-path]."),
    });
    expect((await evidenceClassificationEval.run(ok)).outcome).toBe("pass");
  });

  it("ignores unknown keys", async () => {
    const ctx = await makeContext({ raw: withBullet(GOLDEN_RAW, "Go [evidence: runtime.go].") });
    expect((await evidenceClassificationEval.run(ctx)).outcome).toBe("pass");
  });
});

describe("assumptions", () => {
  it("fails a version no evidence supports", async () => {
    const ctx = await makeContext({
      raw: withBullet(GOLDEN_RAW, "Node 22.1.0 [evidence: runtime.node]."),
    });
    const r = await assumptionsEval.run(ctx);
    expect(r.outcome).toBe("fail");
    expect(r.messages).toContain("unsupported version claim 22.1.0");
  });

  it("warns on a framework without evidence", async () => {
    const ctx = await makeContext({
      raw: withBullet(GOLDEN_RAW, "Django handles requests [evidence: language.typescript]."),
    });
    expect((await assumptionsEval.run(ctx)).outcome).toBe("warning");
  });

  it("matches frameworks by exact key and word alias", async () => {
    const core = await makeContext({
      raw: withBullet(GOLDEN_RAW, "Core logic stays put [evidence: package-manager]."),
    });
    expect((await assumptionsEval.run(core)).outcome).toBe("pass");
    const angular = await makeContext({
      raw: withBullet(GOLDEN_RAW, "Uses Angular [evidence: package-manager]."),
    });
    const r = await assumptionsEval.run(angular);
    expect(r.outcome).toBe("warning");
    const base = await makeContext();
    const nest = { ...base.evidence[0]!, key: "framework.@nestjs/core", value: "@nestjs/core" };
    const ok = await makeContext({
      raw: withBullet(GOLDEN_RAW, "Uses NestJS [evidence: package-manager]."),
      evidence: [...base.evidence, nest],
    });
    expect((await assumptionsEval.run(ok)).outcome).toBe("pass");
  });

  it("reads a 100k-digit evidence value in linear time", async () => {
    const base = await makeContext();
    const evidence = [{ ...base.evidence[0]!, key: "x.y", value: "1".repeat(100_000) }];
    const ctx = await makeContext({ evidence });
    const t0 = performance.now();
    await assumptionsEval.run(ctx);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("applies the version rule", async () => {
    const run = async (text: string, conflicting = false): Promise<string> => {
      const base = await makeContext();
      const evidence = base.evidence.map((e) =>
        e.key === "runtime.node" && conflicting ? { ...e, confidence: "conflicting" as const } : e,
      );
      const ctx = await makeContext({
        raw: withBullet(GOLDEN_RAW, `${text} [evidence: package-manager].`),
        evidence,
      });
      return (await assumptionsEval.run(ctx)).outcome;
    };
    expect(await run("Node 20.11")).toBe("pass");
    expect(await run("Node v20.11.0")).toBe("pass");
    expect(await run("Node 20.11.0.")).toBe("pass");
    expect(await run("See §6.6")).toBe("pass");
    expect(await run("Host 192.168.1.1")).toBe("pass");
    expect(await run("Node 22.1.0.")).toBe("fail");
    expect(await run("About 2.0 tokens")).toBe("fail");
    expect(await run("Node 20.11.0", true)).toBe("fail");
  });

  it("does not treat the word next as a framework", async () => {
    const ctx = await makeContext({
      raw: withBullet(GOLDEN_RAW, "Next [evidence: package-manager]."),
    });
    expect((await assumptionsEval.run(ctx)).outcome).toBe("pass");
  });
});

describe("completeness", () => {
  it("fails answered user evidence that is uncited", async () => {
    const base = await makeContext();
    const user = {
      ...base.evidence[0]!,
      key: "user.q1",
      value: "Use Redis",
      category: "user" as const,
      origin: "user" as const,
    };
    const ctx = await makeContext({ evidence: [...base.evidence, user] });
    const r = await completenessEval.run(ctx);
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("user.q1");
  });

  it("warns when a verified gap category is not cited", async () => {
    const raw = GOLDEN_RAW.replace(/^- Code is organised.*\n/m, "");
    const ctx = await makeContext({ raw });
    const r = await completenessEval.run(ctx);
    expect(r.outcome).toBe("warning");
    expect(r.messages.join("\n")).toContain("architecture");
  });
});

describe("scope", () => {
  it("fails a description unrelated to the task", async () => {
    const raw = GOLDEN_RAW.replace(/^description: .*$/m, "description: Formats YAML files.");
    expect((await scopeEval.run(await makeContext({ raw }))).outcome).toBe("fail");
  });
});

describe("role", () => {
  it("fails a new skill missing ## Boundaries", async () => {
    const raw = GOLDEN_RAW.replace(/## Boundaries[\s\S]*?(?=## Methodology)/, "");
    const r = await roleEval.run(await makeContext({ raw }));
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("Boundaries");
  });

  it("fails an augmentation with an extra section", async () => {
    const raw = `${GOLDEN_AUGMENT_RAW.trimEnd()}\n\n## Ownership\n- Everything.\n`;
    const r = await roleEval.run(await makeContext({ raw, augmentation: true }));
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain(
      "augmentation may only contain sections: Task contract, Project context, Constraints, Methodology additions",
    );
  });

  it("fails an augmentation with a setext section outside the allow-list", async () => {
    for (const underline of ["---------", "========="]) {
      const raw = `${GOLDEN_AUGMENT_RAW.trimEnd()}\n\nOwnership\n${underline}\n- Everything.\n`;
      const r = await roleEval.run(await makeContext({ raw, augmentation: true }));
      expect(r.outcome).toBe("fail");
      expect(r.messages.join("\n")).toContain("found: ownership");
    }
  });

  it("does not read a list item or fenced text before a rule as a heading", async () => {
    const raw = `${GOLDEN_AUGMENT_RAW.trimEnd()}\n\n- item\n---\n\n\`\`\`\nOwnership\n---\n\`\`\`\n`;
    const r = await roleEval.run(await makeContext({ raw, augmentation: true }));
    expect(r).toEqual({ outcome: "pass", messages: [] });
  });

  it("scans hostile setext underlines quickly", async () => {
    const raw = `${GOLDEN_AUGMENT_RAW.trimEnd()}\n\nx\n${"=".repeat(20_000)}x\n${" ".repeat(20_000)}\ny\n${"-".repeat(20_000)} z\n`;
    const ctx = await makeContext({ raw, augmentation: true });
    const t0 = performance.now();
    await roleEval.run(ctx);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("fails an augmentation without - Adds:", async () => {
    const raw = GOLDEN_AUGMENT_RAW.replace(/^- Adds:.*\n/m, "");
    const r = await roleEval.run(await makeContext({ raw, augmentation: true }));
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("- Adds:");
  });

  it("fails an augmentation without the Already covered line", async () => {
    const raw = GOLDEN_AUGMENT_RAW.replace(/^- Already covered by.*\n/m, "");
    expect((await roleEval.run(await makeContext({ raw, augmentation: true }))).outcome).toBe(
      "fail",
    );
  });
});

describe("duplication", () => {
  it("fails a skill that copies an existing skill", async () => {
    const base = await makeContext();
    const ctx = await makeContext({
      existingSkills: [
        {
          name: "copy",
          description: "d",
          path: "/x/SKILL.md",
          scope: "project",
          harness: "claude-code",
          body: base.skill.body,
        },
      ],
    });
    const r = await duplicationEval.run(ctx);
    expect(r.outcome).toBe("fail");
  });

  it("warns on partial overlap with instruction text", async () => {
    const lines = (await makeContext()).skill.body.split("\n");
    const ctx = await makeContext();
    ctx.instructionTexts = [lines.slice(0, Math.ceil(lines.length * 0.6)).join("\n")];
    expect((await duplicationEval.run(ctx)).outcome).toBe("warning");
  });

  it("fails when a pasted frontmatter-like block carries the base Methodology", async () => {
    const method = /## Methodology\n([\s\S]*?)(?=## Accountability)/.exec(BASE_RAW)![1]!;
    const raw = GOLDEN_AUGMENT_RAW.replace(/\n---\n\n#/, `\n---\n---\n${method}\n---\n\n#`);
    const ctx = await makeContext({ raw, augmentation: true });
    expect(ctx.skill.body.startsWith("---")).toBe(true);
    expect((await duplicationEval.run(ctx)).outcome).toBe("fail");
  });

  it("is zero for text shorter than one shingle", async () => {
    const ctx = await makeContext({ augmentation: true });
    ctx.augmentation!.baseBody = "too short";
    expect((await duplicationEval.run(ctx)).outcome).toBe("pass");
  });

  it("fails an augmentation pasting the base Methodology (0.375 base-side)", async () => {
    const method = /## Methodology\n([\s\S]*?)(?=## Accountability)/.exec(BASE_RAW)![1]!;
    const raw = `${GOLDEN_AUGMENT_RAW.trimEnd()}\n\n${method}`;
    const r = await duplicationEval.run(await makeContext({ raw, augmentation: true }));
    expect(r.outcome).toBe("fail");
    expect(r.messages.join("\n")).toContain("copies the base skill");
    expect(r.messages.join("\n")).toContain("38%");
  });
});

describe("behavioural-definition", () => {
  it("fails without a smoke eval", async () => {
    const ctx = await makeContext({ smokeEval: null });
    expect((await behaviouralDefinitionEval.run(ctx)).outcome).toBe("fail");
  });

  it("fails when prohibited is empty or nothing is asserted", async () => {
    const base = await makeContext();
    const smoke = base.smokeEval!;
    const noProhibited = await makeContext({ smokeEval: { ...smoke, prohibited: [] } });
    expect((await behaviouralDefinitionEval.run(noProhibited)).outcome).toBe("fail");
    const noChecks = await makeContext({ smokeEval: { ...smoke, assertions: [], rubric: [] } });
    expect((await behaviouralDefinitionEval.run(noChecks)).outcome).toBe("fail");
  });
});
