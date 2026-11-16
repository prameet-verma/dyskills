import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHostEnv, resolveEtcDir } from "../src/host";
import { runCli } from "../src/run";
import { UnsafeHomeError } from "@dynamic-skills/core";
import { CliError } from "../src/io";
import { bundleDigest } from "../src/commands/bundle";
import { createHostProbe } from "@dynamic-skills/adapter-sdk";
import { ROOT, assess, harness, ready, installGolden, takeEtcViolations } from "./helpers";
import type { Harness } from "./helpers";

let t: string;
beforeEach(async () => {
  t = await realpath(await mkdtemp(join(tmpdir(), "ds-host-")));
});
afterEach(() => rm(t, { recursive: true, force: true }));

const input = (over: Record<string, unknown> = {}) => ({
  repo: join(t, "repo"),
  userHome: join(t, "user"),
  home: join(t, "alias/dshome"),
  vars: {},
  probe: createHostProbe({}),
  etcDir: join(t, "etc"),
  ...over,
});

async function layout(): Promise<void> {
  await mkdir(join(t, "repo/.git"), { recursive: true });
  await mkdir(join(t, "repo/pkg/deep"), { recursive: true });
  await mkdir(join(t, "user"), { recursive: true });
  await mkdir(join(t, "real"), { recursive: true });
  await symlink(join(t, "real"), join(t, "alias"));
}

