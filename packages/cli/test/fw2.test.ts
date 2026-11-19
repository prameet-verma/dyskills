import { mkdir, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { placeBundle } from "@dynamic-skills/adapter-sdk";
import type { HostProbe } from "@dynamic-skills/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analysed, assess, harness, hashTree, installGolden, ready, record } from "./helpers";
import type { Harness } from "./helpers";

/** Seam over the mocked SDK: a test replaces `placeBundle` for chosen calls. */
const hooks: {
  place?: (
    input: Parameters<typeof placeBundle>[0],
    real: typeof placeBundle,
  ) => ReturnType<typeof placeBundle>;
} = {};

vi.mock("@dynamic-skills/adapter-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@dynamic-skills/adapter-sdk")>();
  return {
    ...real,
    placeBundle: (input: Parameters<typeof real.placeBundle>[0]) =>
      hooks.place ? hooks.place(input, real.placeBundle) : real.placeBundle(input),
  };
});

const probe: HostProbe = {
  async which(bin) {
    return `/fake/bin/${bin.split("/").pop()}`;
  },
  async run() {
    return { code: 0, stdout: "2.1.325 (Claude Code)\n", stderr: "" };
  },
};

let h: Harness;
beforeEach(async () => {
  h = await harness();
  await mkdir(join(h.repo, ".git"), { recursive: true });
  hooks.place = undefined;
});
afterEach(() => h.cleanup());

const HOUR = 3_600_000;
const NATIVE_ON = { DYNAMIC_SKILLS_HARNESS: "claude-code", DYNAMIC_SKILLS_NATIVE: "1" };
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const sessionDir = (id: string) => join(h.home, "sessions", id);

/** Drives a session to `evaluate` + `eval record`. */
async function recorded(): Promise<string> {
  const id = await ready(h);
  expect((await h.run(["compile", "--session", id])).exitCode).toBe(0);
  await installGolden(h, id, "valid/order-cache-specialist");
  expect((await h.run(["evaluate", "--session", id])).exitCode).toBe(0);
  expect((await record(h, id)).exitCode).toBe(0);
  return id;
}

describe("clean and discard never fail on bad artifacts (R45)", () => {
  const cleanOk = async (id: string) => {
    const r = await h.run(["clean", "--session", id]);
    expect(r.exitCode).toBe(0);
    expect(r.out.removed).toBe(true);
    expect(await exists(sessionDir(id))).toBe(false);
    return r;
  };

  it("cleans a session with a corrupt context-packet.json", async () => {
    const id = await analysed(h);
    await writeFile(join(sessionDir(id), "context-packet.json"), "{ corrupt");
    await cleanOk(id);
  });

  it("cleans a session with a corrupt evidence.json", async () => {
    const id = await analysed(h);
    await writeFile(join(sessionDir(id), "evidence.json"), '{"schemaVersion":"1","items":"x"}');
    await cleanOk(id);
  });

  it("cleans an expired session with bad evidence and archives it as timeout", async () => {
    const id = await analysed(h);
    await writeFile(join(sessionDir(id), "evidence.json"), "nope");
    h.clock.t += 2 * HOUR;
    await cleanOk(id);
    const archived = JSON.parse(await readFile(join(h.home, "reports", `${id}.json`), "utf8"));
    expect(archived.outcome).toBe("timeout");
  });

  it("cleans a session whose session.json is corrupt, with a note and no archive", async () => {
    const id = await analysed(h);
    await writeFile(join(sessionDir(id), "session.json"), "{ corrupt");
    const r = await cleanOk(id);
    expect(r.out.archived).toBe(false);
    expect(r.out.notes.join(" ")).toMatch(/session\.json could not be read/);
    expect(await exists(join(h.home, "reports", `${id}.json`))).toBe(false);
  });

  it("still reports an unknown session as SESSION_NOT_FOUND", async () => {
    const r = await h.run(["clean", "--session", "ds-20240101000000-abcdef"]);
    expect(r.out.error).toBe("SESSION_NOT_FOUND");
  });

  it("save --scope discard works with a corrupt packet", async () => {
    const id = await analysed(h);
    await writeFile(join(sessionDir(id), "context-packet.json"), "{ corrupt");
    const r = await h.runWith(["save", "--session", id, "--scope", "discard"], { probe });
    expect(r.exitCode).toBe(0);
    expect(await exists(sessionDir(id))).toBe(false);
  });

  it("an expired budget with bad evidence ends as TIMEOUT (exit 3), not INTERNAL", async () => {
    const id = await analysed(h);
    await writeFile(join(sessionDir(id), "evidence.json"), "nope");
    h.clock.t += 2 * HOUR;
    const r = await h.run(["compile", "--session", id]);
    expect(r.exitCode).toBe(3);
    expect(r.out.error).toBe("TIMEOUT");
    expect((await h.readJson(id, "session.json")).status).toBe("timeout");
  });
});

