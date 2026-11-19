/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdir, readFile, readdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
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
    // The session is not read: `--session` swallowed the next flag, so it must not be looked up.
    const r2 = await h.runWith(["status", "--session", "-x"], { probe });
    expect(r2.stderr).toMatch(/USAGE/);
    const r3 = await h.run(["assess", "--task", "--explicit"]);
    expect(r3.out.error).toBe("USAGE");
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
  it("rmdirs up to createdRoot, stops at a non-empty directory", async () => {
    const id = await recorded();
    expect((await h.runWith(["activate", "--session", id], { probe })).exitCode).toBe(0);
    const claude = join(h.repo, ".claude");
    let n = 0;
    hooks.place = async (input, real) => {
      if (n++ === 0) {
        const placed = await real(input);
        return { ...placed, createdRoot: await realpath(claude) } as any;
      }
      throw Object.assign(new Error("boom"), { code: "EIO" });
    };
    const r = await h.runWith(
      ["save", "--session", id, "--scope", "project", "--harness", "claude-code,codex"],
      { probe },
    );
    expect(r.out.error).toBe("INTERNAL");
    expect(await exists(claude)).toBe(false);
    expect(await readdir(h.repo)).not.toContain(".claude");
  });
});
