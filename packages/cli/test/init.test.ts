/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HostProbe } from "@dynamic-skills/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, hashTree } from "./helpers";
import type { Harness as Env } from "./helpers";
import { runCli } from "../src/run";

const run = promisify(execFile);

/** Hermetic git: the developer's global ignore file must not decide the result. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: join(tmpdir(), "ds-no-such-xdg-config"),
};

/** Hooks the mocked SDK calls; tests set them to simulate edits between preview and apply. */
const hooks: { afterPreview?: () => Promise<void> } = {};

vi.mock("@dynamic-skills/adapter-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@dynamic-skills/adapter-sdk")>();
  return {
    ...real,
    previewPlan: async (...args: Parameters<typeof real.previewPlan>) => {
      const r = await real.previewPlan(...args);
      await hooks.afterPreview?.();
      return r;
    },
  };
});

interface FakeOpts {
  /** Binaries present, with the `--version` stdout each prints. */
  bins: Record<string, string>;
  /** Run `git` for real. */
  realGit?: boolean;
  /** Make `codex execpolicy check` print this for every check. */
  codexPolicy?: string;
  /** Record of every `run` call. */
  calls?: string[];
}

/** A probe that knows the listed harness binaries and `dynamic-skills`; never spawns a harness. */
function fakeProbe(o: FakeOpts): HostProbe {
  const name = (bin: string) => bin.split("/").pop() as string;
  return {
    async which(bin) {
      const n = name(bin);
      return n in o.bins || n === "dynamic-skills" || (n === "git" && o.realGit)
        ? `/fake/bin/${n}`
        : null;
    },
    async run(bin, args) {
      o.calls?.push(`${bin} ${args.join(" ")}`);
      const n = name(bin);
      if (n === "git" && o.realGit) {
        try {
          const r = await run("git", args, { env: GIT_ENV });
          return { code: 0, stdout: r.stdout, stderr: r.stderr };
        } catch (e) {
          const err = e as { code?: number; stdout?: string; stderr?: string };
          return { code: typeof err.code === "number" ? err.code : -1, stdout: "", stderr: "" };
        }
      }
      if (n in o.bins && args[0] === "--version") {
        return { code: 0, stdout: o.bins[n] as string, stderr: "" };
      }
      if (n === "codex" && args[0] === "execpolicy") {
        if (o.codexPolicy !== undefined) return { code: 0, stdout: o.codexPolicy, stderr: "" };
        const consent = args.includes("save") || args.includes("init");
        return { code: 0, stdout: consent ? "prompt" : "allow", stderr: "" };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
}

const ALL = {
  claude: "2.1.325 (Claude Code)\n",
  codex: "codex-cli 0.169.0\n",
  opencode: "2.3.0\n",
};

let h: Env;

beforeEach(async () => {
  h = await harness();
  await mkdir(join(h.repo, ".git"), { recursive: true });
  hooks.afterPreview = undefined;
});

afterEach(async () => {
  await h.cleanup();
});

const init = (args: string[], probe: FakeOpts, env: Record<string, unknown> = {}) =>
  h.runWith(["init", ...args], { probe: fakeProbe(probe), ...env });

const names = (out: any): string[] => out.harnesses.map((x: any) => x.harness);

/** Every path reported create/update exists; every path reported conflict was not created. */
async function expectReportMatchesDisk(out: any): Promise<void> {
  for (const x of out.harnesses) {
    for (const w of x.writes) {
      const there = await stat(w.path).then(
        () => true,
        () => false,
      );
      if (w.action === "create" || w.action === "update") expect(there, w.path).toBe(true);
      if (w.action === "conflict" && w.reason === "not applied") expect(there, w.path).toBe(false);
    }
  }
}

describe("init: harness selection", () => {
  it("--dry-run writes nothing, not even the session home", async () => {
    const home = join(h.tmp, "missing-home");
    const before = await hashTree(h.userHome);
    const r = await init(["--harness", "claude-code", "--dry-run"], { bins: ALL }, { home });
    expect(r.exitCode).toBe(0);
    expect(r.out.dryRun).toBe(true);
    const writes = r.out.harnesses[0].writes;
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.action).toBe("create");
    expect(r.out.harnesses[0].verify).toBeNull();
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await hashTree(h.userHome)).toEqual(before);
  });

  it("auto-detects exactly the installed harnesses", async () => {
    const r = await init(["--dry-run"], { bins: { codex: ALL.codex, opencode: ALL.opencode } });
    expect(r.exitCode).toBe(0);
    expect(names(r.out).sort()).toEqual(["codex", "opencode"]);
    expect(r.out.harnesses.find((x: any) => x.harness === "opencode").detection.version).toBe(
      "2.3.0",
    );
  });

  it("fails with HARNESS_NOT_DETECTED naming --harness when none is installed", async () => {
    const r = await init([], { bins: {} });
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("HARNESS_NOT_DETECTED");
    expect(r.out.message).toContain("--harness");
  });

  it("plans and applies an explicit harness that is not detected, with a note", async () => {
    const r = await init(["--harness", "codex"], { bins: {} });
    expect(r.exitCode).toBe(0);
    expect(r.out.harnesses[0].notes).toContain("codex not detected");
    expect(r.out.harnesses[0].detection.installed).toBe(false);
    await expect(stat(join(h.userHome, ".codex/rules/dynamic-skills.rules"))).resolves.toBeTruthy();
    expect(r.stderr).toContain("codex not detected:");
  });

  it("accepts the claude alias, de-duplicates, and rejects unknown harnesses", async () => {
    const r = await init(["--harness", "claude,claude-code,claude", "--dry-run"], { bins: ALL });
    expect(r.exitCode).toBe(0);
    expect(names(r.out)).toEqual(["claude-code"]);
    const bad = await init(["--harness", "vim"], { bins: ALL });
    expect(bad.exitCode).toBe(1);
    expect(bad.out.error).toBe("USAGE");
    expect((await init(["--harness", ""], { bins: ALL })).out.error).toBe("USAGE");
  });

  it("builds the --harness help from the registry", async () => {
    const r = await runCli(["init", "--help"], { home: h.home, cwd: h.repo, userHome: h.userHome });
    expect(r.stderr).toMatch(/--harness <list>/);
    expect(r.stderr).toContain("claude-code");
    expect(r.stderr).toContain("opencode");
  });
});

describe("init: idempotency and conflicts", () => {
  it("a second identical run has only unchanged writes", async () => {
    const args = ["--harness", "claude-code,codex,opencode"];
    const first = await init(args, { bins: ALL });
    expect(first.exitCode).toBe(0);
    const second = await init(args, { bins: ALL });
    expect(second.exitCode).toBe(0);
    for (const x of second.out.harnesses) {
      for (const w of x.writes) expect(w.action, w.path).toBe("unchanged");
    }
    expect(second.stderr).toMatch(/0 created, 0 updated, \d+ unchanged, 0 conflicts/);
  });

  it("a differing bootstrap skill conflicts for every harness and writes nothing", async () => {
    const skill = join(h.userHome, ".agents/skills/dynamic-skill-bootstrap/SKILL.md");
    await mkdir(join(skill, ".."), { recursive: true });
    await writeFile(skill, "someone else's skill\n");
    const r = await init(["--harness", "claude-code,codex"], { bins: ALL });
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("INIT_CONFLICT");
    expect(r.out.reason).toBe("conflict");
    expect(r.out.harnesses.length).toBe(2);
    await expect(stat(join(h.userHome, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(skill, "utf8")).toBe("someone else's skill\n");

    const forced = await init(["--harness", "claude-code,codex", "--force"], { bins: ALL });
    expect(forced.exitCode).toBe(0);
    const w = forced.out.harnesses
      .flatMap((x: any) => x.writes)
      .find(
        (x: any) =>
          x.path.endsWith("dynamic-skill-bootstrap/SKILL.md") && x.path.includes(".agents"),
      );
    expect(w.action).toBe("update");
  });

  it("never forces a merge conflict", async () => {
    const settings = join(h.userHome, ".claude/settings.json");
    await mkdir(join(settings, ".."), { recursive: true });
    await writeFile(settings, JSON.stringify({ env: { DYNAMIC_SKILLS_HARNESS: "other" } }));
    const r = await init(["--harness", "claude-code", "--force"], { bins: ALL });
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("INIT_CONFLICT");
    expect(r.out.reason).toBe("conflict");
    expect(JSON.parse(await readFile(settings, "utf8")).env.DYNAMIC_SKILLS_HARNESS).toBe("other");
  });

  it("explains how to resolve a changed DYNAMIC_SKILLS_HOME", async () => {
    const args = ["--harness", "claude-code"];
    expect((await init(args, { bins: ALL })).exitCode).toBe(0);
    const other = join(h.tmp, "other-home");
    await mkdir(other);
    const r = await init(args, { bins: ALL }, { home: other });
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("INIT_CONFLICT");
    expect(r.out.reason).toBe("conflict");
    expect(r.out.message).toContain("env.DYNAMIC_SKILLS_HOME");
    expect(r.out.message).toMatch(/edit or remove/i);
    expect(r.out.message).toContain("No harness file was written");
    const conflict = r.out.harnesses[0].writes.find((w: any) => w.action === "conflict");
    expect(conflict.reason).toContain("env.DYNAMIC_SKILLS_HOME");
  });

  it("reports apply-failed with the first harness's writes when a later one cannot be written", async () => {
    const dot = join(h.userHome, ".codex");
    await mkdir(dot);
    hooks.afterPreview = async () => {
      await chmod(dot, 0o500);
    };
    try {
      const r = await init(["--harness", "claude-code,codex"], { bins: ALL });
      expect(r.exitCode).toBe(1);
      expect(r.out.error).toBe("INIT_CONFLICT");
      expect(r.out.reason).toBe("apply-failed");
      const first = r.out.harnesses.find((x: any) => x.harness === "claude-code");
      expect(first.writes.filter((w: any) => w.action === "create").length).toBe(3);
      // 3 for claude-code plus the one codex write made before the failing one.
      expect(r.out.message).toContain("4 write(s) applied so far (including codex)");
      await expectReportMatchesDisk(r.out);
      await expect(stat(join(h.userHome, ".claude/settings.json"))).resolves.toBeTruthy();
    } finally {
      await chmod(dot, 0o700);
    }
  });

  it("treats any conflict from the executor as apply-failed, counting only create and update", async () => {
    const settings = join(h.userHome, ".claude/settings.json");
    let previews = 0;
    hooks.afterPreview = async () => {
      // After the CLI's own previews, edit the config so the executor's re-preview conflicts.
      if (++previews !== 2) return;
      await mkdir(join(settings, ".."), { recursive: true });
      await writeFile(settings, JSON.stringify({ env: { DYNAMIC_SKILLS_HARNESS: "other" } }));
    };
    const r = await init(["--harness", "codex,claude-code"], { bins: ALL });
    expect(r.exitCode).toBe(1);
    expect(r.out.reason).toBe("apply-failed");
    const claude = r.out.harnesses.find((x: any) => x.harness === "claude-code");
    expect(claude.writes.some((w: any) => w.action === "conflict")).toBe(true);
    expect(JSON.parse(await readFile(settings, "utf8")).env.DYNAMIC_SKILLS_HARNESS).toBe("other");
    // Only codex's three files were written; claude-code's entries are "not applied".
    expect(r.out.message).toContain("3 write(s) applied so far (including claude-code)");
    for (const w of claude.writes) {
      if (w.action === "conflict")
        expect(["not applied", "conflicts"].some((x) => w.reason.includes(x))).toBe(true);
      expect(w.action).not.toBe("create");
    }
    await expectReportMatchesDisk(r.out);
  });

  it("does not count unchanged writes as applied", async () => {
    expect((await init(["--harness", "codex"], { bins: ALL })).exitCode).toBe(0);
    const settings = join(h.userHome, ".claude/settings.json");
    let previews = 0;
    hooks.afterPreview = async () => {
      if (++previews !== 2) return;
      await mkdir(join(settings, ".."), { recursive: true });
      await writeFile(settings, JSON.stringify({ env: { DYNAMIC_SKILLS_HARNESS: "other" } }));
    };
    const r = await init(["--harness", "codex,claude-code"], { bins: ALL });
    expect(r.out.reason).toBe("apply-failed");
    const codex = r.out.harnesses.find((x: any) => x.harness === "codex");
    expect(codex.writes.every((w: any) => w.action === "unchanged")).toBe(true);
    expect(r.out.message).toContain("0 write(s) applied so far (including claude-code)");
  });
});

describe("init: options", () => {
  it("--native places the Claude Code directory and sets DYNAMIC_SKILLS_NATIVE", async () => {
    const r = await init(["--harness", "claude-code", "--native"], { bins: ALL });
    expect(r.exitCode).toBe(0);
    const home = await realpath(h.home);
    await expect(stat(join(home, "native/claude-code/.claude/skills"))).resolves.toBeTruthy();
    const settings = JSON.parse(await readFile(join(h.userHome, ".claude/settings.json"), "utf8"));
    expect(settings.env.DYNAMIC_SKILLS_NATIVE).toBe("1");
    expect(r.out.sessionHome).toBe(home);
  });

  it("--native on an adapter without native activation adds a note", async () => {
    const r = await init(["--harness", "codex", "--native", "--dry-run"], { bins: ALL });
    expect(r.exitCode).toBe(0);
    expect(r.out.harnesses[0].notes).toContain(
      "Native activation is not supported; activation reads the skill into context.",
    );
  });

  it("writes the consent rules for every harness and passes adapter notes through", async () => {
    const r = await init(["--harness", "claude-code,codex,opencode"], { bins: ALL });
    expect(r.exitCode).toBe(0);
    const claude = JSON.parse(await readFile(join(h.userHome, ".claude/settings.json"), "utf8"));
    expect(claude.permissions.ask.join("\n")).toMatch(/dynamic-skills save/);
    expect(claude.permissions.ask.join("\n")).toMatch(/dynamic-skills init/);
    const rules = await readFile(join(h.userHome, ".codex/rules/dynamic-skills.rules"), "utf8");
    expect(rules).toMatch(/pattern = \["dynamic-skills", "save"\], decision = "prompt"/);
    expect(rules).toMatch(/pattern = \["dynamic-skills", "init"\], decision = "prompt"/);
    expect(rules).not.toMatch(/decision = "allow"/);
    const oc = await readdir(join(h.userHome, ".config/opencode"));
    const cfg = oc.find((f) => f.startsWith("opencode.json"));
    expect(cfg).toBeTruthy();
    const ocText = await readFile(join(h.userHome, ".config/opencode", cfg as string), "utf8");
    expect(ocText).toContain('"dynamic-skills save *"');
    expect(ocText).toContain('"ask"');
    const codex = r.out.harnesses.find((x: any) => x.harness === "codex");
    expect(codex.notes.join("\n")).toContain("prompt rule");
    const cc = r.out.harnesses.find((x: any) => x.harness === "claude-code");
    expect(cc.notes.length).toBeGreaterThan(0);
  });

  it("--codex-allow-rule adds the allow rule; other adapters ignore it", async () => {
    const r = await init(["--harness", "claude-code,codex,opencode", "--codex-allow-rule"], {
      bins: ALL,
    });
    expect(r.exitCode).toBe(0);
    const rules = await readFile(join(h.userHome, ".codex/rules/dynamic-skills.rules"), "utf8");
    expect(rules).toMatch(/pattern = \["dynamic-skills"\], decision = "allow"/);
    const base = await init(["--harness", "claude-code,opencode"], { bins: ALL });
    for (const x of base.out.harnesses) {
      for (const w of x.writes) expect(w.action, w.path).toBe("unchanged");
    }
  });

  it("writes realpaths when the session home is reached through a symlink", async () => {
    const real = join(h.tmp, "real");
    await mkdir(real);
    await symlink(real, join(h.tmp, "alias"));
    const home = join(h.tmp, "alias/dshome");
    const r = await init(["--harness", "claude-code,opencode"], { bins: ALL }, { home });
    expect(r.exitCode).toBe(0);
    const text = await readFile(join(h.userHome, ".claude/settings.json"), "utf8");
    const realHome = join(await realpath(real), "dshome");
    expect(text).toContain(realHome);
    expect(text).not.toContain(join(h.tmp, "alias"));
    const oc = join(h.userHome, ".config/opencode");
    for (const f of await readdir(oc)) {
      if (!f.startsWith("opencode.json")) continue;
      expect(await readFile(join(oc, f), "utf8")).not.toContain(join(h.tmp, "alias"));
    }
  });
});

describe("init: git warning and verification", () => {
  async function gitProject(): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ds-init-git-")));
    await run("git", ["init", "-q", dir], { env: GIT_ENV });
    return dir;
  }

  it("warns when .claude/settings.local.json is not ignored", async () => {
    const dir = await gitProject();
    try {
      const r = await init(["--harness", "claude-code", "--scope", "project", "--repo", dir], {
        bins: ALL,
        realGit: true,
      });
      expect(r.exitCode).toBe(0);
      const warnings: string[] = r.out.harnesses[0].warnings;
      expect(
        warnings.some(
          (w) =>
            w.includes("settings.local.json") &&
            w.includes("is not ignored by git; keep it out of version control"),
        ),
      ).toBe(true);
      await writeFile(join(dir, ".gitignore"), ".claude/settings.local.json\n");
      const again = await init(["--harness", "claude-code", "--scope", "project", "--repo", dir], {
        bins: ALL,
        realGit: true,
      });
      expect(again.out.harnesses[0].warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adds no warning when the project is not a git repository (git exits 128)", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ds-init-nogit-")));
    await mkdir(join(dir, ".git"));
    try {
      // `.git` exists as an empty directory, so the project root is found but git rejects it.
      const r = await init(["--harness", "claude-code", "--scope", "project", "--repo", dir], {
        bins: ALL,
        realGit: true,
      });
      expect(r.exitCode).toBe(0);
      expect(r.out.harnesses[0].warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs git without the repository's fsmonitor", async () => {
    const calls: string[] = [];
    const r = await init(["--harness", "claude-code", "--scope", "project"], {
      bins: ALL,
      calls,
    });
    expect(r.exitCode).toBe(0);
    const git = calls.filter((c) => c.startsWith("git "));
    expect(git.length).toBeGreaterThan(0);
    for (const c of git) expect(c).toContain("-c core.fsmonitor=false");
  });

  it("reports a verification failure without failing the command", async () => {
    const r = await init(["--harness", "codex"], { bins: ALL, codexPolicy: "allow" });
    expect(r.exitCode).toBe(0);
    expect(r.out.harnesses[0].verify.ok).toBe(false);
    expect(r.stderr).toContain("verification failed");
  });

  it("reports a passing verification as ok", async () => {
    const r = await init(["--harness", "codex"], { bins: ALL });
    expect(r.out.harnesses[0].verify.ok).toBe(true);
    expect(r.stderr).not.toContain("verification failed");
  });
});

describe("program-level options before the subcommand (Ruling R31)", () => {
  for (const argv of [
    ["-V", "save", "--session", "x"],
    ["--version", "init", "--harness", "codex"],
    ["--help", "init"],
    ["-V", "status", "--session", "x"],
    ["-Vsave", "--session", "x"],
    ["--version=1", "init", "--harness", "codex"],
  ]) {
    it(`rejects ${argv.slice(0, 2).join(" ")}`, async () => {
      const calls: string[] = [];
      const before = await hashTree(h.userHome);
      const r = await h.runWith(argv, { probe: fakeProbe({ bins: ALL, calls }) });
      expect(r.exitCode).toBe(1);
      expect(r.out.error).toBe("USAGE");
      expect(calls).toEqual([]);
      expect(await hashTree(h.userHome)).toEqual(before);
      await expect(stat(join(h.userHome, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("accepts `help init --harness codex` as help only", async () => {
    const calls: string[] = [];
    const before = await hashTree(h.userHome);
    const r = await h.runWith(["help", "init", "--harness", "codex"], {
      probe: fakeProbe({ bins: ALL, calls }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.out.help).toBe(true);
    expect(calls).toEqual([]);
    expect(await hashTree(h.userHome)).toEqual(before);
    await expect(stat(join(h.userHome, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects any argument before the subcommand, not only options", async () => {
    const r = await h.run(["junk", "init"]);
    expect(r.out.error).toBe("USAGE");
  });

  it("still answers a lone -V and --help", async () => {
    const v = await h.run(["-V"]);
    expect(v.exitCode).toBe(0);
    expect(v.out.version).toBeTruthy();
    const help = await h.run(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.out.help).toBe(true);
    expect((await h.run(["-h"])).out.help).toBe(true);
  });
});