describe("buildHostEnv", () => {
  it("resolves the session home through an aliased parent and creates it", async () => {
    await layout();
    const env = await buildHostEnv(input());
    expect(env.sessionHome).toBe(join(t, "real/dshome"));
    expect((await stat(env.sessionHome)).isDirectory()).toBe(true);
  });

  it("finds the .git ancestor as the project root and passes etcDir and vars through", async () => {
    await layout();
    const vars = { CODEX_HOME: "/x" };
    const env = await buildHostEnv(input({ repo: join(t, "repo/pkg/deep"), vars }));
    expect(env.projectRoot).toBe(join(t, "repo"));
    expect(env.userHome).toBe(join(t, "user"));
    expect(env.etcDir).toBe(join(t, "etc"));
    expect(env.vars).toBe(vars);
  });

  it("dry-run resolves the same value and creates nothing", async () => {
    await layout();
    const env = await buildHostEnv(input({ dryRun: true }));
    expect(env.sessionHome).toBe(join(t, "real/dshome"));
    expect(await readdir(join(t, "real"))).toEqual([]);
  });

  it("dry-run maps a dangling link in the home chain to a CliError", async () => {
    await layout();
    await symlink(join(t, "nowhere"), join(t, "dangling"));
    const err = await buildHostEnv(input({ dryRun: true, home: join(t, "dangling/h") })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("HOME_UNSAFE");
  });

  it("dry-run maps a symlink loop and a file-in-the-way to a CliError", async () => {
    await layout();
    await symlink(join(t, "loop2"), join(t, "loop1"));
    await symlink(join(t, "loop1"), join(t, "loop2"));
    await writeFile(join(t, "afile"), "x");
    for (const home of [join(t, "loop1/h"), join(t, "afile/h")]) {
      const err = await buildHostEnv(input({ dryRun: true, home })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("HOME_UNSAFE");
    }
  });

  it("resolves a relative home the same way in dry-run and for real", async () => {
    await layout();
    const before = process.cwd();
    process.chdir(join(t, "real"));
    try {
      const dry = await buildHostEnv(input({ dryRun: true, home: "rel-home/x" }));
      const real = await buildHostEnv(input({ home: "rel-home/x" }));
      expect(dry.sessionHome).toBe(join(t, "real/rel-home/x"));
      expect(real.sessionHome).toBe(dry.sessionHome);
    } finally {
      process.chdir(before);
    }
  });

  it("dry-run refuses a home the real run refuses (a file or a symlink)", async () => {
    await layout();
    await writeFile(join(t, "homefile"), "x");
    await symlink(join(t, "real"), join(t, "homelink"));
    for (const home of [join(t, "homefile"), join(t, "homelink")]) {
      const dry = await buildHostEnv(input({ dryRun: true, home })).catch((e: unknown) => e);
      expect(dry).toBeInstanceOf(UnsafeHomeError);
      expect((dry as UnsafeHomeError).message).toContain("DYNAMIC_SKILLS_HOME");
      expect((dry as UnsafeHomeError).message).toBe(
        ((await buildHostEnv(input({ home })).catch((e: unknown) => e)) as Error).message,
      );
      const real = await buildHostEnv(input({ home })).catch((e: unknown) => e);
      expect(real).toBeInstanceOf(UnsafeHomeError);
    }
  });

  it("maps an unresolvable repo to a USAGE error", async () => {
    await layout();
    const err = await buildHostEnv(input({ repo: join(t, "no-such-repo") })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("USAGE");
  });

  it("maps an unresolvable repo or user home to a CliError", async () => {
    await layout();
    const err = await buildHostEnv(input({ userHome: join(t, "missing-user") })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
  });
});

describe("environment passthrough to the skill scan", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.cleanup());

  const skill = (name: string) =>
    `---\nname: ${name}\ndescription: Does ${name} things for the tests.\n---\n\nBody of ${name}.\n`;

  it("lists a skill under CODEX_HOME, and not without the variable", async () => {
    const cx = join(h.tmp, "cx");
    await mkdir(join(cx, "skills/cx-skill"), { recursive: true });
    await writeFile(join(cx, "skills/cx-skill/SKILL.md"), skill("cx-skill"));
    const without = await h.run(["assess", "--task", "Add caching to order reads"]);
    expect(without.out.skills.map((s: { name: string }) => s.name)).not.toContain("cx-skill");
    const r = await h.runWith(["assess", "--task", "Add caching to order reads"], {
      vars: { CODEX_HOME: cx },
    });
    expect(r.out.skills.map((s: { name: string }) => s.name)).toContain("cx-skill");
  });

  it("lists a skill from the admin root under the injected etcDir", async () => {
    await mkdir(join(h.etcDir, "codex/skills/admin-skill"), { recursive: true });
    await writeFile(join(h.etcDir, "codex/skills/admin-skill/SKILL.md"), skill("admin-skill"));
    const r = await h.run(["assess", "--task", "Add caching to order reads"]);
    expect(r.out.skills.map((s: { name: string }) => s.name)).toContain("admin-skill");
  });

  it("honours XDG_CONFIG_HOME and OPENCODE_CONFIG_DIR", async () => {
    const xdg = join(h.tmp, "xdg");
    await mkdir(join(xdg, "opencode/skills/xdg-skill"), { recursive: true });
    await writeFile(join(xdg, "opencode/skills/xdg-skill/SKILL.md"), skill("xdg-skill"));
    const oc = join(h.tmp, "oc");
    await mkdir(join(oc, "skills/oc-skill"), { recursive: true });
    await writeFile(join(oc, "skills/oc-skill/SKILL.md"), skill("oc-skill"));
    const r = await h.runWith(["assess", "--task", "Add caching to order reads"], {
      vars: { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: oc },
    });
    const names = r.out.skills.map((s: { name: string }) => s.name);
    expect(names).toContain("oc-skill");
    expect(names).not.toContain("xdg-skill"); // OPENCODE_CONFIG_DIR wins over XDG_CONFIG_HOME
  });

  it("existingSkillsFor honours vars directly", async () => {
    const cl = join(h.tmp, "cl");
    await mkdir(join(cl, "skills/cl-skill"), { recursive: true });
    await writeFile(join(cl, "skills/cl-skill/SKILL.md"), skill("cl-skill"));
    const id = await assess(h);
    expect(id).toBeTruthy();
    const { existingSkillsFor } = await import("../src/commands/bundle");
    const state = JSON.parse(await h.read(id, "session.json"));
    const names = (
      await existingSkillsFor(state, h.userHome, { CLAUDE_CONFIG_DIR: cl }, h.etcDir)
    ).map((s) => s.name);
    expect(names).toContain("cl-skill");
  });
});

describe("compile and evaluate pass vars and etcDir from their context", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.cleanup());

  async function configDirWith(name: string, body?: string): Promise<string> {
    const cl = join(h.tmp, "cl");
    await mkdir(join(cl, "skills", name), { recursive: true });
    await writeFile(
      join(cl, "skills", name, "SKILL.md"),
      body ??
        `---\nname: ${name}\ndescription: Unrelated helper for ${name}.\n---\n\nBody of ${name}.\n`,
    );
    return cl;
  }

  it("compile lists a CLAUDE_CONFIG_DIR skill in the brief only when vars carry it", async () => {
    const cl = await configDirWith("zz-config-skill");
    const id = await ready(h);
    const none = await h.runWith(["compile", "--session", id], {});
    expect(none.exitCode).toBe(0);
    expect(await h.read(id, "brief.md")).not.toContain("zz-config-skill");
    const id2 = await ready(h);
    const r = await h.runWith(["compile", "--session", id2], { vars: { CLAUDE_CONFIG_DIR: cl } });
    expect(r.exitCode).toBe(0);
    expect(await h.read(id2, "brief.md")).toContain("zz-config-skill");
  });

  it("compile lists an admin-root skill from the injected etcDir", async () => {
    await mkdir(join(h.etcDir, "codex/skills/zz-admin-skill"), { recursive: true });
    await writeFile(
      join(h.etcDir, "codex/skills/zz-admin-skill/SKILL.md"),
      "---\nname: zz-admin-skill\ndescription: Admin helper.\n---\n\nBody.\n",
    );
    const id = await ready(h);
    await h.run(["compile", "--session", id]);
    expect(await h.read(id, "brief.md")).toContain("zz-admin-skill");
  });

  it("evaluate sees a duplicate skill that only the passed vars reveal", async () => {
    const golden = await import("node:fs/promises").then((m) =>
      m.readFile(join(ROOT, "fixtures/skills/valid/order-cache-specialist/SKILL.md"), "utf8"),
    );
    const cl = await configDirWith("order-cache-specialist", golden);
    const run = async (vars: Record<string, string>) => {
      const id = await ready(h);
      await h.run(["compile", "--session", id]);
      await installGolden(h, id, "valid/order-cache-specialist");
      const r = await h.runWith(["evaluate", "--session", id], { vars });
      const dup = r.out.results.find((x: { id?: string; name?: string }) =>
        JSON.stringify(x).includes("duplication"),
      );
      return JSON.stringify(dup);
    };
    const without = await run({});
    const withVars = await run({ CLAUDE_CONFIG_DIR: cl });
    expect(without).toContain("not-applicable");
    expect(withVars).not.toBe(without);
    expect(withVars).toContain("duplicates");
  });

  it("evaluate sees a duplicate skill under the injected admin root", async () => {
    const golden = await import("node:fs/promises").then((m) =>
      m.readFile(join(ROOT, "fixtures/skills/valid/order-cache-specialist/SKILL.md"), "utf8"),
    );
    const run = async (withAdmin: boolean) => {
      const dir = join(h.etcDir, "codex/skills/order-cache-specialist");
      await rm(dir, { recursive: true, force: true });
      const id = await ready(h);
      await h.run(["compile", "--session", id]);
      await installGolden(h, id, "valid/order-cache-specialist");
      if (withAdmin) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), golden);
      }
      const r = await h.run(["evaluate", "--session", id]);
      return JSON.stringify(
        r.out.results.find((x: object) => JSON.stringify(x).includes("duplication")),
      );
    };
    expect(await run(false)).toContain("not-applicable");
    expect(await run(true)).toContain("duplicates");
  });
});

