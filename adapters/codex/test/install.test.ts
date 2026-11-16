import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { scanExistingSkills } from "@dynamic-skills/bootstrapper";
import {
  ANALYST_INSTRUCTIONS,
  applyPlan,
  type HostEnv,
  type InstallPlan,
  type InstallScope,
  type PlannedWrite,
} from "@dynamic-skills/adapter-sdk";
import { codexAdapter, CODEX_TESTED_VERSIONS } from "../src/index";
import { analystToml, tomlBasicString } from "../src/templates";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../../../fixtures/harness-homes/codex/home");
const BOOTSTRAP = Buffer.from("---\nname: dynamic-skill-bootstrap\ndescription: x\n---\nBody\n");
const RUNNER = /\b(?:npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec)\s+dynamic-skills\b/;

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function world(vars: Record<string, string | undefined> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-install-")));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  await cp(FIXTURE, home, { recursive: true });
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(root, "etc"));
  const env: HostEnv = {
    projectRoot: project,
    userHome: home,
    sessionHome: join(root, "session"),
    etcDir: join(root, "etc"),
    vars: { HOME: home, PATH: "/fake/bin", ...vars },
    probe: {
      which: async (b) => (b === "codex" ? "/fake/bin/codex" : null),
      run: async () => ({ code: 0, stdout: "codex-cli 0.169.0\n", stderr: "" }),
    },
  };
  return { root, home, project, env };
}

async function plan(
  w: Awaited<ReturnType<typeof world>>,
  scope: InstallScope,
  allowRule = false,
): Promise<InstallPlan> {
  const d = await codexAdapter.detect(w.env);
  return codexAdapter.planInstall(w.env, d, {
    scope,
    native: false,
    allowRule,
    bootstrapSkill: BOOTSTRAP,
  });
}

const file = (p: InstallPlan, suffix: string): PlannedWrite & { kind: "file" } => {
  const f = p.writes.find((x) => x.path.endsWith(suffix));
  if (!f || f.kind !== "file") throw new Error(`no file write ${suffix}`);
  return f;
};

describe("codex detect", () => {
  it("pins the tested version and reports a different one as untested", async () => {
    expect(CODEX_TESTED_VERSIONS).toEqual(["0.169.0"]);
    const w = await world();
    expect(await codexAdapter.detect(w.env)).toMatchObject({
      installed: true,
      version: "0.169.0",
      tested: true,
    });
    const other = {
      ...w.env,
      probe: {
        ...w.env.probe,
        run: async () => ({ code: 0, stdout: "codex-cli 0.200.1", stderr: "" }),
      },
    };
    const d = await codexAdapter.detect(other);
    expect(d.tested).toBe(false);
    expect(d.warnings.length).toBeGreaterThan(0);
  });

  it("reports a missing binary", async () => {
    const w = await world();
    const d = await codexAdapter.detect({
      ...w.env,
      probe: { which: async () => null, run: async () => ({ code: -1, stdout: "", stderr: "" }) },
    });
    expect(d.installed).toBe(false);
  });
});

