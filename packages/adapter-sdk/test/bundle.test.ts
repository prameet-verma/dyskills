import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLE_MAX_BYTES,
  BUNDLE_MAX_ENTRIES,
  BundleLayoutError,
  bundleManifest,
  findSaveConflicts,
  placeBundle,
  removePlacedBundle,
} from "../src/index";

let root: string;
let src: string;
let project: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sdk-bundle-")));
  src = join(root, "src");
  project = join(root, "project");
  await mkdir(join(src, "references"), { recursive: true });
  await writeFile(join(src, "SKILL.md"), "---\nname: demo-skill\n---\nBody\n");
  await writeFile(join(src, "references", "a.md"), "A\n");
  await mkdir(project);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const place = (over: Partial<Parameters<typeof placeBundle>[0]> = {}) =>
  placeBundle({
    srcDir: src,
    destRoot: join(project, ".skills"),
    name: "demo-skill",
    mode: "save",
    within: project,
    ...over,
  });

const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

describe("bundleManifest", () => {
  it("is independent of creation order and sorted", async () => {
    const other = join(root, "other");
    await mkdir(join(other, "references"), { recursive: true });
    await writeFile(join(other, "references", "a.md"), "A\n");
    await writeFile(join(other, "SKILL.md"), "---\nname: demo-skill\n---\nBody\n");
    const a = await bundleManifest(src);
    expect(await bundleManifest(other)).toEqual(a);
    expect(a.files.map((f) => f.path)).toEqual(["SKILL.md", "references/a.md"]);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when content changes", async () => {
    const a = await bundleManifest(src);
    await writeFile(join(src, "references", "a.md"), "B\n");
    expect((await bundleManifest(src)).sha256).not.toBe(a.sha256);
  });

  it("refuses a symlink, a symlinked root and a non-regular entry", async () => {
    await symlink("/etc/hosts", join(src, "link"));
    await expect(bundleManifest(src)).rejects.toBeInstanceOf(BundleLayoutError);
    await rm(join(src, "link"));
    await symlink(src, join(root, "rootlink"));
    await expect(bundleManifest(join(root, "rootlink"))).rejects.toBeInstanceOf(BundleLayoutError);
  });
});

