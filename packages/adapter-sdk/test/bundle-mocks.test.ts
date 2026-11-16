import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reverse: false,
  renameError: null as string | null,
  lstatLie: null as { suffix: string; as: string } | null,
  randoms: [] as string[],
  afterRealpath: null as { suffix: string; fn: () => Promise<void> } | null,
}));

vi.mock("node:fs/promises", async (orig) => {
  const m = await orig<typeof import("node:fs/promises")>();
  return {
    ...m,
    readdir: (async (...a: Parameters<typeof m.readdir>) => {
      const r = await (m.readdir as (...x: unknown[]) => Promise<unknown[]>)(...a);
      return state.reverse ? [...r].reverse() : r;
    }) as typeof m.readdir,
    realpath: (async (p: string, ...rest: unknown[]) => {
      const r = await (m.realpath as (...x: unknown[]) => Promise<string>)(p, ...rest);
      const hook = state.afterRealpath;
      if (hook !== null && String(p).endsWith(hook.suffix)) {
        state.afterRealpath = null;
        await hook.fn();
      }
      return r;
    }) as typeof m.realpath,
    rename: async (from: string, to: string) => {
      if (state.renameError !== null) {
        throw Object.assign(new Error(state.renameError), { code: state.renameError });
      }
      return m.rename(from, to);
    },
    lstat: (async (p: string, ...rest: unknown[]) => {
      const lie = state.lstatLie;
      const target = lie !== null && String(p).endsWith(lie.suffix) ? lie.as : p;
      return (m.lstat as (...x: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof m.lstat,
  };
});

vi.mock("node:crypto", async (orig) => {
  const m = await orig<typeof import("node:crypto")>();
  return {
    ...m,
    randomBytes: ((n: number) => {
      const next = state.randoms.shift();
      return next === undefined ? m.randomBytes(n) : Buffer.from(next, "hex");
    }) as typeof m.randomBytes,
  };
});

const { BundleLayoutError, bundleManifest, placeBundle, removePlacedBundle } =
  await import("../src/index");

let root: string;
let src: string;
let project: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sdk-bundle-mock-")));
  src = join(root, "src");
  project = join(root, "project");
  await mkdir(src);
  await mkdir(project);
  await writeFile(join(src, "SKILL.md"), "---\nname: demo-skill\n---\nBody\n");
  state.reverse = false;
  state.renameError = null;
  state.lstatLie = null;
  state.randoms = [];
  state.afterRealpath = null;
});
afterEach(async () => {
  state.reverse = false;
  state.renameError = null;
  state.lstatLie = null;
  state.randoms = [];
  state.afterRealpath = null;
  await rm(root, { recursive: true, force: true });
});

const place = () =>
  placeBundle({
    srcDir: src,
    destRoot: join(project, ".skills"),
    name: "demo-skill",
    mode: "save",
    within: project,
  });

describe("bundleManifest ordering", () => {
  it("sorts paths whatever order the directory listing returns", async () => {
    for (const n of ["b.md", "a.md", "C.md", "a-b.md"]) await writeFile(join(src, n), n);
    await mkdir(join(src, "sub"));
    await writeFile(join(src, "sub", "z.md"), "z");
    await writeFile(join(src, "sub", "A.md"), "A");
    const expected = (await bundleManifest(src)).files.map((f) => f.path);
    state.reverse = true;
    const reversed = await bundleManifest(src);
    expect(reversed.files.map((f) => f.path)).toEqual(expected);
    expect(expected).toEqual([...expected].sort());
  });
});

describe("placeBundle rename failures", () => {
  it.each(["ENOTEMPTY", "ENOTDIR", "EEXIST", "EISDIR"])(
    "maps a %s rename failure to race and removes the temp copy",
    async (code) => {
      state.renameError = code;
      const r = await place();
      expect(r).toMatchObject({ action: "conflict", reason: "race" });
      expect(await readdir(join(project, ".skills"))).toEqual([]);
    },
  );

  it("rethrows any other rename failure with its code and removes the temp copy", async () => {
    state.renameError = "EACCES";
    await expect(place()).rejects.toMatchObject({ code: "EACCES" });
    expect(await readdir(join(project, ".skills"))).toEqual([]);
  });
});

describe("source file swaps", () => {
  it("refuses a FIFO that appears after the type check without hanging", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [join(src, "swapped")]);
    state.lstatLie = { suffix: "/swapped", as: join(src, "SKILL.md") };
    await expect(bundleManifest(src)).rejects.toBeInstanceOf(BundleLayoutError);
  }, 10_000);

  it("refuses a symlink that appears after the type check", async () => {
    await symlink(join(src, "SKILL.md"), join(src, "swapped"));
    state.lstatLie = { suffix: "/swapped", as: join(src, "SKILL.md") };
    await expect(bundleManifest(src)).rejects.toBeInstanceOf(BundleLayoutError);
  });
});

describe("temp-name collisions", () => {
  it("retries with a new suffix and never touches the colliding directory", async () => {
    const dest = join(project, ".skills");
    const clash = join(dest, ".demo-skill.tmp-deadbeef");
    await mkdir(clash, { recursive: true });
    await writeFile(join(clash, "keep"), "mine");
    state.randoms = ["deadbeef", "0badf00d"];
    const r = await place();
    expect(r.action).toBe("create");
    expect((await readdir(dest)).sort()).toEqual([".demo-skill.tmp-deadbeef", "demo-skill"]);
    expect(await readdir(clash)).toEqual(["keep"]);
  });

  it("gives up after a bounded number of collisions without removing anything", async () => {
    const dest = join(project, ".skills");
    const clash = join(dest, ".demo-skill.tmp-deadbeef");
    await mkdir(clash, { recursive: true });
    await writeFile(join(clash, "keep"), "mine");
    state.randoms = Array.from({ length: 50 }, () => "deadbeef");
    await expect(place()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readdir(clash)).toEqual(["keep"]);
  });
});

describe("removePlacedBundle resolved parent", () => {
  it("removes through the resolved parent even if the raw path is retargeted afterwards", async () => {
    const real1 = join(project, "real1");
    const outside = join(root, "outside");
    for (const d of [real1, outside]) {
      await mkdir(join(d, "demo-skill"), { recursive: true });
      await writeFile(join(d, "demo-skill", "SKILL.md"), "same\n");
    }
    await symlink(real1, join(project, "link"));
    const sha = (await bundleManifest(join(real1, "demo-skill"))).sha256;
    state.afterRealpath = {
      suffix: "/link",
      fn: async () => {
        await rm(join(project, "link"));
        await symlink(outside, join(project, "link"));
      },
    };
    const ok = await removePlacedBundle(join(project, "link", "demo-skill"), sha, project);
    expect(state.afterRealpath).toBeNull();
    expect(ok).toBe(true);
    expect(await readdir(real1)).toEqual([]);
    expect(await readdir(outside)).toEqual(["demo-skill"]);
  });
});