describe("codex install plan", () => {
  it("has the documented identity", () => {
    expect(codexAdapter.id).toBe("codex");
    expect(codexAdapter.binary).toBe("codex");
    expect(codexAdapter.nativeActivation).toBe(false);
    expect(codexAdapter.delegation).toEqual({
      agentName: "dynamic_skills_context_analyst",
      readOnly: "instructed",
    });
  });

  it("plans the personal paths with within null", async () => {
    const w = await world();
    const p = await plan(w, "personal");
    expect(p.writes.map((x) => x.path)).toEqual([
      join(w.home, ".agents/skills/dynamic-skill-bootstrap/SKILL.md"),
      join(w.home, ".codex/agents/dynamic-skills-context-analyst.toml"),
      join(w.home, ".codex/rules/dynamic-skills.rules"),
    ]);
    expect(p.writes.every((x) => x.within === null)).toBe(true);
    expect(p.writes.every((x) => !x.committable)).toBe(true);
    expect(file(p, "SKILL.md").content.equals(BOOTSTRAP)).toBe(true);
  });

  it("plans the project paths within the project, committable", async () => {
    const w = await world();
    const p = await plan(w, "project");
    expect(p.writes.map((x) => x.path)).toEqual([
      join(w.project, ".agents/skills/dynamic-skill-bootstrap/SKILL.md"),
      join(w.project, ".codex/agents/dynamic-skills-context-analyst.toml"),
      join(w.project, ".codex/rules/dynamic-skills.rules"),
    ]);
    expect(p.writes.every((x) => x.within === w.project && x.committable)).toBe(true);
    for (const x of p.writes) {
      if (x.kind === "file") expect(x.content.toString("utf8")).not.toContain(w.home);
    }
    expect(p.notes.join("\n")).toMatch(/trusted projects/);
  });

  it("honours an absolute CODEX_HOME and ignores a relative one", async () => {
    const w = await world();
    const custom = join(w.root, "custom-codex");
    const abs = await plan(
      { ...w, env: { ...w.env, vars: { ...w.env.vars, CODEX_HOME: custom } } },
      "personal",
    );
    expect(abs.writes[1]!.path).toBe(join(custom, "agents/dynamic-skills-context-analyst.toml"));
    expect(abs.writes[2]!.path).toBe(join(custom, "rules/dynamic-skills.rules"));
    expect(abs.writes[0]!.path).toBe(
      join(w.home, ".agents/skills/dynamic-skill-bootstrap/SKILL.md"),
    );
    const rel = await plan(
      { ...w, env: { ...w.env, vars: { ...w.env.vars, CODEX_HOME: "relative/x" } } },
      "personal",
    );
    expect(rel.writes[1]!.path).toBe(
      join(w.home, ".codex/agents/dynamic-skills-context-analyst.toml"),
    );
  });

  it("writes agent TOML that parses with the exact keys", async () => {
    const w = await world();
    for (const scope of ["personal", "project"] as const) {
      const toml = parse(file(await plan(w, scope), ".toml").content.toString("utf8"));
      expect(toml).toEqual({
        name: "dynamic_skills_context_analyst",
        description: "Read-only analyst for a Dynamic Skills context packet; returns JSON only.",
        model_reasoning_effort: "medium",
        developer_instructions: ANALYST_INSTRUCTIONS,
        features: { request_permissions_tool: false, apps: false, plugins: false },
        skills: { config: [{ name: "dynamic-skill-bootstrap", enabled: false }] },
      });
    }
  });

  it("cannot be broken out of by hostile TOML text", () => {
    const hostile =
      'a"""\nname = "pwned"\n\\ \\" \u0000 \u007f \r\n[features]\napps = true # \'\'\'';
    const doc = parse(analystToml(hostile));
    expect(doc.developer_instructions).toBe(hostile.replaceAll("\r\n", "\r\n"));
    expect(doc.name).toBe("dynamic_skills_context_analyst");
    expect((doc.features as Record<string, unknown>).apps).toBe(false);
    for (const s of ['"', "\\", '"""', "\u0001", "\n", "é", " "]) {
      expect(parse(`k = ${tomlBasicString(s)}`).k).toBe(s);
    }
  });

  it("writes only the two prompt rules without the flag", async () => {
    const w = await world();
    const text = file(await plan(w, "personal"), "dynamic-skills.rules").content.toString("utf8");
    expect(text.match(/prefix_rule\(/g)).toHaveLength(2);
    expect(text).toContain(
      'prefix_rule(pattern = ["dynamic-skills", "save"], decision = "prompt", justification = "Saving a skill needs the user\'s consent (Dynamic Skills)", match = ["dynamic-skills save --session x --scope project"], not_match = ["dynamic-skills status --session x"])',
    );
    expect(text).toContain(
      'prefix_rule(pattern = ["dynamic-skills", "init"], decision = "prompt", justification = "Installing changes harness configuration (Dynamic Skills)", match = ["dynamic-skills init --harness codex"], not_match = ["dynamic-skills status --session x"])',
    );
    expect(text).not.toContain('decision = "allow"');
    expect(text).not.toMatch(RUNNER);
  });

  it("puts the allow rule first with the flag, keeping both prompt rules", async () => {
    const w = await world();
    const text = file(await plan(w, "project", true), "dynamic-skills.rules").content.toString(
      "utf8",
    );
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      'prefix_rule(pattern = ["dynamic-skills"], decision = "allow", justification = "Dynamic Skills deterministic CLI (installed by dynamic-skills init)", match = ["dynamic-skills status --session x"], not_match = ["git status"])',
    );
    expect(lines[1]).toContain('decision = "prompt"');
    expect(lines[2]).toContain('"init"');
    expect(text).not.toMatch(RUNNER);
  });

  it("never emits a package runner anywhere in the plan", async () => {
    const w = await world();
    for (const scope of ["personal", "project"] as const) {
      for (const allow of [false, true]) {
        const p = await plan(w, scope, allow);
        const all = [
          ...p.writes.map((x) => (x.kind === "file" ? x.content.toString("utf8") : "")),
          ...p.notes,
          ...p.verify.map((v) => `${v.bin} ${v.args.join(" ")}`),
        ].join("\n");
        expect(all).not.toMatch(RUNNER);
      }
    }
  });

  it("notes and verify commands", async () => {
    const w = await world();
    const off = await plan(w, "personal");
    const notes = off.notes.join("\n");
    expect(notes).toContain("Restart Codex to load the rules.");
    expect(notes).toContain("codex exec");
    expect(notes).toContain("--codex-allow-rule");
    const rules = file(off, "dynamic-skills.rules").path;
    expect(off.verify).toEqual([
      {
        name: "consent rule",
        bin: "codex",
        args: [
          "execpolicy",
          "check",
          "--rules",
          rules,
          "--",
          "dynamic-skills",
          "save",
          "--scope",
          "project",
        ],
        expect: /prompt/,
      },
    ]);
    const on = await plan(w, "personal", true);
    expect(on.notes.join("\n")).not.toContain("--codex-allow-rule");
    expect(on.verify.map((v) => v.name)).toEqual(["consent rule", "allow rule"]);
    expect(on.verify[1]).toMatchObject({
      args: ["execpolicy", "check", "--rules", rules, "--", "dynamic-skills", "status"],
      expect: /allow/,
    });
  });

  it("leaves default.rules, config.toml and AGENTS.md byte-identical and is idempotent", async () => {
    for (const scope of ["personal", "project"] as const) {
      for (const allow of [false, true]) {
        const w = await world();
        const guarded = [".codex/config.toml", ".codex/AGENTS.md", ".codex/rules/default.rules"];
        const before = await Promise.all(guarded.map((g) => readFile(join(w.home, g))));
        const p = await plan(w, scope, allow);
        const first = await applyPlan(p, { dryRun: false, force: false });
        expect(first.some((r) => r.action === "conflict")).toBe(false);
        expect(first.every((r) => r.action === "create")).toBe(true);
        const after = await Promise.all(guarded.map((g) => readFile(join(w.home, g))));
        after.forEach((b, i) => expect(b.equals(before[i]!)).toBe(true));
        const again = await applyPlan(await plan(w, scope, allow), { dryRun: false, force: false });
        expect(again.every((r) => r.action === "unchanged")).toBe(true);
      }
    }
  });

  it("conflicts instead of overwriting a user's own dynamic-skills.rules", async () => {
    const w = await world();
    const target = join(w.home, ".codex/rules/dynamic-skills.rules");
    await writeFile(target, "# mine\n");
    const res = await applyPlan(await plan(w, "personal"), { dryRun: false, force: false });
    expect(res.find((r) => r.path === target)?.action).toBe("conflict");
  });

  it("lists the fixture's unnamed user-skill via the scan", async () => {
    const w = await world();
    const scan = await scanExistingSkills({
      repo: w.project,
      home: w.home,
      vars: w.env.vars,
      etcDir: w.env.etcDir,
    });
    expect(scan.skills.map((s) => s.name)).toContain("user-skill");
  });
});

