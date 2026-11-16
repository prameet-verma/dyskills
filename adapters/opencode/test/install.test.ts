import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyPlan, type InstallPlan, type PlannedWrite } from "@dynamic-skills/adapter-sdk";
import { makeWorld, type World } from "../../../packages/adapter-sdk/src/testkit/fixtures";
import { openCodeAdapter, OPENCODE_TESTED_VERSIONS, personalConfigDir } from "../src/index";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE_V1 = join(REPO_ROOT, "fixtures/harness-homes/opencode-v1/home");
const FIXTURE_V2 = join(REPO_ROOT, "fixtures/harness-homes/opencode-v2/home");
const BOOT = Buffer.from("bootstrap bytes\n");
const V1_VERSION = "1.19.5";
const V2_VERSION = "2.3.0";

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length > 0) await worlds.pop()!.cleanup();
});

async function setup(
  fixtureHome: string,
  versionOutput: string,
  vars: Record<string, string> = {},
): Promise<World> {
  const w = await makeWorld({
    fixtureHome,
    versionOutput,
    adapter: openCodeAdapter,
    vars: { XDG_CONFIG_HOME: "{home}/.config", ...vars },
  });
  worlds.push(w);
  return w;
}

async function plan(w: World, scope: "personal" | "project"): Promise<InstallPlan> {
  const detection = await openCodeAdapter.detect(w.env);
  return openCodeAdapter.planInstall(w.env, detection, {
    scope,
    native: false,
    allowRule: false,
    bootstrapSkill: BOOT,
  });
}

const mergeWrite = (p: InstallPlan): PlannedWrite & { kind: "jsonc-merge" } =>
  p.writes.find((x): x is PlannedWrite & { kind: "jsonc-merge" } => x.kind === "jsonc-merge")!;

