import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "@dynamic-skills/core";
import type { SessionState } from "@dynamic-skills/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../src/io";
import { assertCanRun } from "../src/state-machine";
import type { CliCommand } from "../src/state-machine";
import { assess, discovered, harness } from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

/** A state with the given steps, built on a real fresh session. */
async function stateWith(
  steps: string[],
  patch: Partial<SessionState> = {},
): Promise<SessionState> {
  const store = new SessionStore(h.home);
  const s = await store.create({
    task: "t",
    mode: "auto",
    explicit: false,
    repo: h.repo,
    revision: "r",
  });
  return { ...s, completedSteps: steps, ...patch };
}

/** Runs assertCanRun and returns the INVALID_STATE error it must throw. */
function invalid(state: SessionState, command: CliCommand): CliError {
  try {
    assertCanRun(state, command);
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe("INVALID_STATE");
    return e as CliError;
  }
  throw new Error("expected INVALID_STATE");
}

const verdictOf = (approval: "not-required" | "pending" | "approved" | "declined") => ({
  outcome: "insufficient" as const,
  baseSkill: null,
  baseInstructionFile: null,
  approval,
});

describe("assertCanRun predecessors", () => {
  const table: [CliCommand, string, string[]][] = [
    ["discover", "assess", ["assess"]],
    ["context request", "context-submit", ["discover", "context-request", "context-submit"]],
    [
      "context submit",
      "clarify-answer",
      ["discover", "context-request", "context-submit", "clarify-answer"],
    ],
    ["clarify answer", "clarify-ask", ["clarify-ask"]],
    ["evaluate", "compile", ["compile", "evaluate"]],
    ["eval record", "evaluate", ["evaluate"]],
    ["activate", "eval-record", ["eval-record"]],
  ];
  for (const [command, ok, expected] of table) {
    it(`${command} runs after ${ok} and otherwise reports ${expected.join("|")}`, async () => {
      const good = await stateWith([ok]);
      expect(() => assertCanRun(good, command)).not.toThrow();
      expect(invalid(await stateWith(["bogus"]), command).extra.expected).toEqual(expected);
      expect(invalid(await stateWith([]), command).extra.expected).toEqual(expected);
    });
  }

  it("lets status and clean run in any state, even a finished one", async () => {
    const done = await stateWith(["assess"], { status: "completed" });
    expect(() => assertCanRun(done, "status")).not.toThrow();
    expect(() => assertCanRun(done, "clean")).not.toThrow();
  });

  it.each(["completed", "warning", "failed"] as const)(
    "rejects every pipeline command on a %s session with expected []",
    async (status) => {
      const s = await stateWith(["assess"], { status });
      for (const c of ["discover", "context submit", "compile", "activate"] as CliCommand[]) {
        expect(invalid(s, c).extra.expected).toEqual([]);
      }
    },
  );
});

describe("assertCanRun verdict rules", () => {
  it("allows sufficiency submit only after context-submit and only once", async () => {
    const ready = await stateWith(["context-submit"]);
    expect(() => assertCanRun(ready, "sufficiency submit")).not.toThrow();
    expect(invalid(await stateWith(["discover"]), "sufficiency submit").extra.expected).toEqual([
      "context-submit",
    ]);
    const again = await stateWith(["context-submit"], {
      sufficiency: verdictOf("not-required"),
    });
    expect(invalid(again, "sufficiency submit").extra.expected).toEqual([]);
  });

  it("allows sufficiency approve only while the approval is pending", async () => {
    const pending = await stateWith(["sufficiency-submit"], { sufficiency: verdictOf("pending") });
    expect(() => assertCanRun(pending, "sufficiency approve")).not.toThrow();
    const done = await stateWith(["sufficiency-submit"], {
      sufficiency: verdictOf("not-required"),
    });
    expect(invalid(done, "sufficiency approve").extra.expected).toEqual([]);
    expect(
      invalid(await stateWith(["context-submit"]), "sufficiency approve").extra.expected,
    ).toEqual(["sufficiency-submit"]);
  });

  it("guards clarify ask and compile on the verdict", async () => {
    for (const command of ["clarify ask", "compile"] as CliCommand[]) {
      const none = await stateWith(["context-submit"]);
      expect(invalid(none, command).extra.expected).toEqual(["sufficiency-submit"]);
      const pending = await stateWith(["sufficiency-submit"], {
        sufficiency: verdictOf("pending"),
      });
      expect(invalid(pending, command).extra.expected).toEqual(["sufficiency-approve"]);
      const ok = await stateWith(["sufficiency-submit"], {
        sufficiency: verdictOf("not-required"),
      });
      expect(() => assertCanRun(ok, command)).not.toThrow();
    }
  });

  it("rejects compile right after assess and discover", async () => {
    expect(invalid(await stateWith(["assess"]), "compile").code).toBe("INVALID_STATE");
    expect(invalid(await stateWith(["assess", "discover"]), "compile").code).toBe("INVALID_STATE");
  });
});