describe("placeBundle", () => {
  it("creates, then reports unchanged, then conflicts when different", async () => {
    const first = await place();
    expect(first.action).toBe("create");
    expect(first.path).toBe(join(project, ".skills", "demo-skill"));
    expect((await bundleManifest(first.path)).sha256).toBe(first.manifest.sha256);
    expect((await place()).action).toBe("unchanged");
    await writeFile(join(first.path, "SKILL.md"), "tampered\n");
    const c = await place();
    expect(c.action).toBe("conflict");
    expect(c.reason).toBe("differs");
    expect(await readFile(join(first.path, "SKILL.md"), "utf8")).toBe("tampered\n");
  });

  it("creates a missing destRoot and leaves no temp entries", async () => {
    await place({ destRoot: join(project, "a", "b", "skills") });
    expect(await readdir(join(project, "a", "b", "skills"))).toEqual(["demo-skill"]);
  });

  it("applies save modes 0644/0755 and native modes 0600/0700", async () => {
    const s = await place();
    expect(await modeOf(join(s.path, "SKILL.md"))).toBe(0o644);
    expect(await modeOf(join(s.path, "references"))).toBe(0o755);
    expect(await modeOf(s.path)).toBe(0o755);
    const n = await place({ destRoot: join(project, "native"), mode: "native" });
    expect(await modeOf(join(n.path, "SKILL.md"))).toBe(0o600);
    expect(await modeOf(join(n.path, "references"))).toBe(0o700);
    expect(await modeOf(n.path)).toBe(0o700);
  });

  it("dry run creates nothing, not even destRoot", async () => {
    const r = await place({ dryRun: true, destRoot: join(project, "new", "skills") });
    expect(r.action).toBe("create");
    await expect(stat(join(project, "new"))).rejects.toThrow();
    expect((await place({ dryRun: true, destRoot: join(project, "new", "skills") })).action).toBe(
      "create",
    );
  });

  it("dry run reports unchanged and conflict like a real run", async () => {
    await place();
    expect((await place({ dryRun: true })).action).toBe("unchanged");
  });

  it("refuses a destRoot reached through a symlink outside `within`", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(project, "link"));
    const r = await place({ destRoot: join(project, "link", "skills") });
    expect(r).toMatchObject({ action: "conflict", reason: "outside project" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("allows a symlinked destRoot when within is null", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(project, "link"));
    const r = await place({ destRoot: join(project, "link", "skills"), within: null });
    expect(r.action).toBe("create");
    expect(await readdir(join(outside, "skills"))).toEqual(["demo-skill"]);
  });

  it("refuses a symlink at the target, even to an identical bundle", async () => {
    await mkdir(join(project, ".skills"));
    await symlink(src, join(project, ".skills", "demo-skill"));
    expect(await place()).toMatchObject({ action: "conflict", reason: "symlink" });
  });

  it("refuses a symlink inside the source bundle and leaves nothing behind", async () => {
    await symlink("/etc/hosts", join(src, "evil"));
    await expect(place()).rejects.toBeInstanceOf(BundleLayoutError);
    await expect(stat(join(project, ".skills"))).rejects.toThrow();
  });

  it("rejects names that are not skill names", async () => {
    for (const name of ["../x", "a/b", "A", "", ".hidden", "x y", "a".repeat(65)]) {
      await expect(place({ name })).rejects.toBeInstanceOf(BundleLayoutError);
    }
    expect(await readdir(project)).toEqual([]);
  });

  it("maps parent-chain failures to conflicts instead of crashing", async () => {
    await symlink(join(root, "missing"), join(project, "dangling"));
    expect(await place({ destRoot: join(project, "dangling", "skills") })).toMatchObject({
      action: "conflict",
      reason: "parent is a dangling symlink",
    });
    await symlink(join(project, "loop2"), join(project, "loop1"));
    await symlink(join(project, "loop1"), join(project, "loop2"));
    expect((await place({ destRoot: join(project, "loop1", "skills") })).action).toBe("conflict");
    await writeFile(join(project, "file"), "x");
    expect(await place({ destRoot: join(project, "file", "skills") })).toMatchObject({
      action: "conflict",
      reason: "parent is not a directory",
    });
    expect(await place({ destRoot: join(project, "file") })).toMatchObject({
      action: "conflict",
      reason: "parent is not a directory",
    });
  });

  it("reports a conflict when the target is a file", async () => {
    await mkdir(join(project, ".skills"));
    await writeFile(join(project, ".skills", "demo-skill"), "x");
    const r = await place();
    expect(r).toMatchObject({ action: "conflict", reason: "differs" });
    expect(r.detail).toMatch(/not a directory/);
  });

  it("returns conflict race and removes the temp copy when the target appears before rename", async () => {
    const dest = join(project, ".skills");
    const r = await place({
      testHooks: {
        beforeRename: async (target) => {
          await mkdir(target, { recursive: true });
          await writeFile(join(target, "SKILL.md"), "winner\n");
        },
      },
    });
    expect(r).toMatchObject({ action: "conflict", reason: "race" });
    expect(await readdir(dest)).toEqual(["demo-skill"]);
    expect(await readFile(join(dest, "demo-skill", "SKILL.md"), "utf8")).toBe("winner\n");
  });

  it("returns conflict race for a racing symlink and leaves no temp dir", async () => {
    const dest = join(project, ".skills");
    const r = await place({
      testHooks: { beforeRename: (target) => symlink(root, target) },
    });
    expect(r).toMatchObject({ action: "conflict", reason: "race" });
    expect(await readdir(dest)).toEqual(["demo-skill"]);
  });

  it("places the bundle its manifest describes even if the source changes after the copy", async () => {
    const r = await place({
      testHooks: { beforeRename: () => writeFile(join(src, "SKILL.md"), "changed\n") },
    });
    expect(r.action).toBe("create");
    expect((await bundleManifest(r.path)).sha256).toBe(r.manifest.sha256);
  });

  it("is unaffected by timestamps", async () => {
    const r = await place();
    await utimes(join(r.path, "SKILL.md"), new Date(0), new Date(0));
    expect((await place()).action).toBe("unchanged");
  });
});

describe("removePlacedBundle", () => {
  it("removes only when the manifest matches", async () => {
    const r = await place();
    expect(await removePlacedBundle(r.path, "0".repeat(64))).toBe(false);
    expect((await stat(r.path)).isDirectory()).toBe(true);
    expect(await removePlacedBundle(r.path, r.manifest.sha256)).toBe(true);
    await expect(stat(r.path)).rejects.toThrow();
    expect(await removePlacedBundle(r.path, r.manifest.sha256)).toBe(false);
  });

  it("keeps a bundle that was modified after placement and never follows a symlink", async () => {
    const r = await place();
    await writeFile(join(r.path, "extra.md"), "x");
    expect(await removePlacedBundle(r.path, r.manifest.sha256)).toBe(false);
    await rm(join(r.path, "extra.md"));
    const link = join(root, "link");
    await symlink(r.path, link);
    expect(await removePlacedBundle(link, r.manifest.sha256)).toBe(false);
    expect((await stat(r.path)).isDirectory()).toBe(true);
  });
});