describe("clean keeps a placement another session is activating (R45)", () => {
  it("keeps a freshly refreshed placement with a note, removes an old one", async () => {
    const id = await recorded();
    const r = await h.runWith(["activate", "--session", id], { vars: NATIVE_ON });
    const dir = r.out.native.path as string;
    // Another session reuses the placement right now.
    await utimes(dir, new Date(), new Date());
    const kept = await h.run(["clean", "--session", id]);
    expect(kept.exitCode).toBe(0);
    expect(await exists(join(dir, "SKILL.md"))).toBe(true);
    expect(kept.out.notes.join(" ")).toMatch(/within the last 10 minutes/);
  });

  it("removes the placement once it is outside the grace window", async () => {
    const id = await recorded();
    const r = await h.runWith(["activate", "--session", id], { vars: NATIVE_ON });
    const dir = r.out.native.path as string;
    await utimes(dir, 1_000_000_000, 1_000_000_000);
    const gone = await h.run(["clean", "--session", id]);
    expect(gone.out.notes).toEqual([]);
    expect(await exists(dir)).toBe(false);
  });
});

describe("save --dry-run for ephemeral and discard (R45)", () => {
  for (const scope of ["discard", "ephemeral"]) {
    it(`${scope} --dry-run changes nothing`, async () => {
      const id = await recorded();
      const before = await hashTree(h.home);
      const r = await h.runWith(["save", "--session", id, "--scope", scope, "--dry-run"], {
        probe,
      });
      expect(r.exitCode).toBe(0);
      expect(r.out.dryRun).toBe(true);
      expect(await hashTree(h.home)).toEqual(before);
      expect(await exists(sessionDir(id))).toBe(true);
    });
  }
});

describe("option values and --repo", () => {
  it("init --repo --dry-run is USAGE and writes nothing", async () => {
    const before = await hashTree(h.userHome);
    const r = await h.runWith(["init", "--harness", "claude-code", "--repo", "--dry-run"], {
      probe,
    });
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("USAGE");
    expect(await hashTree(h.userHome)).toEqual(before);
  });

  it("init --repo with a nonexistent path is USAGE", async () => {
    const r = await h.runWith(["init", "--harness", "claude-code", "--repo", "no/such"], {
      probe,
    });
    expect(r.out.error).toBe("USAGE");
    expect(r.exitCode).toBe(1);
  });

  it("an option value that starts with a dash is USAGE, for any command", async () => {
    const id = await recorded();
    const r = await h.runWith(["save", "--session", "--scope=project"], { probe });
    expect(r.out.error).toBe("USAGE");
    expect(await exists(sessionDir(id))).toBe(true);
  });
});

describe("INTERNAL errors carry a fixed message (R45)", () => {
  it("does not echo artifact content", async () => {
    const id = await assess(h);
    // Not JSON: JSON.parse quotes the start of the text in its error message.
    await writeFile(join(sessionDir(id), "skills-scan.json"), "API_KEY=sk-secret-123");
    const r = await h.run(["discover", "--session", id]);
    expect(r.out.error).toBe("INTERNAL");
    expect(r.out.message).toBe("unexpected internal error; see `status`");
    expect(JSON.stringify(r.out) + r.stderr).not.toMatch(/sk-secret-123|API_KEY/);
    // A schema failure names keys and values in a ZodError.
    await writeFile(join(sessionDir(id), "skills-scan.json"), '{"API_KEY":"sk-secret-123"}');
    const z = await h.run(["discover", "--session", id]);
    expect(z.out.error).toBe("INTERNAL");
    expect(JSON.stringify(z.out) + z.stderr).not.toMatch(/sk-secret-123|API_KEY/);
  });
});

describe("save rollback removes the directories it created (R45)", () => {
  /** Saves for claude-code + codex; the first placement is real, the second one fails. */
  async function failingSecond(): Promise<Awaited<ReturnType<Harness["run"]>>> {
    const id = await recorded();
    expect((await h.runWith(["activate", "--session", id], { probe })).exitCode).toBe(0);
    let n = 0;
    hooks.place = async (input, real) => {
      if (n++ === 0) return real(input);
      throw Object.assign(new Error("boom"), { code: "EIO" });
    };
    return h.runWith(
      ["save", "--session", id, "--scope", "project", "--harness", "claude-code,codex"],
      { probe },
    );
  }

  it("leaves no .claude in a fresh repo", async () => {
    const r = await failingSecond();
    expect(r.out.error).toBe("INTERNAL");
    expect(r.out.message).toBe("unexpected internal error; see `status` (EIO)");
    expect(await readdir(h.repo)).not.toContain(".claude");
  });

  it("keeps a pre-existing empty .claude", async () => {
    await mkdir(join(h.repo, ".claude"));
    await failingSecond();
    expect(await readdir(join(h.repo, ".claude"))).toEqual([]);
  });

  it("leaves no skills directory behind a symlinked .claude", async () => {
    await mkdir(join(h.repo, "cfg"));
    await symlink("cfg", join(h.repo, ".claude"));
    await failingSecond();
    expect(await readdir(join(h.repo, "cfg"))).toEqual([]);
  });
});