describe("codex roots", () => {
  it("saves to the project and personal .agents/skills", async () => {
    const w = await world();
    expect(codexAdapter.skillRoot(w.env, "project")).toBe(join(w.project, ".agents/skills"));
    expect(codexAdapter.skillRoot(w.env, "personal")).toBe(join(w.home, ".agents/skills"));
  });

  it("reads only roots Codex reads, including CODEX_HOME and the admin root", async () => {
    const w = await world();
    const custom = join(w.root, "cx");
    const env = { ...w.env, vars: { ...w.env.vars, CODEX_HOME: custom } };
    const r = await codexAdapter.readRoots(env);
    expect(r.every((x) => x.readBy.includes("codex"))).toBe(true);
    const dirs = r.map((x) => x.dir);
    expect(dirs).toContain(join(w.project, ".agents/skills"));
    expect(dirs).toContain(join(w.project, ".codex/skills"));
    expect(dirs).toContain(join(w.home, ".agents/skills"));
    expect(dirs).toContain(join(custom, "skills"));
    expect(dirs).toContain(join(w.env.etcDir, "codex/skills"));
  });

  it("has no native session root and a save note", async () => {
    const w = await world();
    expect(
      codexAdapter.nativeSessionRoot({ ...w.env, vars: { DYNAMIC_SKILLS_NATIVE: "1" } }),
    ).toBeNull();
    expect(
      codexAdapter
        .saveNotes({
          installed: true,
          version: "0.169.0",
          variant: null,
          tested: true,
          warnings: [],
        })
        .join(" "),
    ).toMatch(/10 seconds/);
  });
});
