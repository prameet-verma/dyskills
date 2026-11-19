import {
  appendFile,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { BundleLayoutError, bundleManifest, placeBundle } from "@dynamic-skills/adapter-sdk";
import type { HostProbe } from "@dynamic-skills/adapter-sdk";
import { scanExistingSkills } from "@dynamic-skills/bootstrapper";
import { SessionStore } from "@dynamic-skills/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@dynamic-skills/core";
import { ADAPTERS } from "../src/adapters";
import { discardSession } from "../src/commands/clean";
import { assertCanSave } from "../src/state-machine";
import { bundleDigest } from "../src/commands/bundle";
import { ROOT, harness, hashTree, installGolden, ready, record } from "./helpers";
import type { Harness as Env } from "./helpers";

/** Seam over the mocked SDK: a test replaces `placeBundle` for chosen calls. */
const hooks: {
  place?: (
    input: Parameters<typeof placeBundle>[0],
    real: typeof placeBundle,
    n: number,
  ) => ReturnType<typeof placeBundle>;
  calls: number;
} = { calls: 0 };

vi.mock("@dynamic-skills/adapter-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@dynamic-skills/adapter-sdk")>();
  return {
    ...real,
    placeBundle: (input: Parameters<typeof real.placeBundle>[0]) => {
      const n = hooks.calls++;
      return hooks.place ? hooks.place(input, real.placeBundle, n) : real.placeBundle(input);
    },
  };
});

const NAME = "order-cache-specialist";