describe("the wrapper", () => {
  it("rejects clarify ask straight after discover with the predecessor list", async () => {
    const id = await discovered(h);
    const file = await h.doc("q.json", { schemaVersion: "1", questions: [] });
    const r = await h.run(["clarify", "ask", "--session", id, "--file", file]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatchObject({
      ok: false,
      schemaVersion: "1",
      error: "INVALID_STATE",
      expected: ["context-submit", "sufficiency-submit", "sufficiency-approve", "clarify-answer"],
    });
  });

  it("saves nothing when a command fails", async () => {
    const id = await discovered(h);
    const before = await h.read(id, "session.json");
    const r = await h.run(["discover", "--session", id]);
    expect(r.out.error).toBe("INVALID_STATE");
    expect(await h.read(id, "session.json")).toBe(before);
  });

  it("returns SESSION_NOT_FOUND for unknown and malformed ids without creating a directory", async () => {
    const bad = await h.run(["discover", "--session", "ds-nope"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.out.error).toBe("SESSION_NOT_FOUND");
    const missing = await h.run(["discover", "--session", "ds-20240101000000-abcdef"]);
    expect(missing.out.error).toBe("SESSION_NOT_FOUND");
    expect(await h.exists("ds-20240101000000-abcdef", "")).toBe(false);
  });

  it("returns SESSION_LOCKED while another operation holds the lock", async () => {
    const id = await assess(h);
    await writeFile(join(h.home, "sessions", id, "session.lock"), "");
    const r = await h.run(["discover", "--session", id]);
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("SESSION_LOCKED");
  });

  it("exits 3 with TIMEOUT once active time passes the budget and saves status timeout", async () => {
    const id = await discovered(h);
    await mkdir(join(h.home, "sessions", id, "skills"), { recursive: true });
    await writeFile(join(h.home, "sessions", id, "skills", "SKILL.md"), "x");
    h.clock.t += 61_000;
    const r = await h.run(["context", "request", "--session", id, "--file", "nope.json"]);
    expect(r.exitCode).toBe(3);
    expect(r.out).toMatchObject({ ok: false, error: "TIMEOUT" });
    expect(typeof r.out.fallback).toBe("string");
    expect(r.stderr).toContain("Timeout");
    const state = await h.readJson(id, "session.json");
    expect(state.status).toBe("timeout");
    expect(state.metrics.outcome).toBe("timeout");
    expect(await h.exists(id, "skills")).toBe(false);
    expect(await h.exists(id, "reports/performance.json")).toBe(true);
    expect(await h.exists(id, "reports/discovery.json")).toBe(true);
    // Every later command keeps reporting the timeout.
    const again = await h.run(["discover", "--session", id]);
    expect(again.exitCode).toBe(3);
  });

  it("does not turn a finished session into a timeout", async () => {
    const id = await assess(h, "x", ["--mode", "manual"]);
    h.clock.t += 120_000;
    const r = await h.run(["discover", "--session", id]);
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("INVALID_STATE");
    expect((await h.readJson(id, "session.json")).status).toBe("completed");
  });

  it("reports unknown commands and missing options as USAGE with JSON on stdout", async () => {
    const unknown = await h.run(["nonsense"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.out).toMatchObject({ ok: false, error: "USAGE" });
    const missing = await h.run(["discover"]);
    expect(missing.out.error).toBe("USAGE");
    const none = await h.run([]);
    expect(none.out.error).toBe("USAGE");
  });
});
