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

  it("v2 bash->shell rename: a top-level '*': allow after the migrated bash asks still wins (note)", () => {
    const doc: JsonValue = {
      permission: {
        bash: { "dynamic-skills save *": "ask", "dynamic-skills init *": "ask" },
        "*": "allow",
      },
    };
    const notes = consentNotes(doc, "v2", PATH);
    expect(notes).toHaveLength(2);
    expect(notes.some((n) => n.includes("save"))).toBe(true);
    expect(notes.some((n) => n.includes("init"))).toBe(true);
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

  it("a deny-wins note says the command is denied, and never advises moving or removing it", () => {
    const doc: JsonValue = {
      permission: {
        bash: { "dynamic-skills save *": "ask" },
        "*": "deny",
      },
    };
    const notes = consentNotes(doc, "v1", PATH);
    const note = notes.find((n) => n.includes("save"))!;
    expect(note).toMatch(/denied/i);
    expect(note).not.toMatch(/move or remove/i);
  });

  it("a documented opt-out rule (dynamic-skills save ...: allow) is described as lifting consent, not a defeat", () => {
    const doc: JsonValue = {
      permission: {
        bash: {
          "*": "ask",
          "dynamic-skills *": "allow",
          "dynamic-skills save *": "ask",
          "dynamic-skills init *": "ask",
          "dynamic-skills save --session *": "allow",
        },
      },
    };
    const notes = consentNotes(doc, "v1", PATH);
    const saveNote = notes.find((n) => n.includes("save"))!;
    expect(saveNote).toBeDefined();
    expect(saveNote).toMatch(/lifted by your rule/i);
    expect(saveNote).not.toMatch(/move or remove/i);
    expect(notes.some((n) => n.includes("init"))).toBe(false);
  });

  it("a documented opt-out for init (dynamic-skills init ...: allow) is also described as lifting consent", () => {
    const doc: JsonValue = {
      permission: {
        bash: {
          "*": "ask",
          "dynamic-skills *": "allow",
          "dynamic-skills save *": "ask",
          "dynamic-skills init *": "ask",
          "dynamic-skills init --harness *": "allow",
        },
      },
    };
    const notes = consentNotes(doc, "v1", PATH);
    const initNote = notes.find((n) => n.includes("init"))!;
    expect(initNote).toMatch(/lifted by your rule/i);
    expect(initNote).not.toMatch(/move or remove/i);
  });

  it("a top-level string permission of allow is a defeat; ask is silent", () => {
    expect(consentNotes({ permission: "ask" }, "v1", PATH)).toEqual([]);
    const notes = consentNotes({ permission: "allow" }, "v1", PATH);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/move or remove/i);
  });
});
