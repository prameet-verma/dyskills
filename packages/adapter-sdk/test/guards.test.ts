import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan, previewPlan, type InstallPlan, type PlannedWrite } from "../src/index";

let root: string;
let project: string;
let outside: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sdk-guards-")));
  project = join(root, "project");
  outside = join(root, "outside");
  await mkdir(project);
  await mkdir(outside);
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
const file = (path: string, content = "x", within: string | null = project): PlannedWrite => ({
  ...base,
  kind: "file",
  path,
  content: Buffer.from(content),
  within,
});
const opts = { dryRun: false, force: false };

describe("parent resolution", () => {
  for (const within of [true, false]) {
    it(`flags a dangling symlink in the parent chain (within ${within ? "set" : "null"})`, async () => {
      await symlink(join(root, "missing"), join(project, ".claude"));
      const r = await previewPlan(
        plan([file(join(project, ".claude", "x.txt"), "x", within ? project : null)]),
        { force: false },
      );
      expect(r[0]).toMatchObject({ action: "conflict", reason: "parent is a dangling symlink" });
    });
    it(`flags a regular file in the parent chain (within ${within ? "set" : "null"})`, async () => {
      await writeFile(join(project, "blocker"), "f");
      const r = await previewPlan(
        plan([file(join(project, "blocker", "a", "x.txt"), "x", within ? project : null)]),
        { force: false },
      );
      expect(r[0]).toMatchObject({ action: "conflict", reason: "parent is not a directory" });
    });
  }
  it("applies nothing when a later write has a dangling parent", async () => {
    await symlink(join(root, "missing"), join(project, ".claude"));
    const r = await applyPlan(
      plan([file(join(project, "a.txt")), file(join(project, ".claude", "x.txt"), "x", null)]),
      opts,
    );
    expect(r[1]?.action).toBe("conflict");
    expect(await readdir(project)).toEqual([".claude"]);
  });
});

describe("containment swaps", () => {
  it("catches a parent swapped for an outside symlink after preview", async () => {
    await mkdir(join(project, ".claude"));
    const p = plan([file(join(project, ".claude", "x.txt"))]);
    const r = await applyPlan(p, {
      ...opts,
      beforeWrite: async () => {
        await rm(join(project, ".claude"), { recursive: true });
        await symlink(outside, join(project, ".claude"));
      },
    });
    expect(r[0]).toMatchObject({ action: "conflict", reason: "outside project" });
    expect(await readdir(outside)).toEqual([]);
  });
  it("catches a parent swapped after the staleness recheck", async () => {
    await mkdir(join(project, ".claude"));
    const p = plan([file(join(project, ".claude", "x.txt"))]);
    const r = await applyPlan(p, {
      ...opts,
      afterCheck: async () => {
        await rm(join(project, ".claude"), { recursive: true });
        await symlink(outside, join(project, ".claude"));
      },
    });
    expect(r[0]).toMatchObject({ action: "conflict", reason: "outside project" });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("path guards", () => {
  it("rejects a non-normalised path that still resolves inside the project", async () => {
    const r = await previewPlan(plan([file(`${project}/a/../b.txt`)]), { force: false });
    expect(r[0]?.action).toBe("conflict");
    expect(r[0]?.reason).toContain("normalised");
  });
  it("refuses a dir write whose final path is a symlink", async () => {
    await symlink(outside, join(project, "d"));
    const r = await previewPlan(
      plan([{ ...base, kind: "dir", path: join(project, "d"), within: project }]),
      { force: false },
    );
    expect(r[0]).toMatchObject({ action: "conflict", reason: "symlink" });
  });
  it("flags the same path planned twice", async () => {
    const r = await previewPlan(plan([file(join(project, "a")), file(join(project, "a"))]), {
      force: false,
    });
    expect(r.map((w) => w.action)).toEqual(["create", "conflict"]);
    expect(r[1]?.reason).toBe("path planned twice");
  });
});

describe("depth", () => {
  it("maps a pathologically nested config to a conflict", async () => {
    const n = 200_000;
    await writeFile(join(project, "s.json"), "[".repeat(n) + "]".repeat(n));
    const r = await previewPlan(
      plan([
        {
          ...base,
          kind: "json-merge",
          path: join(project, "s.json"),
          patch: { a: 1 },
          within: project,
        },
      ]),
      { force: false },
    );
    expect(r[0]).toMatchObject({ action: "conflict" });
  });
  it("maps a deeply nested patch to a conflict", async () => {
    let patch: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 5000; i++) patch = { k: patch };
    await writeFile(join(project, "s.json"), '{"k":{}}');
    const r = await previewPlan(
      plan([
        {
          ...base,
          kind: "json-merge",
          path: join(project, "s.json"),
          patch: patch as never,
          within: project,
        },
      ]),
      { force: false },
    );
    expect(r[0]).toMatchObject({ action: "conflict", reason: "too deeply nested" });
  });
});

describe("jsonc arrays", () => {
  it("appends to an array without losing comments inside it", async () => {
    const f = join(project, "o.jsonc");
    await writeFile(f, '{\n  "list": [\n    // first\n    "a", // trailing\n    "b"\n  ]\n}\n');
    await applyPlan(
      plan([
        { ...base, kind: "jsonc-merge", path: f, patch: { list: ["b", "c"] }, within: project },
      ]),
      opts,
    );
    const text = await readFile(f, "utf8");
    expect(text).toContain("// first");
    expect(text).toContain("// trailing");
    expect(text).toContain('"c"');
  });
});

describe("rename-time recheck", () => {
  it("catches a change made after the temp file is written", async () => {
    const f = join(project, "s.json");
    await writeFile(f, '{"a":1}');
    const p = plan([{ ...base, kind: "json-merge", path: f, patch: { b: 2 }, within: project }]);
    const r = await applyPlan(p, {
      ...opts,
      beforeRename: async () => {
        await writeFile(f, '{"a":1,"u":1}');
      },
    });
    expect(r[0]).toMatchObject({ action: "conflict", reason: "changed since preview" });
    expect(await readFile(f, "utf8")).toBe('{"a":1,"u":1}');
    expect((await readdir(project)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
  it("catches a file that appears after the temp file is written", async () => {
    const f = join(project, "n.txt");
    const r = await applyPlan(plan([file(f)]), {
      ...opts,
      beforeRename: async () => {
        await writeFile(f, "squatter");
      },
    });
    expect(r[0]).toMatchObject({ action: "conflict", reason: "changed since preview" });
    expect(await readFile(f, "utf8")).toBe("squatter");
  });
});

describe("hard links", () => {
  it("breaks the link on update and leaves the other name untouched", async () => {
    const a = join(project, "a.json");
    await writeFile(a, '{"a":1}');
    await link(a, join(project, "b.json"));
    await applyPlan(
      plan([{ ...base, kind: "json-merge", path: a, patch: { n: 1 }, within: project }]),
      opts,
    );
    expect(await readFile(join(project, "b.json"), "utf8")).toBe('{"a":1}');
    expect((await stat(a)).nlink).toBe(1);
  });
});