describe("save --scope discard on an unreadable session (R45)", () => {
  it("removes the session; a dry run only reports", async () => {
    const id = await analysed(h);
    await writeFile(join(sessionDir(id), "session.json"), "{ corrupt");
    const dry = await h.runWith(["save", "--session", id, "--scope", "discard", "--dry-run"], {
      probe,
    });
    expect(dry.exitCode).toBe(0);
    expect(dry.out).toMatchObject({ dryRun: true, removed: false });
    expect(await exists(sessionDir(id))).toBe(true);
    const r = await h.runWith(["save", "--session", id, "--scope", "discard"], { probe });
    expect(r.exitCode).toBe(0);
    expect(r.out.removed).toBe(true);
    expect(await exists(sessionDir(id))).toBe(false);
  });

  it("another command on an unreadable session points at clean, with no content", async () => {
    const id = await analysed(h);
    await writeFile(join(sessionDir(id), "session.json"), "API_KEY=sk-secret-123");
    const r = await h.run(["compile", "--session", id]);
    expect(r.out.error).toBe("INTERNAL");
    expect(r.out.message).toMatch(/run `clean/);
    expect(JSON.stringify(r.out) + r.stderr).not.toMatch(/sk-secret-123|API_KEY/);
  });
});

describe("option values that start with a dash (R45)", () => {
  it("accepts free text and --opt=value tokens", async () => {
    const a = await h.run(["assess", "--task", "-fix the flaky test"]);
    expect(a.exitCode).toBe(0);
    const b = await h.run(["assess", "--task=--force push to a fork and add caching"]);
    expect(b.exitCode).toBe(0);
    const id = await recorded();
    const file = await h.doc("o.txt", "Plan: invalidate the cache.");
    const n = await h.run([
      "eval",
      "record",
      "--session",
      id,
      "--output",
      file,
      "--verdict",
      "fail",
      "--notes",
      "-- missing edge case",
    ]);
    expect(n.out.error).not.toBe("USAGE");
  });

  it("still refuses a value that is one of the command's own flags", async () => {
    expect((await h.run(["save", "--session", "--scope=project"])).out.error).toBe("USAGE");
    const r = await h.runWith(["init", "--harness", "claude-code", "--repo=--dry-run"], { probe });
    expect(r.out.error).toBe("USAGE");
    expect(r.out.message).toMatch(/--repo is not a directory/);
  });
});

describe("a concurrent clean cannot leave a dead placement (R45)", () => {
  it("re-places once when clean removes it between placeBundle and the refresh", async () => {
    const y = await recorded();
    const ry = await h.runWith(["activate", "--session", y], { vars: NATIVE_ON });
    const dir = ry.out.native.path as string;
    await utimes(dir, 1_000_000_000, 1_000_000_000);
    const x = await recorded();
    // `recorded` ran an assess whose sweep sees Y's reference; the placement is still there.
    expect(await exists(dir)).toBe(true);
    await utimes(dir, 1_000_000_000, 1_000_000_000);
    let fired = false;
    hooks.place = async (input, real) => {
      const placed = await real(input);
      if (!fired && input.mode === "native" && placed.action === "unchanged") {
        fired = true;
        const c = await h.run(["clean", "--session", y]);
        expect(c.exitCode).toBe(0);
        expect(await exists(dir)).toBe(false);
      }
      return placed;
    };
    const rx = await h.runWith(["activate", "--session", x], { vars: NATIVE_ON });
    expect(fired).toBe(true);
    expect(rx.exitCode).toBe(0);
    // Either an existing placement or a limitation, never a dead path.
    if (rx.out.native !== null)
      expect(await exists(join(rx.out.native.path, "SKILL.md"))).toBe(true);
    else expect(rx.out.limitations.join(" ")).toMatch(/Native registration skipped/);
  });
});

describe("timeout handling (R45)", () => {
  it("a failed report write at the deadline leaves skills/ and session.json untouched", async () => {
    const id = await recorded();
    await mkdir(join(sessionDir(id), "reports", "discovery.json"), { recursive: true });
    h.clock.t += 2 * HOUR;
    const r = await h.run(["activate", "--session", id]);
    expect(r.exitCode).toBe(1);
    expect(await exists(join(sessionDir(id), "skills"))).toBe(true);
    expect((await h.readJson(id, "session.json")).status).not.toBe("timeout");
  });

  it("an already timed-out session gets its skills/ removed again", async () => {
    const id = await recorded();
    const file = join(sessionDir(id), "session.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.status = "timeout";
    await writeFile(file, JSON.stringify(state));
    expect(await exists(join(sessionDir(id), "skills"))).toBe(true);
    const r = await h.run(["activate", "--session", id]);
    expect(r.exitCode).toBe(3);
    expect(await exists(join(sessionDir(id), "skills"))).toBe(false);
  });
});
