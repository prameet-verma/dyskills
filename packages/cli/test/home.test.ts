import { mkdir, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/run";
import { assess, harness, installGolden, ready, record } from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

describe("private session home (I3)", () => {
  it("creates session data owner-only", async () => {
    const id = await assess(h);
    const dir = join(h.home, "sessions", id);
    // The harness created the home (R23): the store never changes a user-provided home's mode.
    expect((await stat(join(h.home, "sessions"))).mode & 0o777).toBe(0o700);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "session.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "skills-scan.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps compile's directories and activation's reports owner-only", async () => {
    const id = await ready(h);
    await h.run(["compile", "--session", id]);
    const dir = join(h.home, "sessions", id);
    expect((await stat(join(dir, "skills"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "evals"))).mode & 0o777).toBe(0o700);
    await installGolden(h, id, "valid/order-cache-specialist");
    await h.run(["evaluate", "--session", id]);
    await record(h, id);
    expect((await h.run(["activate", "--session", id])).exitCode).toBe(0);
    expect((await stat(join(dir, "reports"))).mode & 0o777).toBe(0o700);
    for (const f of ["performance.json", "discovery.json", "assumptions.json", "evaluation.json"]) {
      expect((await stat(join(dir, "reports", f))).mode & 0o777, f).toBe(0o600);
    }
  });

  it("refuses a symlinked home with HOME_UNSAFE, exit 1, and writes nothing", async () => {
    const target = join(h.tmp, "elsewhere");
    await mkdir(target);
    const link = join(h.tmp, "linked-home");
    await symlink(target, link);
    const r = await runCli(["assess", "--task", "x"], {
      home: link,
      cwd: h.repo,
      userHome: h.userHome,
    });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "HOME_UNSAFE" });
    expect(r.stderr).toContain("HOME_UNSAFE");
    expect(await stat(join(target, "sessions")).catch(() => null)).toBeNull();
  });

  it("checks the home before looking up a session", async () => {
    const id = await assess(h);
    const moved = join(h.tmp, "moved");
    await symlink(h.home, moved);
    const r = await runCli(["status", "--session", id], { home: moved, cwd: h.repo });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: "HOME_UNSAFE" });
    await rm(moved);
  });
});