describe("findSaveConflicts", () => {
  it("returns roots holding a different, non-directory or symlinked entry", async () => {
    const m = await bundleManifest(src);
    const same = join(root, "same");
    const diff = join(root, "diff");
    const file = join(root, "file");
    const link = join(root, "link");
    const none = join(root, "none");
    for (const d of [same, diff, file, link, none]) await mkdir(d);
    await place({ destRoot: same, within: null });
    await place({ destRoot: diff, within: null });
    await writeFile(join(diff, "demo-skill", "SKILL.md"), "other\n");
    await writeFile(join(file, "demo-skill"), "x");
    await symlink(src, join(link, "demo-skill"));
    const out = await findSaveConflicts({
      name: "demo-skill",
      manifestSha256: m.sha256,
      roots: [same, diff, file, link, none, join(root, "absent")],
    });
    expect(out).toEqual([
      join(diff, "demo-skill"),
      join(file, "demo-skill"),
      join(link, "demo-skill"),
    ]);
  });

  it("rejects a bad name", async () => {
    await expect(
      findSaveConflicts({ name: "../x", manifestSha256: "", roots: [root] }),
    ).rejects.toBeInstanceOf(BundleLayoutError);
  });
});

const canChmod = process.getuid?.() !== 0;

describe("placeBundle errno handling", () => {
  it.skipIf(!canChmod)("rethrows EACCES for a read-only parent of a missing destRoot", async () => {
    const ro = join(project, "ro");
    await mkdir(ro);
    await chmod(ro, 0o500);
    try {
      await expect(place({ destRoot: join(ro, "skills") })).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      await chmod(ro, 0o700);
    }
  });

  it.skipIf(!canChmod)("rethrows EACCES for a read-only existing destRoot", async () => {
    const dest = join(project, ".skills");
    await mkdir(dest);
    await chmod(dest, 0o500);
    try {
      await expect(place()).rejects.toMatchObject({ code: "EACCES" });
      expect(await readdir(dest)).toEqual([]);
    } finally {
      await chmod(dest, 0o700);
    }
  });

  it("throws BundleLayoutError, not a conflict, when the source changes before the copy", async () => {
    const dest = join(project, ".skills");
    await expect(
      place({ testHooks: { beforeCopy: () => writeFile(join(src, "SKILL.md"), "changed\n") } }),
    ).rejects.toBeInstanceOf(BundleLayoutError);
    expect(await readdir(dest)).toEqual([]);
  });
});

