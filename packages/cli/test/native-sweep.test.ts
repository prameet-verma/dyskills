import {
  mkdir,
  rename,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assess, harness, installGolden, ready, record } from "./helpers";
import type { Harness } from "./helpers";

vi.mock("../src/native", async (orig) => {
  const real = await orig<typeof import("../src/native")>();
  return {
    ...real,
    placeNative: vi.fn(real.placeNative),
    sweepNativePlacements: vi.fn(real.sweepNativePlacements),
  };
});
import * as native from "../src/native";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  vi.mocked(native.sweepNativePlacements).mockClear();
  await h.cleanup();
});

const HOUR = 3_600_000;
const NATIVE_ON = { DYNAMIC_SKILLS_HARNESS: "claude-code", DYNAMIC_SKILLS_NATIVE: "1" };
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Drives a session to `eval record`. */
async function recorded(): Promise<string> {
  const id = await ready(h);
  await h.run(["compile", "--session", id]);
  await installGolden(h, id, "valid/order-cache-specialist");
  expect((await h.run(["evaluate", "--session", id])).exitCode).toBe(0);
  expect((await record(h, id)).exitCode).toBe(0);
  return id;
}

/** Activates a session with native placement and pins the directory mtime to the fake clock. */
async function placed(): Promise<{ id: string; dir: string }> {
  const id = await recorded();
  const r = await h.runWith(["activate", "--session", id], { vars: NATIVE_ON });
  expect(r.out.native).not.toBeNull();
  const dir = r.out.native.path as string;
  await utimes(dir, h.clock.t / 1000, h.clock.t / 1000);
  return { id, dir };
}

const nativeRoot = async () => join(await realpath(h.home), "native");
/** The directory where the claude-code adapter places native skills, with the R42 marker in place. */
const layout = async () => {
  const dir = join(await nativeRoot(), "claude-code/.claude/skills");
  await mkdir(dir, { recursive: true });
  await writeFile(join(await nativeRoot(), ".dynamic-skills-native"), "");
  return dir;
};

describe("native sweep at assess", () => {
  it("keeps a placement of an activated session placed 1 h ago", async () => {
    const { dir } = await placed();
    h.clock.t += HOUR;
    await assess(h);
    expect(await exists(join(dir, "SKILL.md"))).toBe(true);
  });

  it("removes it once it is older than 24 h", async () => {
    const { dir } = await placed();
    h.clock.t += 25 * HOUR;
    await assess(h);
    expect(await exists(dir)).toBe(false);
  });

  it("removes a placement whose session ended without activating", async () => {
    const { id, dir } = await placed();
    const file = join(h.home, "sessions", id, "session.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.metrics.outcome = "failed";
    await writeFile(file, JSON.stringify(state));
    h.clock.t += HOUR;
    await assess(h);
    expect(await exists(dir)).toBe(false);
  });

  it("never fails assess when the sweep throws", async () => {
    vi.mocked(native.sweepNativePlacements).mockRejectedValueOnce(new Error("sweep boom"));
    const r = await h.run(["assess", "--task", "Add caching to order reads"]);
    expect(r.exitCode).toBe(0);
    expect(r.out.ok).toBe(true);
  });
});

describe("native sweep at activate", () => {
  it("removes a placement whose session directory was deleted", async () => {
    const { id, dir } = await placed();
    // Created first: its own `assess` sweep must not be what removes the placement.
    const next = await recorded();
    await rm(join(h.home, "sessions", id), { recursive: true });
    expect(await exists(dir)).toBe(true);
    expect((await h.run(["activate", "--session", next])).exitCode).toBe(0);
    expect(await exists(dir)).toBe(false);
  });

  it("keeps it while another session.json cannot be parsed, until 25 h", async () => {
    const { id, dir } = await placed();
    const next = await recorded();
    await rm(join(h.home, "sessions", id), { recursive: true });
    const bad = join(h.home, "sessions", "ds-20240101000000-abcdef");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "session.json"), "{ not json");
    expect((await h.run(["activate", "--session", next])).exitCode).toBe(0);
    expect(await exists(join(dir, "SKILL.md"))).toBe(true);
    h.clock.t += 25 * HOUR;
    await assess(h);
    expect(await exists(dir)).toBe(false);
  });
});

