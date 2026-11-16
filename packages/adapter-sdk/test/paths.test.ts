import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInside, realpathEnsured, realpathOfPlanned } from "../src/index";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sdk-paths-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("paths", () => {
  it("realpathEnsured follows a symlinked parent and creates the leaf 0700", async () => {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    const out = await realpathEnsured(join(root, "alias", "leaf"));
    expect(out).toBe(join(root, "real", "leaf"));
    expect((await stat(out)).mode & 0o777).toBe(0o700);
  });
  it("realpathOfPlanned resolves the existing ancestor and creates nothing", async () => {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    expect(await realpathOfPlanned(join(root, "alias", "a", "b"))).toBe(
      join(root, "real", "a", "b"),
    );
    expect(await readdir(join(root, "real"))).toEqual([]);
  });
  it("isInside is exact about prefixes", () => {
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/a", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
    expect(isInside("/a/../b", "/a")).toBe(false);
  });
});
