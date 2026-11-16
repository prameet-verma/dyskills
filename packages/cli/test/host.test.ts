import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHostEnv } from "../src/host";
import { CliError } from "../src/io";
import { bundleDigest } from "../src/commands/bundle";
import { createHostProbe } from "@dynamic-skills/adapter-sdk";
import { assess, harness, takeEtcViolations } from "./helpers";
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

  it("passes vars to compile as well (existingSkillsFor)", async () => {
    // compile reads the same scan: a CLAUDE_CONFIG_DIR skill must reach the brief's context.
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