describe("real /etc/codex guard", () => {
  it("records any access under /etc/codex however it is spelled", async () => {
    takeEtcViolations();
    await fsp.readdir("/etc/codex/skills").catch(() => undefined);
    const { readdir: aliased } = await import("node:fs/promises");
    await aliased("/private/etc/codex").catch(() => undefined);
    const seen = takeEtcViolations();
    expect(seen).toHaveLength(2);
    expect(takeEtcViolations()).toEqual([]);
  });
});

describe("bundleDigest and OS junk (Ruling R27)", () => {
  async function session(): Promise<string> {
    const dir = join(t, "session");
    await mkdir(join(dir, "skills/my-skill"), { recursive: true });
    await writeFile(join(dir, "skills/my-skill/SKILL.md"), "x");
    return dir;
  }

  it("ignores junk files beside the bundle at the top level of skills/", async () => {
    const dir = await session();
    const before = await bundleDigest(dir);
    for (const n of [".DS_Store", "Thumbs.db", "desktop.ini"]) {
      await writeFile(join(dir, "skills", n), "junk");
    }
    expect(await bundleDigest(dir)).toBe(before);
  });

  it("still counts junk inside a bundle", async () => {
    const dir = await session();
    const before = await bundleDigest(dir);
    await writeFile(join(dir, "skills/my-skill/.DS_Store"), "junk");
    expect(await bundleDigest(dir)).not.toBe(before);
  });
});

