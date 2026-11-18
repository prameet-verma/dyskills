import { mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assess, harness, installGolden, ready, record } from "./helpers";
import type { Harness } from "./helpers";

vi.mock("../src/native", async (orig) => {
  const real = await orig<typeof import("../src/native")>();
  return { ...real, sweepNativePlacements: vi.fn(real.sweepNativePlacements) };
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
    await rm(join(h.home, "sessions", id), { recursive: true });
    const next = await recorded();
    expect((await h.run(["activate", "--session", next])).exitCode).toBe(0);
    expect(await exists(dir)).toBe(false);
  });

  it("keeps it while another session.json cannot be parsed, until 25 h", async () => {
    const { id, dir } = await placed();
    await rm(join(h.home, "sessions", id), { recursive: true });
    const bad = join(h.home, "sessions", "ds-20240101000000-abcdef");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "session.json"), "{ not json");
    const next = await recorded();
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
    await assess(h);
    expect(await exists(join(odd, "SKILL.md"))).toBe(true);
  });

  it("finds placements generically, within four levels", async () => {
    const root = await nativeRoot();
    const deep = join(root, "a/b/c/some-skill");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "SKILL.md"), "---\nname: some-skill\n---\n");
    const tooDeep = join(root, "a/b/c/d/other-skill");
    await mkdir(tooDeep, { recursive: true });
    await writeFile(join(tooDeep, "SKILL.md"), "---\nname: other-skill\n---\n");
    expect(await native.sweepNativePlacements(h.home, h.clock.t)).toEqual([deep]);
    expect(await exists(join(tooDeep, "SKILL.md"))).toBe(true);
  });
});
