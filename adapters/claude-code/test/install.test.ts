import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANALYST_INSTRUCTIONS,
  applyPlan,
  previewPlan,
  type InstallPlan,
  type JsonObject,
  type PlannedWrite,
} from "@dynamic-skills/adapter-sdk";
import { makeWorld, type World } from "../../../packages/adapter-sdk/src/testkit/fixtures";
import { claudeCodeAdapter, CLAUDE_CODE_TESTED_VERSIONS } from "../src/index";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = join(REPO_ROOT, "fixtures/harness-homes/claude-code/home");
const BOOT = Buffer.from("bootstrap bytes\n");

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length > 0) await worlds.pop()!.cleanup();
});

async function setup(version = "2.1.325 (Claude Code)", extraVars: Record<string, string> = {}) {
  const w = await makeWorld({
    fixtureHome: FIXTURE,
    versionOutput: version,
    adapter: claudeCodeAdapter,
    extraVars,
  });
  worlds.push(w);
  return w;
}

async function plan(w: World, scope: "personal" | "project", native = false): Promise<InstallPlan> {
  const detection = await claudeCodeAdapter.detect(w.env);
  return claudeCodeAdapter.planInstall(w.env, detection, {
    scope,
    native,
    allowRule: false,
    bootstrapSkill: BOOT,
  });
}

const merges = (p: InstallPlan) =>
  p.writes.filter((x): x is PlannedWrite & { kind: "json-merge" } => x.kind === "json-merge");
const ASK = [
  "Bash(dynamic-skills save *)",
  "Bash(dynamic-skills save)",
  "Bash(dynamic-skills init *)",
  "Bash(dynamic-skills init)",
];