describe("environment overrides read from vars", () => {
  it("resolveEtcDir: explicit wins, then an absolute DYNAMIC_SKILLS_ETC_DIR, else /etc", () => {
    expect(resolveEtcDir("/given", { DYNAMIC_SKILLS_ETC_DIR: "/v" })).toBe("/given");
    expect(resolveEtcDir(undefined, { DYNAMIC_SKILLS_ETC_DIR: "/v" })).toBe("/v");
    expect(resolveEtcDir(undefined, { DYNAMIC_SKILLS_ETC_DIR: "rel/v" })).toBe("/etc");
    expect(resolveEtcDir(undefined, { DYNAMIC_SKILLS_ETC_DIR: "" })).toBe("/etc");
    expect(resolveEtcDir(undefined, {})).toBe("/etc");
  });

  it("DYNAMIC_SKILLS_ETC_DIR relocates the admin skill root for the scan", async () => {
    const h = await harness();
    try {
      await mkdir(join(h.etcDir, "codex/skills/zz-etc-skill"), { recursive: true });
      await writeFile(
        join(h.etcDir, "codex/skills/zz-etc-skill/SKILL.md"),
        "---\nname: zz-etc-skill\ndescription: Admin helper.\n---\n\nBody.\n",
      );
      const r = await h.runWith(["assess", "--task", "Add caching to order reads"], {
        etcDir: undefined,
        vars: { DYNAMIC_SKILLS_ETC_DIR: h.etcDir },
      });
      expect(r.out.skills.map((s: { name: string }) => s.name)).toContain("zz-etc-skill");
    } finally {
      await h.cleanup();
    }
  });

  it("DYNAMIC_SKILLS_HOME from vars picks the session home", async () => {
    const h = await harness();
    try {
      const home = join(h.tmp, "vars-home");
      const r = await runCli(["assess", "--task", "x"], {
        cwd: h.repo,
        userHome: h.userHome,
        etcDir: h.etcDir,
        vars: { DYNAMIC_SKILLS_HOME: home },
      });
      expect(r.exitCode).toBe(0);
      expect((await readdir(join(home, "sessions"))).length).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("an empty DYNAMIC_SKILLS_HOME counts as unset", async () => {
    const h = await harness();
    const before = process.cwd();
    const cwd = join(h.tmp, "somewhere");
    await mkdir(cwd);
    process.chdir(cwd);
    try {
      await runCli(["status", "--session", "nope"], {
        cwd: h.repo,
        userHome: h.userHome,
        etcDir: h.etcDir,
        vars: { DYNAMIC_SKILLS_HOME: "" },
      });
      expect(await readdir(cwd)).toEqual([]);
    } finally {
      process.chdir(before);
      await h.cleanup();
    }
  });

  it("--help mentions --version", async () => {
    const r = await runCli(["--help"]);
    expect(r.stderr).toContain("--version");
  });
});