describe("opencode installer", () => {
  it("exports the pinned tested versions and identity", () => {
    expect([...OPENCODE_TESTED_VERSIONS]).toEqual(["1.19.5", "2.3.0"]);
    expect(openCodeAdapter.id).toBe("opencode");
    expect(openCodeAdapter.binary).toBe("opencode");
    expect(openCodeAdapter.nativeActivation).toBe(false);
    expect(openCodeAdapter.delegation).toEqual({
      agentName: "dynamic-skills-context-analyst",
      readOnly: "enforced",
    });
  });

  it("v1 fixture: bash ends in the consent order with the ask promoted to *, and no permissions key", async () => {
    const w = await setup(FIXTURE_V1, V1_VERSION);
    const p = await plan(w, "personal");
    const m = mergeWrite(p);
    const res = await applyPlan(p, { dryRun: false, force: false });
    expect(res.some((r) => r.action === "conflict")).toBe(false);
    const text = await readFile(m.path, "utf8");
    expect(text).not.toContain('"permissions"');
    const doc = JSON.parse(text) as {
      permission: { bash: Record<string, string>; edit: Record<string, string> };
    };
    expect(Object.keys(doc.permission.bash)).toEqual([
      "*",
      "dynamic-skills *",
      "dynamic-skills save *",
      "dynamic-skills init *",
    ]);
    expect(doc.permission.bash["*"]).toBe("ask");
    expect(Object.keys(doc.permission.edit)[0]).toBe("*");
    expect(doc.permission.edit["*"]).toBe("ask");
  });

  it("v2 fixture: the user comment and the permissions array survive the merge", async () => {
    const w = await setup(FIXTURE_V2, V2_VERSION);
    const p = await plan(w, "personal");
    const m = mergeWrite(p);
    const res = await applyPlan(p, { dryRun: false, force: false });
    expect(res.some((r) => r.action === "conflict")).toBe(false);
    const text = await readFile(m.path, "utf8");
    expect(text).toContain("// user comment");
    expect(text).toContain('"action": "shell"');
    expect(text).toContain('"resource": "git *"');
    expect(text).toContain('"effect": "allow"');
  });

  it('rejects a scalar top-level "permission" with a conflict and writes nothing', async () => {
    const w = await setup(FIXTURE_V1, V1_VERSION);
    const p = await plan(w, "personal");
    const m = mergeWrite(p);
    await mkdir(dirname(m.path), { recursive: true });
    const before = JSON.stringify({ permission: "ask" });
    await writeFile(m.path, before);
    const res = await applyPlan(p, { dryRun: false, force: false });
    expect(res.find((r) => r.path === m.path)?.action).toBe("conflict");
    expect(await readFile(m.path, "utf8")).toBe(before);
  });

  it('rejects a pre-existing "dynamic-skills *" deny with a conflict', async () => {
    const w = await setup(FIXTURE_V1, V1_VERSION);
    const p = await plan(w, "project");
    const m = mergeWrite(p);
    await mkdir(dirname(m.path), { recursive: true });
    const before = JSON.stringify({ permission: { bash: { "dynamic-skills *": "deny" } } });
    await writeFile(m.path, before);
    const res = await applyPlan(p, { dryRun: false, force: false });
    expect(res.find((r) => r.path === m.path)?.action).toBe("conflict");
    expect(await readFile(m.path, "utf8")).toBe(before);
  });

  it("OPENCODE_CONFIG_DIR beats XDG_CONFIG_HOME", async () => {
    const w = await setup(FIXTURE_V1, V1_VERSION, {
      OPENCODE_CONFIG_DIR: "{home}/custom-config",
    });
    expect(personalConfigDir(w.env)).toBe(join(w.home, "custom-config"));
    const p = await plan(w, "personal");
    expect(p.writes.every((x) => x.path.startsWith(join(w.home, "custom-config")))).toBe(true);
  });

  it("merges into an existing bare P/opencode.json instead of creating .opencode/opencode.jsonc", async () => {
    const w = await setup(FIXTURE_V1, V1_VERSION);
    await writeFile(join(w.project, "opencode.json"), JSON.stringify({ permission: {} }));
    const p = await plan(w, "project");
    const m = mergeWrite(p);
    expect(m.path).toBe(join(w.project, "opencode.json"));
  });

  it("project writes contain no absolute home or session-home path", async () => {
    const w = await setup(FIXTURE_V1, V1_VERSION);
    const p = await plan(w, "project");
    for (const wr of p.writes) {
      const text = `${wr.path}\n${wr.kind === "file" ? wr.content.toString("utf8") : wr.kind === "dir" ? "" : JSON.stringify(wr.patch)}`;
      expect(text.includes(w.home), `${wr.path} must not mention the home`).toBe(false);
      expect(text.includes(w.env.sessionHome), `${wr.path} must not mention the session home`).toBe(
        false,
      );
    }
    expect(p.writes.every((x) => x.within === w.project)).toBe(true);
    expect(p.writes.every((x) => x.committable)).toBe(true);
  });

  it("personal writes set within to null", async () => {
    const w = await setup(FIXTURE_V1, V1_VERSION);
    const p = await plan(w, "personal");
    expect(p.writes.every((x) => x.within === null)).toBe(true);
    expect(p.writes.every((x) => !x.committable)).toBe(true);
  });

  it("writes three fixed files under .opencode for project scope", async () => {
    const w = await setup(FIXTURE_V1, V1_VERSION);
    const p = await plan(w, "project");
    const files = p.writes.filter((x) => x.kind === "file").map((x) => x.path);
    expect(files).toEqual([
      join(w.project, ".opencode/skills/dynamic-skill-bootstrap/SKILL.md"),
      join(w.project, ".opencode/agents/dynamic-skills-context-analyst.md"),
      join(w.project, ".opencode/commands/dynamic-skills.md"),
    ]);
  });

  it("notes the external_directory requirement only for project scope", async () => {
    const w = await setup(FIXTURE_V1, V1_VERSION);
    expect((await plan(w, "project")).notes.join("\n")).toMatch(/external_directory allow/);
    expect((await plan(w, "personal")).notes.join("\n")).not.toMatch(/external_directory allow/);
    expect((await plan(w, "project")).notes.join("\n")).toMatch(/opencode run.*rejects asks/);
    expect((await plan(w, "personal")).notes.join("\n")).toMatch(/opencode run.*rejects asks/);
  });

  it("warns when a v1 chosen file already has a top-level permissions key", async () => {
    const w = await setup(FIXTURE_V1, V1_VERSION);
    const probe = await plan(w, "personal");
    const configPath = mergeWrite(probe).path;
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ permissions: [] }));
    const p = await plan(w, "personal");
    expect(p.notes.join("\n")).toMatch(/OpenCode 1\.x rejects the V2 `permissions` key/);
    expect(p.notes.join("\n")).toContain(configPath);
  });

  it("never warns about permissions on the v2 line, even with one present", async () => {
    const w2 = await setup(FIXTURE_V2, V2_VERSION);
    const p2 = await plan(w2, "personal");
    expect(p2.notes.join("\n")).not.toMatch(/rejects the V2/);
  });

  it("writes the config-paths verify check only on the v2 line", async () => {
    const w1 = await setup(FIXTURE_V1, V1_VERSION);
    expect((await plan(w1, "personal")).verify).toEqual([]);
    const w2 = await setup(FIXTURE_V2, V2_VERSION);
    const p2 = await plan(w2, "personal");
    expect(p2.verify).toHaveLength(1);
    expect(p2.verify[0]).toMatchObject({
      name: "config paths",
      bin: "opencode",
      args: ["debug", "paths"],
    });
    expect(p2.verify[0]!.expect.test("anything at all")).toBe(true);
  });

  it("never writes permissions, plugin or plugins", async () => {
    const w = await setup(FIXTURE_V2, V2_VERSION);
    for (const scope of ["personal", "project"] as const) {
      const p = await plan(w, scope);
      const m = mergeWrite(p);
      expect(Object.keys(m.patch)).toEqual(["permission"]);
      const str = JSON.stringify(m.patch);
      expect(str).not.toContain('"plugin"');
      expect(str).not.toContain('"plugins"');
    }
  });
});
