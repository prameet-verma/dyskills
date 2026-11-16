import { describe, expect, it } from "vitest";
import type { JsonValue } from "@dynamic-skills/adapter-sdk";
import { consentNotes } from "../src/consent";

const PATH = "/tmp/opencode.json";

/** The default, healthy document: our own consent entries in the usual order, nothing else. */
const CLEAN_V1: JsonValue = {
  permission: {
    bash: {
      "*": "ask",
      "dynamic-skills *": "allow",
      "dynamic-skills save *": "ask",
      "dynamic-skills init *": "ask",
    },
  },
};

describe("consentNotes", () => {
  it("probe row: a clean v1 document asks for both commands (no note)", () => {
    expect(consentNotes(CLEAN_V1, "v1", PATH)).toEqual([]);
  });

  it('probe row: a top-level permission["*"] AFTER bash wins over the ask (note)', () => {
    const doc: JsonValue = {
      permission: {
        bash: {
          "*": "ask",
          "dynamic-skills *": "allow",
          "dynamic-skills save *": "ask",
          "dynamic-skills init *": "ask",
        },
        "*": "allow",
      },
    };
    const notes = consentNotes(doc, "v1", PATH);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("dynamic-skills save");
    expect(notes[0]).toContain(PATH);
    expect(notes[1]).toContain("dynamic-skills init");
  });

  it('probe row: a top-level permission["*"] BEFORE bash does not win (no note)', () => {
    const doc: JsonValue = {
      permission: {
        "*": "allow",
        bash: {
          "*": "ask",
          "dynamic-skills *": "allow",
          "dynamic-skills save *": "ask",
          "dynamic-skills init *": "ask",
        },
      },
    };
    expect(consentNotes(doc, "v1", PATH)).toEqual([]);
  });

  it("probe row: the user's own save/init allow placed before the asks does not defeat them", () => {
    const doc: JsonValue = {
      permission: {
        bash: {
          "dynamic-skills save *": "allow",
          "*": "ask",
          "dynamic-skills *": "allow",
        },
      },
    };
    // Our own asks are always appended last by the merge, so even though the user wrote an
    // earlier "allow" for the same pattern, our later "ask" (simulated here, appended last) wins.
    const merged: JsonValue = {
      permission: {
        bash: {
          "dynamic-skills save *": "allow",
          "*": "ask",
          "dynamic-skills *": "allow",
          "dynamic-skills init *": "ask",
        },
      },
    };
    expect(consentNotes(merged, "v1", PATH).some((n) => n.includes("init"))).toBe(false);
    void doc;
  });

  it("probe row: v2 native permissions rule matching the command wins (note)", () => {
    const doc: JsonValue = {
      permission: {
        bash: {
          "*": "ask",
          "dynamic-skills *": "allow",
          "dynamic-skills save *": "ask",
          "dynamic-skills init *": "ask",
        },
      },
      permissions: [{ action: "shell", resource: "*", effect: "allow" }],
    };
    const notes = consentNotes(doc, "v2", PATH);
    expect(notes).toHaveLength(2);
  });

  it("probe row: a v2 native permissions rule that does not match the command is silent", () => {
    const doc: JsonValue = {
      permission: {
        bash: {
          "*": "ask",
          "dynamic-skills *": "allow",
          "dynamic-skills save *": "ask",
          "dynamic-skills init *": "ask",
        },
      },
      permissions: [{ action: "shell", resource: "git *", effect: "allow" }],
    };
    expect(consentNotes(doc, "v2", PATH)).toEqual([]);
  });

  it("probe row: v2 migrates bash -> shell so a native shell rule still matches our bash entries", () => {
    const doc: JsonValue = {
      permission: { bash: { "dynamic-skills save *": "ask" } },
      permissions: [{ action: "shell", resource: "dynamic-skills *", effect: "allow" }],
    };
    expect(consentNotes(doc, "v2", PATH).some((n) => n.includes("save"))).toBe(true);
  });

  it("probe row: a non-object root is silently ignored", () => {
    expect(consentNotes([], "v1", PATH)).toEqual([]);
    expect(consentNotes("ask" as unknown as JsonValue, "v1", PATH)).toEqual([]);
  });

  it("a top-level deny also counts as a defeated ask, not only allow", () => {
    const doc: JsonValue = {
      permission: {
        bash: { "dynamic-skills save *": "ask" },
        "*": "deny",
      },
    };
    const notes = consentNotes(doc, "v1", PATH);
    expect(notes.some((n) => n.includes("save"))).toBe(true);
  });
});
