import {
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
    expect(await place({ destRoot: join(project, "file") })).toMatchObject({ action: "conflict" });
  });

  it("reports a conflict when the target is a file", async () => {
    await mkdir(join(project, ".skills"));
    await writeFile(join(project, ".skills", "demo-skill"), "x");
    expect((await place()).action).toBe("conflict");
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