describe("native sweep safety", () => {
  it("never touches an in-flight temp directory", async () => {
    const { dir } = await placed();
    const tmp = join(dir, "..", ".order-cache-specialist.tmp-deadbeef");
    await mkdir(tmp);
    await writeFile(join(tmp, "SKILL.md"), "---\nname: x\n---\n");
    // The placement itself goes (no session), the temp directory must stay.
    await rm(join(h.home, "sessions"), { recursive: true });
    await mkdir(join(h.home, "sessions"), { mode: 0o700 });
    await assess(h);
    expect(await exists(dir)).toBe(false);
    expect(await exists(join(tmp, "SKILL.md"))).toBe(true);
  });

  it("skips an in-flight temp directory at any level", async () => {
    const root = await nativeRoot();
    const inner = join(root, "a/.x.tmp-deadbeef/inner-skill");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "SKILL.md"), "---\nname: inner-skill\n---\n");
    await utimes(inner, h.clock.t / 1000, h.clock.t / 1000);
    expect(await native.sweepNativePlacements(h.home, h.clock.t)).toEqual([]);
    expect(await exists(join(inner, "SKILL.md"))).toBe(true);
  });

  it("does not follow or remove through symlinks", async () => {
    const outside = join(h.tmp, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "---\nname: outside\n---\n");
    const root = await nativeRoot();
    await mkdir(join(root, "claude-code/.claude/skills"), { recursive: true });
    await symlink(outside, join(root, "claude-code/linked"));
    await symlink(outside, join(root, "claude-code/.claude/skills/evil"));
    await symlink(outside, join(root, "top"));
    await assess(h);
    expect(await exists(join(outside, "SKILL.md"))).toBe(true);
    expect((await stat(join(root, "claude-code/linked"))).isDirectory()).toBe(true);
    expect(await exists(join(root, "top/SKILL.md"))).toBe(true);
  });

  it("does not sweep when the native directory is itself a symlink", async () => {
    const outside = join(h.tmp, "outside");
    await mkdir(join(outside, "a"), { recursive: true });
    await writeFile(join(outside, "a/SKILL.md"), "---\nname: a\n---\n");
    await mkdir(h.home, { recursive: true });
    await utimes(join(outside, "a"), h.clock.t / 1000, h.clock.t / 1000);
    await symlink(outside, join(await realpath(h.home), "native"));
    await assess(h);
    expect(await exists(join(outside, "a/SKILL.md"))).toBe(true);
  });

  it("removes nothing outside native/ for a tampered native.dir", async () => {
    const { id, dir } = await placed();
    const outside = join(h.tmp, "outside-skill");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "---\nname: outside\n---\n");
    const root = await nativeRoot();
    const file = join(h.home, "sessions", id, "session.json");
    for (const evil of [outside, `${root}/x/..`, `${root}/x/../../outside-skill`, "/"]) {
      const state = JSON.parse(await readFile(file, "utf8"));
      state.native.dir = evil;
      await writeFile(file, JSON.stringify(state));
      await assess(h);
      expect(await exists(join(outside, "SKILL.md"))).toBe(true);
      expect(await exists(root)).toBe(true);
      expect(await exists(h.home)).toBe(true);
    }
    // The real placement lost its reference, so it is the only thing the sweep may take.
    expect(await exists(dir)).toBe(false);
  });

  it("leaves a directory whose name is not a skill name (contained removal)", async () => {
    const root = await nativeRoot();
    const odd = join(root, "claude-code/.claude/skills/Bad_Name");
    await mkdir(odd, { recursive: true });
    await writeFile(join(odd, "SKILL.md"), "---\nname: bad\n---\n");
    await utimes(odd, h.clock.t / 1000, h.clock.t / 1000);
    await assess(h);
    expect(await exists(join(odd, "SKILL.md"))).toBe(true);
  });

  it("sweeps only direct children of an adapter layout (R42)", async () => {
    const lay = await layout();
    const root = await nativeRoot();
    const mk = async (dir: string, name: string) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
      await utimes(dir, h.clock.t / 1000, h.clock.t / 1000);
      return dir;
    };
    const inLayout = await mk(join(lay, "some-skill"), "some-skill");
    const user = await mk(join(root, "skills/release-notes"), "release-notes");
    const nested = await mk(join(lay, "a/other-skill"), "other-skill");
    const sibling = await mk(join(root, "claude-code/other-skill"), "other-skill");
    expect(await native.sweepNativePlacements(h.home, h.clock.t)).toEqual([inLayout]);
    for (const d of [user, nested, sibling]) expect(await exists(join(d, "SKILL.md"))).toBe(true);
  });

  it("removes nothing without the marker file (R42)", async () => {
    const lay = await layout();
    await rm(join(await nativeRoot(), ".dynamic-skills-native"));
    const dir = join(lay, "some-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: some-skill\n---\n");
    await utimes(dir, h.clock.t / 1000, h.clock.t / 1000);
    expect(await native.sweepNativePlacements(h.home, h.clock.t)).toEqual([]);
    expect(await exists(join(dir, "SKILL.md"))).toBe(true);
    // A marker that is a directory is not a marker.
    await mkdir(join(await nativeRoot(), ".dynamic-skills-native"));
    expect(await native.sweepNativePlacements(h.home, h.clock.t)).toEqual([]);
  });

  it("placeNative creates the marker on the first placement", async () => {
    await placed();
    const marker = join(await nativeRoot(), ".dynamic-skills-native");
    expect((await stat(marker)).isFile()).toBe(true);
  });

  it("never deletes a user's skill when DYNAMIC_SKILLS_HOME is the user's home (R42)", async () => {
    const userHome = await realpath(h.userHome);
    const mine = join(userHome, "native/skills/release-notes");
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, "SKILL.md"), "---\nname: release-notes\n---\n");
    await utimes(mine, 1_000_000_000, 1_000_000_000);
    const r = await h.runWith(["assess", "--task", "Add caching to order reads"], {
      home: userHome,
    });
    expect(r.exitCode).toBe(0);
    expect(await exists(join(mine, "SKILL.md"))).toBe(true);
  });

  it("treats a relative DYNAMIC_SKILLS_HOME as unset (R42)", async () => {
    // A value relative to the process working directory that names a home holding a stray layout.
    const stray = join(h.tmp, "relhome/native/claude-code/.claude/skills/some-skill");
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, "SKILL.md"), "---\nname: some-skill\n---\n");
    await writeFile(join(h.tmp, "relhome/native/.dynamic-skills-native"), "");
    await utimes(stray, 1_000_000_000, 1_000_000_000);
    const rel = relative(process.cwd(), join(h.tmp, "relhome"));
    expect(isAbsolute(rel)).toBe(false);
    const r = await h.runWith(["assess", "--task", "Add caching to order reads"], {
      home: undefined,
      vars: { DYNAMIC_SKILLS_HOME: rel },
    });
    expect(r.exitCode).toBe(0);
    expect(await exists(join(stray, "SKILL.md"))).toBe(true);
    expect(await exists(join(h.tmp, "relhome/sessions"))).toBe(false);
    // The session went to the default home under the OS temp directory.
    await rm(
      join(tmpdir(), `dynamic-skills-${process.getuid?.() ?? "user"}`, "sessions", r.out.sessionId),
      {
        recursive: true,
        force: true,
      },
    );
  });

  it("removes a crash-orphaned temp directory older than the SDK threshold, in layouts only (R42)", async () => {
    const lay = await layout();
    const root = await nativeRoot();
    const old = join(lay, ".some-skill.tmp-deadbeef");
    const young = join(lay, ".other-skill.tmp-deadbeef");
    const outside = join(root, "skills/.some-skill.tmp-deadbeef");
    for (const d of [old, young, outside]) await mkdir(join(d, "x"), { recursive: true });
    const stale = new Date(Date.now() - 2 * HOUR);
    await utimes(old, stale, stale);
    await utimes(outside, stale, stale);
    await native.sweepNativePlacements(h.home, h.clock.t);
    expect(await exists(old)).toBe(false);
    expect(await exists(young)).toBe(true);
    expect(await exists(outside)).toBe(true);
  });

  it("does not remove a stale temp directory behind a symlinked layout (R42)", async () => {
    const root = await nativeRoot();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".dynamic-skills-native"), "");
    const outside = join(h.tmp, "elsewhere");
    const tmpDir = join(outside, ".some-skill.tmp-deadbeef");
    await mkdir(join(tmpDir, "x"), { recursive: true });
    const stale = new Date(Date.now() - 2 * HOUR);
    await utimes(tmpDir, stale, stale);
    await mkdir(join(root, "claude-code/.claude"), { recursive: true });
    await symlink(outside, join(root, "claude-code/.claude/skills"));
    await native.sweepNativePlacements(h.home, h.clock.t);
    expect(await exists(tmpDir)).toBe(true);
  });

  it("re-checks the layout before removing a stale temp directory (R42)", async () => {
    const lay = await layout();
    const tmpDir = join(lay, ".some-skill.tmp-deadbeef");
    await mkdir(join(tmpDir, "x"), { recursive: true });
    const stale = new Date(Date.now() - 2 * HOUR);
    await utimes(tmpDir, stale, stale);
    const outside = join(h.tmp, "moved-layout");
    await native.sweepNativePlacements(h.home, h.clock.t, {
      // The layout is swapped for a symlink after the listing.
      beforeRemoveTemp: async () => {
        await rename(lay, outside);
        await symlink(outside, lay);
      },
    });
    expect(await exists(join(outside, ".some-skill.tmp-deadbeef/x"))).toBe(true);
  });

  it("re-checks the mtime right before removal (R45)", async () => {
    const lay = await layout();
    const dir = join(lay, "some-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: some-skill\n---\n");
    await utimes(dir, 1_000_000_000, 1_000_000_000);
    const removed = await native.sweepNativePlacements(h.home, h.clock.t, {
      // Another session reuses the placement after it was selected.
      beforeRemove: () => utimes(dir, new Date(), new Date()),
    });
    expect(removed).toEqual([]);
    expect(await exists(join(dir, "SKILL.md"))).toBe(true);
  });
});