/** A probe that knows all three harness binaries and never spawns anything. */
const probe: HostProbe = {
  async which(bin) {
    return `/fake/bin/${bin.split("/").pop()}`;
  },
  async run(bin, args) {
    const n = bin.split("/").pop();
    if (args[0] === "--version") {
      const v =
        n === "claude"
          ? "2.1.325 (Claude Code)\n"
          : n === "codex"
            ? "codex-cli 0.169.0\n"
            : "2.3.0\n";
      return { code: 0, stdout: v, stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  },
};

let h: Env;
beforeEach(async () => {
  h = await harness();
  await mkdir(join(h.repo, ".git"), { recursive: true });
  hooks.place = undefined;
  hooks.calls = 0;
});
afterEach(async () => {
  await chmod(join(h.repo, ".claude/skills"), 0o755).catch(() => undefined);
  await h.cleanup();
});

/** Drives a session to `activate` with the golden skill; returns the id. */
async function activated(): Promise<string> {
  const id = await ready(h);
  expect((await h.run(["compile", "--session", id])).exitCode).toBe(0);
  await installGolden(h, id, "valid/order-cache-specialist");
  expect((await h.run(["evaluate", "--session", id])).exitCode).toBe(0);
  expect((await record(h, id)).exitCode).toBe(0);
  const r = await h.run(["activate", "--session", id]);
  expect(r.exitCode).toBe(0);
  return id;
}

const sessionSkill = (id: string) => join(h.home, "sessions", id, "skills", NAME);

const save = (id: string, args: string[], vars: Record<string, string> = {}, extra = {}) =>
  h.runWith(["save", "--session", id, ...args], { probe, vars, ...extra });

const ROOTS = {
  "claude-code": ".claude/skills",
  codex: ".agents/skills",
  opencode: ".opencode/skills",
} as const;

/** Rewrites the pinned digest after a deliberate edit, so only `save` itself is under test. */
async function repin(id: string): Promise<void> {
  const file = join(h.home, "sessions", id, "session.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  state.evaluatedBundleSha256 = await bundleDigest(join(h.home, "sessions", id));
  await writeFile(file, JSON.stringify(state));
}

describe("save: project scope", () => {
  for (const [harnessId, root] of Object.entries(ROOTS)) {
    it(`saves byte-identically for ${harnessId} and is idempotent`, async () => {
      const id = await activated();
      const r = await save(id, ["--scope", "project", "--harness", harnessId]);
      expect(r.exitCode).toBe(0);
      const dest = join(await realpath(h.repo), root, NAME);
      expect(r.out).toMatchObject({ ok: true, scope: "project", skill: NAME });
      expect(r.out.saved).toEqual([
        {
          root: join(await realpath(h.repo), root),
          path: dest,
          covers: [harnessId],
          action: "create",
        },
      ]);
      const src = await bundleManifest(sessionSkill(id));
      expect(r.out.manifestSha256).toBe(src.sha256);
      expect(await bundleManifest(dest)).toEqual(src);
      expect((await stat(join(dest, "SKILL.md"))).mode & 0o777).toBe(0o644);
      const scan = await scanExistingSkills({
        repo: h.repo,
        home: h.userHome,
        vars: {},
        etcDir: h.etcDir,
      });
      expect(scan.skills.some((s) => s.name === NAME)).toBe(true);
      const again = await save(id, ["--scope", "project", "--harness", harnessId]);
      expect(again.exitCode).toBe(0);
      expect(again.out.saved[0].action).toBe("unchanged");
      // The session is untouched: still ended, no step added.
      const state = await h.readJson(id, "session.json");
      expect(state.completedSteps.at(-1)).toBe("activate");
    });
  }

  it("covers claude-code and opencode with one root, or two when opencode ignores .claude", async () => {
    const id = await activated();
    const r = await save(id, ["--scope", "project", "--harness", "claude-code,opencode"]);
    expect(r.out.saved).toHaveLength(1);
    expect(r.out.saved[0].root.endsWith(".claude/skills")).toBe(true);
    expect(r.out.saved[0].covers).toEqual(["claude-code", "opencode"]);
    await rm(join(h.repo, ".claude"), { recursive: true });
    const two = await save(id, ["--scope", "project", "--harness", "claude-code,opencode"], {
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    });
    expect(two.out.saved).toHaveLength(2);
  });

  it("--dry-run reports and writes nothing", async () => {
    const id = await activated();
    const before = await hashTree(h.repo);
    const r = await save(id, ["--scope", "project", "--harness", "claude-code", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.out.dryRun).toBe(true);
    expect(r.out.saved[0].action).toBe("create");
    expect(await hashTree(h.repo)).toEqual(before);
    await expect(stat(join(h.repo, ".claude"))).rejects.toThrow();
  });

  it("refuses a same-named different skill in another root a harness reads", async () => {
    const id = await activated();
    const other = join(h.userHome, ".agents/skills", NAME);
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "SKILL.md"), "---\nname: order-cache-specialist\n---\nOther\n");
    const r = await save(id, ["--scope", "project", "--harness", "opencode"]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatchObject({ error: "SAVE_CONFLICT", reason: "name in use" });
    expect(r.out.conflicts.some((c: string) => c.endsWith(join(".agents/skills", NAME)))).toBe(
      true,
    );
    await expect(stat(join(h.repo, ".opencode"))).rejects.toThrow();
  });

  it("refuses a bundle that names the session home or the user home", async () => {
    const id = await activated();
    const md = join(sessionSkill(id), "SKILL.md");
    const original = await readFile(md, "utf8");
    await appendFile(md, `\nNotes live in ${await realpath(h.home)}/x.\n`);
    await repin(id);
    const r = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(r.out).toMatchObject({ error: "SAVE_CONFLICT", reason: "machine path" });
    await expect(stat(join(h.repo, ".claude"))).rejects.toThrow();
    // The same for the user home reached through a symlink (the unresolved spelling).
    await writeFile(md, original);
    const link = join(h.tmp, "user-link");
    await symlink(h.userHome, link);
    await appendFile(md, `\nSee ${link}/notes.\n`);
    await repin(id);
    const r2 = await save(
      id,
      ["--scope", "project", "--harness", "claude-code"],
      {},
      {
        userHome: link,
      },
    );
    expect(r2.out).toMatchObject({ error: "SAVE_CONFLICT", reason: "machine path" });
    await expect(stat(join(h.repo, ".claude"))).rejects.toThrow();
  });

  it("refuses a .claude symlinked outside the repository", async () => {
    const id = await activated();
    const outside = join(h.tmp, "outside");
    await mkdir(outside);
    await symlink(outside, join(h.repo, ".claude"));
    const r = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(r.out).toMatchObject({ error: "SAVE_CONFLICT", reason: "outside project" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("reports SAVE_DENIED for a read-only root and leaves nothing in any root", async () => {
    if (process.getuid?.() === 0) return;
    const id = await activated();
    await mkdir(join(h.repo, ".agents/skills"), { recursive: true });
    await mkdir(join(h.repo, ".claude/skills"), { recursive: true });
    await chmod(join(h.repo, ".claude/skills"), 0o555);
    const r = await save(id, ["--scope", "project", "--harness", "codex,claude-code"]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatchObject({
      error: "SAVE_DENIED",
      message: "The host or file system denied the write; see the install guide for your host.",
    });
    expect(typeof r.out.path).toBe("string");
    for (const root of [".agents/skills", ".claude/skills"]) {
      expect(await readdir(join(h.repo, root))).toEqual([]);
    }
  });
});

describe("save: personal scope", () => {
  it("honours CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME", async () => {
    const id = await activated();
    const cfg = join(h.tmp, "claude-cfg");
    const xdg = join(h.tmp, "xdg");
    const a = await save(id, ["--scope", "personal", "--harness", "claude-code"], {
      CLAUDE_CONFIG_DIR: cfg,
    });
    expect(a.exitCode).toBe(0);
    expect(await realpath(a.out.saved[0].path)).toBe(join(await realpath(cfg), "skills", NAME));
    const b = await save(id, ["--scope", "personal", "--harness", "opencode"], {
      XDG_CONFIG_HOME: xdg,
    });
    expect(b.exitCode).toBe(0);
    expect(await realpath(b.out.saved[0].path)).toBe(
      join(await realpath(xdg), "opencode/skills", NAME),
    );
    // The repository is never touched by a personal save.
    await expect(stat(join(h.repo, ".claude"))).rejects.toThrow();
  });
});

describe("save: state and pinning", () => {
  it("refuses an augmentation with SAVE_UNSUPPORTED and leaves the base alone", async () => {
    const baseMd = await h.installBase();
    const base = await bundleManifest(join(baseMd, ".."));
    const id = await ready(h, "partial");
    await h.run(["compile", "--session", id]);
    await installGolden(h, id, "augmentation/order-caching-augment");
    expect((await h.run(["evaluate", "--session", id])).exitCode).toBe(0);
    await record(h, id);
    expect((await h.run(["activate", "--session", id])).out.kind).toBe("augmented");
    const r = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("SAVE_UNSUPPORTED");
    expect(await bundleManifest(join(baseMd, ".."))).toEqual(base);
    await expect(stat(join(h.repo, ".claude"))).rejects.toThrow();
  });

  it("is INVALID_STATE before activate", async () => {
    const id = await ready(h);
    await h.run(["compile", "--session", id]);
    await installGolden(h, id, "valid/order-cache-specialist");
    await h.run(["evaluate", "--session", id]);
    const r = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(r.out).toMatchObject({ error: "INVALID_STATE", expected: ["activate"] });
  });

  it("is BUNDLE_INVALID when SKILL.md changed after activate", async () => {
    const id = await activated();
    await appendFile(join(sessionSkill(id), "SKILL.md"), "\nEdited later.\n");
    const r = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(r.exitCode).toBe(2);
    expect(r.out.error).toBe("BUNDLE_INVALID");
    await expect(stat(join(h.repo, ".claude"))).rejects.toThrow();
  });

  it("needs a harness: USAGE without --harness or DYNAMIC_SKILLS_HARNESS", async () => {
    const id = await activated();
    const r = await save(id, ["--scope", "project"]);
    expect(r.out.error).toBe("USAGE");
    const ok = await save(id, ["--scope", "project"], { DYNAMIC_SKILLS_HARNESS: "claude-code" });
    expect(ok.exitCode).toBe(0);
  });

  it("rejects a program option before the subcommand and saves nothing (Ruling R31)", async () => {
    const id = await activated();
    const r = await h.run([
      "-V",
      "save",
      "--session",
      id,
      "--scope",
      "project",
      "--harness",
      "claude-code",
    ]);
    expect(r.out.error).toBe("USAGE");
    await expect(stat(join(h.repo, ".claude"))).rejects.toThrow();
  });

  it("failed saves never change the session or leave the lock", async () => {
    const id = await activated();
    const before = await readFile(join(h.home, "sessions", id, "session.json"), "utf8");
    await save(id, ["--scope", "project", "--harness", "nope"]);
    await save(id, ["--scope", "project", "--harness", "claude-code", "--dry-run"]);
    expect(await readFile(join(h.home, "sessions", id, "session.json"), "utf8")).toBe(before);
    const ok = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(ok.exitCode).toBe(0);
  });
});

describe("save: ephemeral and discard", () => {
  it("ephemeral writes nothing", async () => {
    const id = await activated();
    const user = await hashTree(h.userHome);
    const repo = await hashTree(h.repo);
    const r = await save(id, ["--scope", "ephemeral"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatchObject({ scope: "ephemeral", saved: [] });
    expect(r.out.sessionDir).toBe(join(h.home, "sessions", id));
    expect(r.out.notes).toEqual(["The skill stays in the session directory until clean."]);
    expect(await hashTree(h.userHome)).toEqual(user);
    expect(await hashTree(h.repo)).toEqual(repo);
  });

  it("discard archives the report and removes the session", async () => {
    const id = await activated();
    const r = await save(id, ["--scope", "discard"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatchObject({ scope: "discard", removed: true });
    expect(r.out.archived).toBe(join(h.home, "reports", `${id}.json`));
    await expect(stat(join(h.home, "sessions", id))).rejects.toThrow();
    expect((await stat(join(h.home, "reports", `${id}.json`))).isFile()).toBe(true);
  });

  it("discard works on an unfinished session, ending it like clean", async () => {
    const id = await ready(h);
    const r = await save(id, ["--scope", "discard"]);
    expect(r.exitCode).toBe(0);
    expect(r.out.removed).toBe(true);
    expect((await stat(join(h.home, "reports", `${id}.json`))).isFile()).toBe(true);
  });
});

describe("save: placement failures roll back what this call created", () => {
  /** Saves for claude-code + codex (two roots); the hook decides what the second placement does. */
  async function twoRoots(
    second: (
      input: Parameters<typeof placeBundle>[0],
      real: typeof placeBundle,
    ) => ReturnType<typeof placeBundle>,
  ) {
    const id = await activated();
    hooks.calls = 0;
    hooks.place = (input, real, n) => (n === 0 ? real(input) : second(input, real));
    const r = await save(id, ["--scope", "project", "--harness", "claude-code,codex"]);
    hooks.place = undefined;
    return r;
  }
  const none = async () => {
    for (const root of [".claude/skills", ".agents/skills"]) {
      const names = await readdir(join(h.repo, root)).catch(() => []);
      expect(names).toEqual([]);
    }
  };

  for (const code of ["EACCES", "EPERM", "EROFS"]) {
    it(`maps ${code} to SAVE_DENIED`, async () => {
      const r = await twoRoots(async () => {
        throw Object.assign(new Error("denied"), { code });
      });
      expect(r.out).toMatchObject({ error: "SAVE_DENIED" });
      expect(typeof r.out.path).toBe("string");
      await none();
    });
  }

  for (const reason of ["race", "outside project"]) {
    it(`maps a ${reason} conflict to SAVE_CONFLICT`, async () => {
      const r = await twoRoots(async (input, real) => {
        const placed = await real({ ...input, dryRun: true });
        return { ...placed, action: "conflict", reason };
      });
      expect(r.out).toMatchObject({ error: "SAVE_CONFLICT", reason });
      await none();
    });
  }

  it("maps a differs conflict to SAVE_CONFLICT with its detail", async () => {
    const r = await twoRoots(async (input, real) => {
      const placed = await real({ ...input, dryRun: true });
      return { ...placed, action: "conflict", reason: "differs", detail: "manifest differs" };
    });
    expect(r.out).toMatchObject({ error: "SAVE_CONFLICT", reason: "differs" });
    await none();
  });

  it("maps BundleLayoutError to BUNDLE_INVALID (exit 2), never INTERNAL", async () => {
    const r = await twoRoots(async () => {
      throw new BundleLayoutError("source changed while copying");
    });
    expect(r.exitCode).toBe(2);
    expect(r.out.error).toBe("BUNDLE_INVALID");
    await none();
  });

  it("rethrows an unrelated errno as INTERNAL after cleaning up", async () => {
    const r = await twoRoots(async () => {
      throw Object.assign(new Error("boom"), { code: "EIO" });
    });
    expect(r.out.error).toBe("INTERNAL");
    await none();
  });

  it("takes the bundle back when the source was edited during the save", async () => {
    const id = await activated();
    hooks.calls = 0;
    hooks.place = async (input, real) => {
      const placed = await real(input);
      await appendFile(join(input.srcDir, "SKILL.md"), "\nEdited mid-save.\n");
      return placed;
    };
    const r = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(r.out.error).toBe("BUNDLE_INVALID");
    expect(await readdir(join(h.repo, ".claude/skills")).catch(() => [])).toEqual([]);
  });

  it("takes back a bundle whose source was edited before it was placed (one root)", async () => {
    const id = await activated();
    hooks.calls = 0;
    hooks.place = async (input, real) => {
      await appendFile(join(input.srcDir, "SKILL.md"), "\nEdited before copy.\n");
      return real(input);
    };
    const r = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(r.out.error).toBe("BUNDLE_INVALID");
    expect(await readdir(join(h.repo, ".claude/skills")).catch(() => [])).toEqual([]);
  });

  it("takes back both bundles when the source is edited before the second placement", async () => {
    const r = await twoRoots(async (input, real) => {
      await appendFile(join(input.srcDir, "SKILL.md"), "\nEdited before copy.\n");
      return real(input);
    });
    expect(r.out.error).toBe("BUNDLE_INVALID");
    await none();
  });

  it("rejects a placement whose bytes differ from the evaluated ones even if the source is restored", async () => {
    const id = await activated();
    const md = join(sessionSkill(id), "SKILL.md");
    const original = await readFile(md, "utf8");
    hooks.calls = 0;
    hooks.place = async (input, real) => {
      await appendFile(join(input.srcDir, "SKILL.md"), "\nTemporary edit.\n");
      try {
        return await real(input);
      } finally {
        await writeFile(join(input.srcDir, "SKILL.md"), original);
      }
    };
    const r = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(r.out.error).toBe("BUNDLE_INVALID");
    expect(await readdir(join(h.repo, ".claude/skills")).catch(() => [])).toEqual([]);
  });

  it("does not remove an unchanged bundle it did not create", async () => {
    const id = await activated();
    expect((await save(id, ["--scope", "project", "--harness", "claude-code"])).exitCode).toBe(0);
    hooks.calls = 0;
    hooks.place = (input, real, n) =>
      n === 0
        ? real(input)
        : Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
    const r = await save(id, ["--scope", "project", "--harness", "claude-code,codex"]);
    expect(r.out.error).toBe("SAVE_DENIED");
    expect((await stat(join(h.repo, ".claude/skills", NAME))).isDirectory()).toBe(true);
  });
});

describe("discardSession", () => {
  let home: string;
  let native: string;
  beforeEach(async () => {
    home = await realpath(h.home);
    native = join(home, "native");
  });

  /** Places the golden bundle at `<dest>` and returns its manifest sha. */
  async function place(dest: string): Promise<string> {
    await mkdir(join(dest, ".."), { recursive: true });
    await cp(join(ROOT, "fixtures/skills/valid", NAME), dest, { recursive: true });
    // Old enough to be outside the R39/R45 grace window.
    await utimes(dest, 1_000_000_000, 1_000_000_000);
    return (await bundleManifest(dest)).sha256;
  }

  /** Records a native placement in an existing session's `session.json`. */
  async function reference(id: string, dir: string, sha: string): Promise<void> {
    const file = join(h.home, "sessions", id, "session.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.native = {
      harness: "claude-code",
      dir,
      manifestSha256: sha,
      placedAt: new Date(1_700_000_000_000).toISOString(),
    };
    await writeFile(file, JSON.stringify(state));
  }

  const discard = async (id: string) => {
    const store = new SessionStore(h.home);
    return discardSession(store, await store.load(id));
  };
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    );

  it("removes an unreferenced placement, archives and removes the session", async () => {
    const id = await ready(h);
    const dir = join(native, "claude-code", ".claude/skills", NAME);
    await reference(id, dir, await place(dir));
    const r = await h.run(["clean", "--session", id]);
    expect(r.exitCode).toBe(0);
    expect(await exists(dir)).toBe(false);
    expect(await exists(join(h.home, "sessions", id))).toBe(false);
  });

  it("returns the archive path or null", async () => {
    const id = await ready(h);
    expect((await discard(id)).archived).toBeNull();
    const done = await activated();
    expect((await discard(done)).archived).toBe(join(h.home, "reports", `${done}.json`));
  });

  it("keeps a placement another session references", async () => {
    const a = await ready(h);
    const b = await ready(h);
    const dir = join(native, "claude-code", ".claude/skills", NAME);
    const sha = await place(dir);
    await reference(a, dir, sha);
    await reference(b, dir, sha);
    await h.run(["clean", "--session", a]);
    expect(await exists(dir)).toBe(true);
    await h.run(["clean", "--session", b]);
    expect(await exists(dir)).toBe(false);
  });

  it("keeps a placement while another session.json is corrupt (fail safe)", async () => {
    const a = await ready(h);
    const b = await ready(h);
    const dir = join(native, "claude-code", ".claude/skills", NAME);
    await reference(a, dir, await place(dir));
    await writeFile(join(h.home, "sessions", b, "session.json"), "{ not json");
    await discard(a);
    expect(await exists(dir)).toBe(true);
    expect(await exists(join(h.home, "sessions", a))).toBe(false);
  });

  it("never removes a tampered path outside the native root", async () => {
    const id = await ready(h);
    const outside = join(h.tmp, "outside", NAME);
    await reference(id, outside, await place(outside));
    await discard(id);
    expect(await exists(join(outside, "SKILL.md"))).toBe(true);
  });

  it("never removes through `..` segments", async () => {
    const dots = await ready(h);
    await mkdir(join(native, "x"), { recursive: true });
    await writeFile(join(native, "x", "keep"), "keep");
    await writeFile(join(native, "marker"), "marker");
    await reference(dots, `${native}/x/..`, (await bundleManifest(native)).sha256);
    await discard(dots);
    expect(await exists(join(native, "marker"))).toBe(true);
    expect(await exists(join(native, "x", "keep"))).toBe(true);

    const up = await ready(h);
    const outside = join(h.tmp, "outside2", NAME);
    const sha = await place(outside);
    await reference(up, `${native}/x/../../../outside2/${NAME}`, sha);
    await discard(up);
    expect(await exists(join(outside, "SKILL.md"))).toBe(true);
  });

  it("never removes a placement whose directory is a symlink", async () => {
    const id = await ready(h);
    const target = join(h.tmp, "elsewhere", NAME);
    const sha = await place(target);
    const dir = join(native, "claude-code", ".claude/skills", NAME);
    await mkdir(join(dir, ".."), { recursive: true });
    await symlink(target, dir);
    await reference(id, dir, sha);
    await discard(id);
    expect(await exists(join(target, "SKILL.md"))).toBe(true);
  });
});

describe("discardSession: native root safety (Ruling R38)", () => {
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    );
  const sha = async (dir: string) => (await bundleManifest(dir)).sha256;
  async function reference(
    id: string,
    dir: string,
    digest: string,
    harnessId = "claude-code",
  ): Promise<void> {
    const file = join(h.home, "sessions", id, "session.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.native = {
      harness: harnessId,
      dir,
      manifestSha256: digest,
      placedAt: new Date(1_700_000_000_000).toISOString(),
    };
    await writeFile(file, JSON.stringify(state));
  }
  const seed = async (dest: string) => {
    await mkdir(join(dest, ".."), { recursive: true });
    await cp(join(ROOT, "fixtures/skills/valid", NAME), dest, { recursive: true });
    // Old enough to be outside the R39/R45 grace window.
    await utimes(dest, 1_000_000_000, 1_000_000_000);
    return sha(dest);
  };

  it("never removes a user's skill when <home>/native is a symlink", async () => {
    const id = await ready(h);
    const userSkills = join(h.tmp, "fake-user", ".claude", "skills");
    const mine = join(userSkills, NAME);
    const digest = await seed(mine);
    await symlink(userSkills, join(await realpath(h.home), "native"));
    // The recorded dir reads like a placement but resolves into the user's skills directory.
    const dir = join(await realpath(h.home), "native", NAME);
    await reference(id, dir, digest);
    const r = await h.run(["clean", "--session", id]);
    expect(r.exitCode).toBe(0);
    expect(await exists(join(mine, "SKILL.md"))).toBe(true);
    expect(r.out.notes.length).toBe(1);
    // The same with the exact placement shape, where the symlink target holds a look-alike.
    const id2 = await ready(h);
    const lookalike = join(userSkills, "claude-code/.claude/skills", NAME);
    const digest2 = await seed(lookalike);
    await reference(
      id2,
      join(await realpath(h.home), "native/claude-code/.claude/skills", NAME),
      digest2,
    );
    await h.run(["clean", "--session", id2]);
    expect(await exists(join(lookalike, "SKILL.md"))).toBe(true);
  });

  it("does not remove a path spelled differently from the placement shape", async () => {
    const native = join(await realpath(h.home), "native");
    const real = join(native, "claude-code/.claude/skills", NAME);
    const digest = await seed(real);
    const a = await ready(h);
    const b = await ready(h);
    await reference(b, real, digest);
    await reference(a, join(native, "claude-code/.claude/skills/", `/${NAME}`), digest);
    await h.run(["clean", "--session", a]);
    expect(await exists(join(real, "SKILL.md"))).toBe(true);
  });

  it("does not remove an ancestor of the placement shape", async () => {
    const native = join(await realpath(h.home), "native");
    const real = join(native, "claude-code/.claude/skills", NAME);
    await seed(real);
    const a = await ready(h);
    const skillsDir = join(native, "claude-code/.claude/skills");
    await reference(a, skillsDir, await sha(skillsDir).catch(() => "0".repeat(64)));
    await h.run(["clean", "--session", a]);
    expect(await exists(join(real, "SKILL.md"))).toBe(true);
  });

  it("keeps a placement recorded for a harness without native placement, with a note", async () => {
    const native = join(await realpath(h.home), "native");
    const real = join(native, "claude-code/.claude/skills", NAME);
    const digest = await seed(real);
    const a = await ready(h);
    await reference(a, real, digest, "codex");
    const r = await h.run(["clean", "--session", a]);
    expect(r.exitCode).toBe(0);
    expect(r.out.notes).toHaveLength(1);
    expect(await exists(join(real, "SKILL.md"))).toBe(true);
  });

  it("stays safe when the adapter's layout lookup throws", async () => {
    const native = join(await realpath(h.home), "native");
    const real = join(native, "claude-code/.claude/skills", NAME);
    const digest = await seed(real);
    const a = await ready(h);
    await reference(a, real, digest);
    const spy = vi.spyOn(ADAPTERS["claude-code"], "nativeSessionRoot").mockImplementation(() => {
      throw new Error("reads another HostEnv field");
    });
    try {
      const r = await h.run(["clean", "--session", a]);
      expect(r.exitCode).toBe(0);
      expect(r.out).toMatchObject({ removed: true });
      expect(r.out.notes).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    expect(await exists(join(real, "SKILL.md"))).toBe(true);
    expect(await exists(join(h.home, "sessions", a))).toBe(false);
  });

  it("keeps a placement reached through a symlinked directory inside native", async () => {
    const native = join(await realpath(h.home), "native");
    const behind = join(native, "other/.claude/skills", NAME);
    const digest = await seed(behind);
    await symlink(join(native, "other"), join(native, "claude-code"));
    const a = await ready(h);
    await reference(a, join(native, "claude-code/.claude/skills", NAME), digest);
    await h.run(["clean", "--session", a]);
    expect(await exists(join(behind, "SKILL.md"))).toBe(true);
  });

  it("keeps a placement when another session references something inside it", async () => {
    const native = join(await realpath(h.home), "native");
    const real = join(native, "claude-code/.claude/skills", NAME);
    const digest = await seed(real);
    const a = await ready(h);
    const b = await ready(h);
    await reference(a, real, digest);
    await reference(b, join(real, "sub"), digest);
    await h.run(["clean", "--session", a]);
    expect(await exists(join(real, "SKILL.md"))).toBe(true);
  });
});

describe("assertCanSave branches", () => {
  const base = {
    status: "completed",
    completedSteps: ["activate"],
    metrics: { outcome: "activated" },
  } as unknown as SessionState;
  const with_ = (over: Record<string, unknown>) =>
    ({
      ...base,
      ...over,
      metrics: { ...base.metrics, ...((over.metrics as object) ?? {}) },
    }) as SessionState;
  const code = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return "none";
  };

  it("accepts completed and warning with activate and activated", () => {
    expect(code(() => assertCanSave(base, "project"))).toBe("none");
    expect(code(() => assertCanSave(with_({ status: "warning" }), "personal"))).toBe("none");
  });
  it("refuses a wrong status on its own", () => {
    for (const status of ["failed", "timeout", "running"]) {
      expect(code(() => assertCanSave(with_({ status }), "project"))).toBe("INVALID_STATE");
    }
  });
  it("refuses a wrong last step on its own", () => {
    expect(code(() => assertCanSave(with_({ completedSteps: ["eval-record"] }), "project"))).toBe(
      "INVALID_STATE",
    );
    expect(code(() => assertCanSave(with_({ completedSteps: [] }), "project"))).toBe(
      "INVALID_STATE",
    );
  });
  it("refuses a wrong outcome on its own", () => {
    expect(code(() => assertCanSave(with_({ metrics: { outcome: "augmented" } }), "project"))).toBe(
      "SAVE_UNSUPPORTED",
    );
    for (const outcome of ["reused", "skipped", "failed", undefined]) {
      expect(code(() => assertCanSave(with_({ metrics: { outcome } }), "personal"))).toBe(
        "INVALID_STATE",
      );
    }
  });
  it("always allows ephemeral and discard", () => {
    const bad = with_({ status: "failed", completedSteps: [], metrics: { outcome: "failed" } });
    expect(code(() => assertCanSave(bad, "ephemeral"))).toBe("none");
    expect(code(() => assertCanSave(bad, "discard"))).toBe("none");
  });
});

describe("save: remaining guards", () => {
  it("ephemeral is allowed on an unfinished session and writes nothing", async () => {
    const id = await ready(h);
    const r = await save(id, ["--scope", "ephemeral"]);
    expect(r.exitCode).toBe(0);
    expect(r.out.saved).toEqual([]);
    expect(await h.exists(id, "session.json")).toBe(true);
  });

  it("flags the unresolved session-home spelling when it differs from the realpath", async () => {
    const id = await activated();
    const alias = join(h.tmp, "tmp-alias");
    await symlink(h.tmp, alias);
    const md = join(sessionSkill(id), "SKILL.md");
    await appendFile(md, `\nLog at ${alias}/home/x.\n`);
    await repin(id);
    // Only the unresolved spelling appears in the bundle; the home is given through the alias.
    const r = await h.runWith(
      ["save", "--session", id, "--scope", "project", "--harness", "claude-code"],
      { probe, vars: {}, home: join(alias, "home") },
    );
    expect(r.out).toMatchObject({ error: "SAVE_CONFLICT", reason: "machine path" });
  });

  it("matches a home path only at a path boundary", async () => {
    const id = await activated();
    const md = join(sessionSkill(id), "SKILL.md");
    const user = await realpath(h.userHome);
    await appendFile(md, `\nSee ${user}2/notes.\n`);
    await repin(id);
    const r = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(r.exitCode).toBe(0);
    await appendFile(md, `\nSee ${user}/notes.\n`);
    await repin(id);
    const r2 = await save(id, ["--scope", "project", "--harness", "claude-code"]);
    expect(r2.out).toMatchObject({ error: "SAVE_CONFLICT", reason: "machine path" });
  });

  it("reports an unreadable same-named directory as name in use", async () => {
    if (process.getuid?.() === 0) return;
    const id = await activated();
    const other = join(h.userHome, ".agents/skills", NAME);
    await mkdir(other, { recursive: true });
    await chmod(other, 0o000);
    try {
      const r = await save(id, ["--scope", "project", "--harness", "opencode"]);
      expect(r.out).toMatchObject({ error: "SAVE_CONFLICT", reason: "name in use" });
      expect(r.out.conflicts.some((c: string) => c.endsWith(join(".agents/skills", NAME)))).toBe(
        true,
      );
    } finally {
      await chmod(other, 0o755);
    }
  });
});