describe("claude-code installer", () => {
  it("exports the pinned tested version", () => {
    expect([...CLAUDE_CODE_TESTED_VERSIONS]).toEqual(["2.1.325"]);
    expect(claudeCodeAdapter.id).toBe("claude-code");
    expect(claudeCodeAdapter.binary).toBe("claude");
    expect(claudeCodeAdapter.delegation).toEqual({
      agentName: "dynamic-skills-context-analyst",
      readOnly: "enforced",
    });
  });

  it("personal patch equals the specified object exactly", async () => {
    const w = await setup();
    const p = await plan(w, "personal");
    const H = w.env.sessionHome;
    const m = merges(p);
    expect(m).toHaveLength(1);
    expect(m[0]!.path).toBe(join(w.home, ".claude/settings.json"));
    expect(m[0]!.patch).toEqual({
      permissions: {
        allow: ["Bash(dynamic-skills *)", `Read(/${H}/**)`, `Edit(/${H}/**)`],
        ask: ASK,
        additionalDirectories: [H],
      },
      env: { DYNAMIC_SKILLS_HOME: H, DYNAMIC_SKILLS_HARNESS: "claude-code" },
    });
    expect(m[0]!.within).toBeNull();
    const files = p.writes.filter((x) => x.kind === "file").map((x) => x.path);
    expect(files).toEqual([
      join(w.home, ".claude/skills/dynamic-skill-bootstrap/SKILL.md"),
      join(w.home, ".claude/agents/dynamic-skills-context-analyst.md"),
    ]);
    expect(p.writes.every((x) => x.within === null)).toBe(true);
  });

  it("writes the analyst template exactly", async () => {
    const w = await setup();
    const p = await plan(w, "personal");
    const a = p.writes.find((x) => x.path.endsWith("context-analyst.md"))! as PlannedWrite & {
      kind: "file";
    };
    const text = a.content.toString("utf8");
    expect(text.startsWith("---\nname: dynamic-skills-context-analyst\n")).toBe(true);
    expect(text).toContain("tools: Read, Grep, Glob\n");
    expect(text).toContain("model: inherit\n");
    expect(text).toContain("maxTurns: 20\n");
    expect(text).toContain("omitClaudeMd: true\n");
    expect(text).toContain("Returns one JSON document and no prose.");
    expect(text.endsWith(`---\n${ANALYST_INSTRUCTIONS}\n`)).toBe(true);
  });

  it("only touches permissions and env at the top level", async () => {
    const w = await setup();
    for (const scope of ["personal", "project"] as const) {
      for (const native of [false, true]) {
        for (const m of merges(await plan(w, scope, native))) {
          expect(Object.keys(m.patch).every((k) => k === "permissions" || k === "env")).toBe(true);
        }
      }
    }
  });

  it("keeps every user key and is idempotent after apply", async () => {
    const w = await setup();
    const before = JSON.parse(await readFile(join(w.home, ".claude/settings.json"), "utf8"));
    const res = await applyPlan(await plan(w, "personal"), { dryRun: false, force: false });
    expect(res.some((r) => r.action === "conflict")).toBe(false);
    const after = JSON.parse(await readFile(join(w.home, ".claude/settings.json"), "utf8"));
    expect(after.statusLine).toEqual(before.statusLine);
    expect(after.hooks).toEqual(before.hooks);
    expect(after.permissions.allow).toContain("Bash(git status)");
    expect(after.permissions.deny).toEqual(["Read(./.env)"]);
    expect(after.permissions.ask).toEqual(ASK);
    const again = await previewPlan(await plan(w, "personal"), { force: false });
    expect(again.every((r) => r.action === "unchanged")).toBe(true);
  });

  it("carries the four consent rules and no overriding allow in both scopes", async () => {
    const w = await setup();
    for (const scope of ["personal", "project"] as const) {
      const all = merges(await plan(w, scope));
      const asks = all.flatMap((m) => ((m.patch.permissions as JsonObject).ask as string[]) ?? []);
      expect(asks).toEqual(ASK);
      const allows = all.flatMap(
        (m) => ((m.patch.permissions as JsonObject).allow as string[]) ?? [],
      );
      expect(allows.filter((a) => /dynamic-skills (save|init)/.test(a))).toEqual([]);
    }
  });

  it("CLAUDE_CONFIG_DIR moves every personal path", async () => {
    const w = await setup();
    const cfg = join(w.root, "cc");
    const w2 = { ...w.env, vars: { ...w.env.vars, CLAUDE_CONFIG_DIR: cfg } };
    const detection = await claudeCodeAdapter.detect(w2);
    const p = await claudeCodeAdapter.planInstall(w2, detection, {
      scope: "personal",
      native: false,
      allowRule: false,
      bootstrapSkill: BOOT,
    });
    for (const x of p.writes) expect(x.path.startsWith(`${cfg}/`)).toBe(true);
    expect(claudeCodeAdapter.skillRoot(w2, "personal")).toBe(join(cfg, "skills"));
    const rel = { ...w.env, vars: { ...w.env.vars, CLAUDE_CONFIG_DIR: "relative/dir" } };
    expect(claudeCodeAdapter.skillRoot(rel, "personal")).toBe(join(w.home, ".claude/skills"));
  });

  it("project scope splits committable and local files", async () => {
    const w = await setup();
    const p = await plan(w, "project");
    const P = w.project;
    const m = merges(p);
    const shared = m.find((x) => x.path === join(P, ".claude/settings.json"))!;
    const local = m.find((x) => x.path === join(P, ".claude/settings.local.json"))!;
    expect(shared.committable).toBe(true);
    expect(shared.patch).toEqual({
      permissions: { allow: ["Bash(dynamic-skills *)"], ask: ASK },
    });
    expect(local.committable).toBe(false);
    expect(local.mustBeIgnored).toBe(true);
    const H = w.env.sessionHome;
    expect(local.patch).toEqual({
      permissions: {
        allow: [`Read(/${H}/**)`, `Edit(/${H}/**)`],
        additionalDirectories: [H],
      },
      env: { DYNAMIC_SKILLS_HOME: H, DYNAMIC_SKILLS_HARNESS: "claude-code" },
    });
    expect(p.writes.every((x) => x.within === P)).toBe(true);
    expect(p.notes.join("\n")).toMatch(/untrusted folder/);
    expect(p.notes.join("\n")).toMatch(/ask beats allow/);
  });

  it("native adds the env key, the dir write and the launch note", async () => {
    const w = await setup();
    const H = w.env.sessionHome;
    const p = await plan(w, "personal", true);
    const env = merges(p)[0]!.patch.env as JsonObject;
    expect(env.DYNAMIC_SKILLS_NATIVE).toBe("1");
    const dir = p.writes.find((x) => x.kind === "dir")!;
    expect(dir.path).toBe(join(H, "native/claude-code/.claude/skills"));
    expect(dir.within).toBe(H);
    expect(p.notes.join("\n")).toContain(`claude --add-dir ${H}/native/claude-code`);
    const off = await plan(w, "personal", false);
    expect(off.writes.some((x) => x.kind === "dir")).toBe(false);
    expect((merges(off)[0]!.patch.env as JsonObject).DYNAMIC_SKILLS_NATIVE).toBeUndefined();
  });

  it("project scope with native previews without conflict", async () => {
    const w = await setup();
    const p = await plan(w, "project", true);
    const local = merges(p).find((x) => x.path.endsWith("settings.local.json"))!;
    expect((local.patch.env as JsonObject).DYNAMIC_SKILLS_NATIVE).toBe("1");
    expect(
      (merges(p).find((x) => x.path.endsWith("/settings.json"))!.patch.env as unknown) ?? null,
    ).toBeNull();
    const dir = p.writes.find((x) => x.kind === "dir")!;
    expect(dir.within).toBe(w.env.sessionHome);
    await mkdir(w.env.sessionHome, { recursive: true });
    const res = await previewPlan(p, { force: false });
    expect(res.some((r) => r.action === "conflict")).toBe(false);
  });

  it("notes a restart when the agents directory is new, not when it exists", async () => {
    const w = await setup();
    expect((await plan(w, "personal")).notes.join("\n")).toMatch(/Restart running sessions/);
    await mkdir(join(w.home, ".claude/agents"), { recursive: true });
    await writeFile(join(w.home, ".claude/agents/x.md"), "x");
    expect((await plan(w, "personal")).notes.join("\n")).not.toMatch(/Restart running sessions/);
  });

  it("warns for versions below 2.1.0 and below 2.1.152", async () => {
    const w = await setup("2.1.100 (Claude Code)");
    const d = await claudeCodeAdapter.detect(w.env);
    expect(d.tested).toBe(false);
    expect(d.warnings.some((x) => /live skill reload/.test(x))).toBe(false);
    expect(d.warnings.some((x) => /reload-skills/.test(x))).toBe(true);
    const w0 = await setup("2.0.9 (Claude Code)");
    const d0 = await claudeCodeAdapter.detect(w0.env);
    expect(d0.warnings.some((x) => /live skill reload/.test(x))).toBe(true);
    expect(d0.warnings.some((x) => /reload-skills/.test(x))).toBe(true);
    expect(
      (await claudeCodeAdapter.detect((await setup("2.1.325 (Claude Code)")).env)).warnings,
    ).toEqual([]);
  });

  it("verifies skill frontmatter only from 2.1.233", async () => {
    const old = await setup("2.1.200 (Claude Code)");
    expect((await plan(old, "personal")).verify).toEqual([]);
    const w = await setup();
    const p = await plan(w, "personal");
    expect(p.verify).toHaveLength(1);
    expect(p.verify[0]).toMatchObject({
      name: "skill frontmatter",
      bin: "claude",
      args: ["plugin", "validate", join(w.home, ".claude/skills")],
    });
    expect(p.verify[0]!.expect.test("anything")).toBe(true);
  });

  it("save notes and read roots", async () => {
    const w = await setup();
    const d = await claudeCodeAdapter.detect(w.env);
    expect(claudeCodeAdapter.saveNotes(d)[0]).toMatch(/\/reload-skills/);
    const old = await setup("2.0.9 (Claude Code)");
    expect(claudeCodeAdapter.saveNotes(await claudeCodeAdapter.detect(old.env))[0]).toMatch(
      /Restart Claude Code/,
    );
    const roots = await claudeCodeAdapter.readRoots(w.env);
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((r) => r.readBy.includes("claude-code"))).toBe(true);
    expect(claudeCodeAdapter.skillRoot(w.env, "project")).toBe(join(w.project, ".claude/skills"));
    expect(await realpath(w.project)).toBe(w.project);
  });
});