describe("native sweep grace, home safety and limits", () => {
  it("keeps a fresh placement even when no session references it yet (R39)", async () => {
    const fresh = join(await layout(), "fresh-skill");
    await mkdir(fresh, { recursive: true });
    await writeFile(join(fresh, "SKILL.md"), "---\nname: fresh-skill\n---\n");
    expect(await native.sweepNativePlacements(h.home, h.clock.t)).toEqual([]);
    expect(await exists(join(fresh, "SKILL.md"))).toBe(true);
    // A future-dated mtime must not keep it forever.
    const future = new Date(Date.now() + 5 * HOUR);
    await utimes(fresh, future, future);
    expect(await native.sweepNativePlacements(h.home, h.clock.t)).toEqual([fresh]);
  });

  it("keeps a fresh placement whose mtime is slightly ahead (clock skew)", async () => {
    const fresh = join(await layout(), "skewed-skill");
    await mkdir(fresh, { recursive: true });
    await writeFile(join(fresh, "SKILL.md"), "---\nname: skewed-skill\n---\n");
    const ahead = new Date(Date.now() + 5_000);
    await utimes(fresh, ahead, ahead);
    expect(await native.sweepNativePlacements(h.home, h.clock.t)).toEqual([]);
    const far = new Date(Date.now() + 2 * HOUR);
    await utimes(fresh, far, far);
    expect(await native.sweepNativePlacements(h.home, h.clock.t)).toEqual([fresh]);
  });

  it("survives a sweep that runs between placement and save", async () => {
    const real = await vi.importActual<typeof import("../src/native")>("../src/native");
    const id = await recorded();
    vi.mocked(native.placeNative).mockImplementationOnce(async (input) => {
      const r = await real.placeNative(input);
      // Another session's sweep, before this session saved its reference.
      await real.sweepNativePlacements(h.home, h.clock.t);
      return r;
    });
    const r = await h.runWith(["activate", "--session", id], { vars: NATIVE_ON });
    expect(r.out.native).not.toBeNull();
    expect(await exists(join(r.out.native.path, "SKILL.md"))).toBe(true);
    expect((await h.readJson(id, "session.json")).native.dir).toBe(r.out.native.path);
  });

  it("does not sweep before a symlinked session home is rejected", async () => {
    const target = join(h.tmp, "target");
    const skill = join(target, "native/claude-code/.claude/skills/some-skill");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: some-skill\n---\n");
    await utimes(skill, h.clock.t / 1000, h.clock.t / 1000);
    const link = join(h.tmp, "linked-home");
    await symlink(target, link);
    const r = await h.runWith(["assess", "--task", "Add caching to order reads"], { home: link });
    expect(r.out.error).toBe("HOME_UNSAFE");
    expect(await exists(join(skill, "SKILL.md"))).toBe(true);
  });

  it("stops at the wall-clock budget and at the directory cap", async () => {
    const dir = join(await layout(), "some-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: some-skill\n---\n");
    await utimes(dir, h.clock.t / 1000, h.clock.t / 1000);
    expect(await native.sweepNativePlacements(h.home, h.clock.t, { budgetMs: 0 })).toEqual([]);
    expect(await native.sweepNativePlacements(h.home, h.clock.t, { maxDirs: 0 })).toEqual([]);
    expect(await exists(join(dir, "SKILL.md"))).toBe(true);
    expect(await native.sweepNativePlacements(h.home, h.clock.t)).toEqual([dir]);
  });
});
