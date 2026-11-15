import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysed, harness } from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

/** C0 and C1 control characters other than newline must never reach the terminal. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

describe("stderr control characters", () => {
  it("strips escape sequences from a hostile --session value in usage and error text", async () => {
    const r = await h.run(["discover", "--session", "\x1b[31mX"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toMatch(CONTROL);
    expect(r.stderr).not.toContain("\x1b");
  });

  it("strips them from commander's own error text", async () => {
    const r = await h.run(["discover", "--session", "x", "--\x1b]0;pwned\x07bogus"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toMatch(CONTROL);
  });

  it("strips them from a questionId echoed in an error", async () => {
    const id = await analysed(h);
    const q = await h.doc("q.json", {
      schemaVersion: "1",
      questions: [{ id: "\x1b]0;pwned\x07", text: "Which?", requirement: "x" }],
    });
    const r = await h.run(["clarify", "ask", "--session", id, "--file", q]);
    expect(r.stderr).not.toContain("\x1b");
    expect(r.stderr).not.toContain("\x07");
    const answer = await h.doc("a.json", {
      schemaVersion: "1",
      answers: [{ questionId: "\x1b]0;pwned\x07", answer: "x" }],
    });
    const a = await h.run(["clarify", "answer", "--session", id, "--file", answer]);
    expect(a.stderr).not.toMatch(CONTROL);
  });

  it("keeps newlines in the status block", async () => {
    const id = await analysed(h);
    const r = await h.run(["context", "request", "--session", id, "--file", "nope.json"]);
    expect(r.stderr).toContain("\n");
  });
});

describe("help and usage", () => {
  it("--help prints ok JSON on stdout, exit 0, and help text on stderr", async () => {
    const r = await h.run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toEqual({ ok: true, schemaVersion: "1", help: true });
    expect(r.stderr).toContain("Usage:");
  });

  it("a command's --help is the same", async () => {
    const r = await h.run(["compile", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toEqual({ ok: true, schemaVersion: "1", help: true });
  });

  it("a group with no subcommand is a USAGE error with a readable message", async () => {
    const r = await h.run(["context"]);
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("USAGE");
    expect(r.out.message).toBe("missing subcommand: request | submit");
    const e = await h.run(["eval"]);
    expect(e.out.message).toBe("missing subcommand: record");
  });
});
