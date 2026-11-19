import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPlan,
  PlanApplyError,
  previewPlan,
  type InstallPlan,
  type PlannedWrite,
} from "../src/index";

let root: string;
let project: string;
let home: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sdk-apply-")));
  project = join(root, "project");
  home = join(root, "home");
  await mkdir(project);
  await mkdir(home);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const base = { committable: true, purpose: "test" };
const plan = (writes: PlannedWrite[]): InstallPlan => ({
  harness: "claude-code",
  scope: "project",
  projectRoot: project,
  writes,
  notes: [],
  verify: [],
});
const file = (path: string, content: string, within: string | null = project): PlannedWrite => ({
  ...base,
  kind: "file",
  path,
  content: Buffer.from(content),
  within,
});
const merge = (
  path: string,
  patch: Record<string, never> | object,
  kind: "json-merge" | "jsonc-merge" = "json-merge",
  within: string | null = project,
): PlannedWrite => ({ ...base, kind, path, patch, within }) as PlannedWrite;
const opts = { dryRun: false, force: false };

describe("applyPlan", () => {
  it("creates, then reports unchanged on a rerun", async () => {
    const p = plan([
      file(join(project, "a", "b.txt"), "hi"),
      { ...base, kind: "dir", path: join(project, "d"), within: project },
    ]);
    expect((await applyPlan(p, opts)).map((w) => w.action)).toEqual(["create", "create"]);
    expect((await applyPlan(p, opts)).map((w) => w.action)).toEqual(["unchanged", "unchanged"]);
    expect((await stat(join(project, "d"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(project, "a", "b.txt"))).mode & 0o777).toBe(0o644);
  });
  it("writes nothing when one of three writes conflicts", async () => {
    await writeFile(join(project, "b.txt"), "other");
    const p = plan([
      file(join(project, "a.txt"), "1"),
      file(join(project, "b.txt"), "2"),
      file(join(project, "c.txt"), "3"),
    ]);
    const r = await applyPlan(p, opts);
    // Nothing was written, so no entry may claim a create or update.
    expect(r.map((w) => w.action)).toEqual(["conflict", "conflict", "conflict"]);
    expect(r.map((w) => w.reason)).toEqual(["not applied", "differs", "not applied"]);
    expect(await readdir(project)).toEqual(["b.txt"]);
  });
  it("force updates a differing file only", async () => {
    await writeFile(join(project, "b.txt"), "other");
    const r = await applyPlan(plan([file(join(project, "b.txt"), "2")]), {
      dryRun: false,
      force: true,
    });
    expect(r[0]?.action).toBe("update");
    expect(await readFile(join(project, "b.txt"), "utf8")).toBe("2");
  });
  it("refuses a symlink at the final path even with force", async () => {
    await writeFile(join(root, "target"), "x");
    await symlink(join(root, "target"), join(project, "l.txt"));
    const r = await applyPlan(plan([file(join(project, "l.txt"), "y")]), {
      dryRun: false,
      force: true,
    });
    expect(r[0]).toMatchObject({ action: "conflict", reason: "symlink" });
    expect(await readFile(join(root, "target"), "utf8")).toBe("x");
  });
  it("never forces a merge conflict or invalid JSON", async () => {
    await writeFile(join(project, "s.json"), '{"x":1}');
    await writeFile(join(project, "bad.json"), "{nope");
    const f = { dryRun: false, force: true };
    const r = await applyPlan(
      plan([merge(join(project, "s.json"), { x: 2 }), merge(join(project, "bad.json"), { x: 2 })]),
      f,
    );
    expect(r[0]).toMatchObject({ action: "conflict" });
    expect(r[0]?.reason).toContain("x");
    expect(r[1]).toMatchObject({ action: "conflict", reason: "invalid JSON" });
    expect(await readFile(join(project, "s.json"), "utf8")).toBe('{"x":1}');
  });
  it("reports invalid JSONC", async () => {
    await writeFile(join(project, "c.jsonc"), "{ nope");
    const r = await previewPlan(plan([merge(join(project, "c.jsonc"), { a: 1 }, "jsonc-merge")]), {
      force: false,
    });
    expect(r[0]).toMatchObject({ action: "conflict", reason: "invalid JSONC" });
  });
  it("follows a symlinked parent for a personal file (within null)", async () => {
    const dotfiles = join(root, "dotfiles");
    await mkdir(dotfiles);
    await symlink(dotfiles, join(home, ".cfg"));
    const r = await applyPlan(plan([file(join(home, ".cfg", "s.txt"), "ok", null)]), opts);
    expect(r[0]?.action).toBe("create");
    expect(await readFile(join(dotfiles, "s.txt"), "utf8")).toBe("ok");
  });
  it("refuses a project write whose parent symlinks outside the project", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(project, ".claude"));
    const r = await applyPlan(plan([file(join(project, ".claude", "x.txt"), "no")]), opts);
    expect(r[0]).toMatchObject({ action: "conflict", reason: "outside project" });
    expect(await readdir(outside)).toEqual([]);
  });
  it("labels a session-home escape distinctly", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(home, "native"));
    const r = await applyPlan(plan([file(join(home, "native", "x"), "no", home)]), opts);
    expect(r[0]).toMatchObject({ action: "conflict", reason: "outside session home" });
  });
  it("rejects a non-normalised path", async () => {
    const r = await previewPlan(plan([file(join(project, "a", "..", "..", "x"), "no")]), {
      force: false,
    });
    expect(r[0]?.action).toBe("conflict");
  });
  it("detects a target modified between preview and write and writes nothing after it", async () => {
    await writeFile(join(project, "s.json"), '{"a":1}');
    const p = plan([
      merge(join(project, "s.json"), { b: 2 }),
      file(join(project, "after.txt"), "x"),
    ]);
    const r = await applyPlan(p, {
      ...opts,
      testHooks: {
        beforeWrite: async (w) => {
          if (w.path.endsWith("s.json")) await writeFile(w.path, '{"a":1,"user":true}');
        },
      },
    });
    expect(r[0]).toMatchObject({ action: "conflict", reason: "changed since preview" });
    expect(r[1]?.action).toBe("conflict");
    expect(await readFile(join(project, "s.json"), "utf8")).toBe('{"a":1,"user":true}');
    expect(await readdir(project)).not.toContain("after.txt");
  });
  it("detects a file that appears between preview and write", async () => {
    const p = plan([file(join(project, "n.txt"), "x")]);
    const r = await applyPlan(p, {
      ...opts,
      testHooks: {
        beforeWrite: async (w) => {
          await writeFile(w.path, "squatter");
        },
      },
    });
    expect(r[0]).toMatchObject({ action: "conflict", reason: "changed since preview" });
    expect(await readFile(join(project, "n.txt"), "utf8")).toBe("squatter");
  });
  it("keeps the mode of an updated file", async () => {
    const f = join(project, "settings.json");
    await writeFile(f, '{"a":1}');
    await chmod(f, 0o640);
    const r = await applyPlan(plan([merge(f, { b: 2 })]), opts);
    expect(r[0]?.action).toBe("update");
    expect((await stat(f)).mode & 0o777).toBe(0o640);
    expect(JSON.parse(await readFile(f, "utf8"))).toEqual({ a: 1, b: 2 });
    expect((await readFile(f, "utf8")).endsWith("}\n")).toBe(true);
  });
  it("preserves comments and trailing commas in JSONC and is idempotent", async () => {
    const f = join(project, "o.jsonc");
    await writeFile(f, '{\n  // keep me\n  "a": 1,\n  "list": ["x",],\n}\n');
    const p = plan([merge(f, { b: { c: 2 }, list: ["y"] }, "jsonc-merge")]);
    expect((await applyPlan(p, opts))[0]?.action).toBe("update");
    const text = await readFile(f, "utf8");
    expect(text).toContain("// keep me");
    expect(text).toContain('"a": 1');
    expect(text).toContain('"c": 2');
    expect(text).toContain('"y"');
    expect((await applyPlan(p, opts))[0]?.action).toBe("unchanged");
    expect(await readFile(f, "utf8")).toBe(text);
  });
  it("is idempotent for strict JSON and leaves no temp files", async () => {
    const f = join(project, "s.json");
    const p = plan([merge(f, { a: [1] })]);
    expect((await applyPlan(p, opts))[0]?.action).toBe("create");
    expect((await applyPlan(p, opts))[0]?.action).toBe("unchanged");
    expect((await readdir(project)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
  it("dryRun creates nothing, not even parent directories", async () => {
    const r = await applyPlan(plan([file(join(project, "deep", "er", "x.txt"), "x")]), {
      dryRun: true,
      force: false,
    });
    expect(r[0]?.action).toBe("create");
    expect(await readdir(project)).toEqual([]);
  });
  it("reports a regular file in the parent chain as a conflict", async () => {
    await writeFile(join(project, "blocker"), "file");
    const p = plan([
      file(join(project, "a.txt"), "1"),
      file(join(project, "blocker", "x.txt"), "2"),
    ]);
    const err = await applyPlan(p, opts).catch((e: unknown) => e);
    // blocker/x.txt cannot be created because blocker is a file; the preview rejects it first.
    expect(Array.isArray(err)).toBe(true);
    expect((err as { action: string }[])[1]?.action).toBe("conflict");
    expect(await readdir(project)).toEqual(["blocker"]);
  });
  it("throws PlanApplyError listing applied writes on a mid-apply failure", async () => {
    const p = plan([file(join(project, "a.txt"), "1"), file(join(project, "b.txt"), "2")]);
    const err = await applyPlan(p, {
      ...opts,
      testHooks: {
        beforeWrite: (w) => {
          if (w.path.endsWith("b.txt")) throw new Error("disk on fire");
        },
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanApplyError);
    const e = err as PlanApplyError;
    expect(e.applied.map((w) => w.path)).toEqual([join(project, "a.txt")]);
    expect(e.cause).toBeInstanceOf(Error);
  });
});

describe("directory modes and duplicate keys", () => {
  it("creates missing parents of a session-home write with 0700", async () => {
    const target = join(home, "a", "b", "c");
    const p = plan([{ ...base, kind: "dir", path: target, within: home }]);
    await applyPlan(p, opts);
    for (const d of [join(home, "a"), join(home, "a", "b"), target]) {
      expect((await stat(d)).mode & 0o777).toBe(0o700);
    }
  });
  it("creates missing parents of a project write with 0755", async () => {
    await applyPlan(plan([file(join(project, "x", "y", "f.txt"), "1")]), opts);
    expect((await stat(join(project, "x", "y"))).mode & 0o777).toBe(0o755);
  });
  it("reports a conflict for a duplicate key along a patch path", async () => {
    const f = join(project, "dup.jsonc");
    await writeFile(f, '{"permission":{"bash":{"a":"allow"},"bash":{"b":"deny"}}}');
    const r = await previewPlan(
      plan([merge(f, { permission: { bash: { "dynamic-skills *": "allow" } } }, "jsonc-merge")]),
      { force: false },
    );
    expect(r[0]).toMatchObject({ action: "conflict" });
    expect(r[0]?.reason).toContain("duplicate key");
    expect(r[0]?.reason).toContain("permission.bash");
  });
  it("ignores duplicates off the patch paths", async () => {
    const f = join(project, "dup2.jsonc");
    await writeFile(f, '{"other":{"k":1,"k":2},"permission":{}}');
    const r = await previewPlan(plan([merge(f, { permission: { x: "y" } }, "jsonc-merge")]), {
      force: false,
    });
    expect(r[0]?.action).toBe("update");
  });
});

describe("strict JSON duplicate keys", () => {
  it("reports a conflict for a duplicate patch key instead of dropping the shadowed one", async () => {
    const f = join(project, "dup.json");
    await writeFile(f, '{"env":{"A":"1","A":"2"}}');
    const r = await previewPlan(plan([merge(f, { env: { A: "1" } })]), { force: false });
    expect(r[0]).toMatchObject({ action: "conflict" });
    expect(r[0]?.reason).toContain("duplicate key");
  });
});

describe("strict JSON duplicate keys off the patch path", () => {
  it("reports a conflict for a duplicate anywhere in the file", async () => {
    const f = join(project, "off.json");
    await writeFile(f, '{"other":{"k":1,"k":2},"env":{}}');
    const r = await previewPlan(plan([merge(f, { env: { A: "1" } })]), { force: false });
    expect(r[0]).toMatchObject({ action: "conflict" });
    expect(r[0]?.reason).toContain("other.k");
  });
});