describe("placeBundle containment and cleanup", () => {
  it("accepts `within` given as an alias path", async () => {
    await symlink(project, join(root, "project-alias"));
    const r = await place({ within: join(root, "project-alias") });
    expect(r.action).toBe("create");
  });

  it("re-checks containment after creating destRoot", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const dest = join(project, "new", "skills");
    const r = await place({
      destRoot: dest,
      testHooks: {
        afterMkdir: async () => {
          await rm(join(project, "new"), { recursive: true });
          await symlink(outside, join(project, "new"));
        },
      },
    });
    expect(r).toMatchObject({ action: "conflict", reason: "outside project" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("keeps operating on the validated directory when an ancestor symlink is retargeted", async () => {
    const outside = join(root, "outside");
    const real1 = join(project, "real1");
    await mkdir(outside);
    await mkdir(real1);
    await symlink(real1, join(project, "link"));
    const r = await place({
      destRoot: join(project, "link", "skills"),
      testHooks: {
        beforeRename: async () => {
          await rm(join(project, "link"));
          await symlink(outside, join(project, "link"));
        },
      },
    });
    expect(r.action).toBe("create");
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(join(real1, "skills"))).toEqual(["demo-skill"]);
  });

  it("removes the temp copy when a race is found after the destRoot ancestor was retargeted", async () => {
    const outside = join(root, "outside");
    const real1 = join(project, "real1");
    await mkdir(outside);
    await mkdir(real1);
    await symlink(real1, join(project, "link"));
    const r = await place({
      destRoot: join(project, "link", "skills"),
      testHooks: {
        beforeRename: async () => {
          await mkdir(join(real1, "skills", "demo-skill"), { recursive: true });
          await rm(join(project, "link"));
          await symlink(outside, join(project, "link"));
        },
      },
    });
    expect(r).toMatchObject({ action: "conflict", reason: "race" });
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(join(real1, "skills"))).toEqual(["demo-skill"]);
  });

  it("sweeps stale temp dirs of the same name and leaves the rest", async () => {
    const dest = join(project, ".skills");
    await mkdir(dest);
    const old = join(dest, ".demo-skill.tmp-aaaaaaaa");
    const fresh = join(dest, ".demo-skill.tmp-bbbbbbbb");
    const other = join(dest, ".other-skill.tmp-cccccccc");
    const odd = join(dest, ".demo-skill.tmp-zz");
    for (const d of [old, fresh, other, odd]) {
      await mkdir(d);
      await writeFile(join(d, "x"), "x");
    }
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    for (const d of [old, other, odd]) await utimes(d, twoHoursAgo, twoHoursAgo);
    expect((await place()).action).toBe("create");
    expect((await readdir(dest)).sort()).toEqual(
      [
        ".demo-skill.tmp-bbbbbbbb",
        ".demo-skill.tmp-zz",
        ".other-skill.tmp-cccccccc",
        "demo-skill",
      ].sort(),
    );
  });

  it("does not sweep on a dry run", async () => {
    const dest = join(project, ".skills");
    await mkdir(dest);
    const old = join(dest, ".demo-skill.tmp-aaaaaaaa");
    await mkdir(old);
    await utimes(old, new Date(0), new Date(0));
    await place({ dryRun: true });
    expect(await readdir(dest)).toEqual([".demo-skill.tmp-aaaaaaaa"]);
  });
});

describe("bundle special files and caps", () => {
  it("refuses a real FIFO in the source without hanging", async () => {
    execFileSync("mkfifo", [join(src, "pipe")]);
    await expect(bundleManifest(src)).rejects.toBeInstanceOf(BundleLayoutError);
    await expect(place()).rejects.toBeInstanceOf(BundleLayoutError);
    await expect(stat(join(project, ".skills"))).rejects.toThrow();
  });

  it("enforces the entry and byte caps with a limits option", async () => {
    await expect(bundleManifest(src, { maxEntries: 2 })).rejects.toBeInstanceOf(BundleLayoutError);
    await expect(bundleManifest(src, { maxBytes: 5 })).rejects.toBeInstanceOf(BundleLayoutError);
    await expect(bundleManifest(src, { maxEntries: 3, maxBytes: 100 })).resolves.toBeDefined();
  });

  it("exposes default caps of 500 entries and 5 MB", () => {
    expect(BUNDLE_MAX_ENTRIES).toBe(500);
    expect(BUNDLE_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it("refuses a source over the default entry cap", async () => {
    for (let i = 0; i < BUNDLE_MAX_ENTRIES; i++) await writeFile(join(src, `f${i}.md`), "x");
    await expect(bundleManifest(src)).rejects.toBeInstanceOf(BundleLayoutError);
    await expect(place()).rejects.toBeInstanceOf(BundleLayoutError);
  });

  it("refuses a source over the default byte cap", async () => {
    await writeFile(join(src, "big.bin"), Buffer.alloc(BUNDLE_MAX_BYTES + 1));
    await expect(bundleManifest(src)).rejects.toBeInstanceOf(BundleLayoutError);
  });

  it("reports an oversized existing target as a conflict and a findSaveConflicts hit", async () => {
    const r = await place();
    await writeFile(join(r.path, "big.bin"), Buffer.alloc(BUNDLE_MAX_BYTES + 1));
    expect(await place()).toMatchObject({ action: "conflict", reason: "differs" });
    expect(
      await findSaveConflicts({
        name: "demo-skill",
        manifestSha256: r.manifest.sha256,
        roots: [join(project, ".skills")],
      }),
    ).toEqual([r.path]);
  });
});

describe("removePlacedBundle containment", () => {
  it("removes a bundle inside `within`", async () => {
    const r = await place();
    expect(await removePlacedBundle(r.path, r.manifest.sha256, project)).toBe(true);
    await expect(stat(r.path)).rejects.toThrow();
  });

  it("accepts `within` given as an alias", async () => {
    const r = await place();
    await symlink(project, join(root, "alias"));
    expect(await removePlacedBundle(r.path, r.manifest.sha256, join(root, "alias"))).toBe(true);
  });

  it("refuses a path outside `within`, including a sibling with a shared prefix", async () => {
    const sibling = join(root, "project2");
    await mkdir(sibling);
    const r = await place({ destRoot: join(sibling, "skills"), within: null });
    expect(await removePlacedBundle(r.path, r.manifest.sha256, project)).toBe(false);
    expect((await stat(r.path)).isDirectory()).toBe(true);
  });

  it("refuses a symlink in the parent chain that points outside", async () => {
    const outside = join(root, "outside");
    const r = await place({ destRoot: join(outside, "skills"), within: null });
    await symlink(outside, join(project, "link"));
    expect(
      await removePlacedBundle(
        join(project, "link", "skills", "demo-skill"),
        r.manifest.sha256,
        project,
      ),
    ).toBe(false);
    expect((await stat(r.path)).isDirectory()).toBe(true);
  });

  it("refuses a symlink at the path even when within is given", async () => {
    const r = await place();
    await symlink(r.path, join(project, "pointer"));
    expect(await removePlacedBundle(join(project, "pointer"), r.manifest.sha256, project)).toBe(
      false,
    );
    expect((await stat(r.path)).isDirectory()).toBe(true);
  });

  it("refuses when within does not exist", async () => {
    const r = await place();
    expect(await removePlacedBundle(r.path, r.manifest.sha256, join(root, "missing"))).toBe(false);
  });
});
