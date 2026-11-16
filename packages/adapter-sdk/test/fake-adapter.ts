import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANALYST_AGENT_NAME,
  ANALYST_INSTRUCTIONS,
  compareVersions,
  parseVersion,
  type HarnessAdapter,
  type InstallPlan,
  type JsonObject,
  type NativeQuestionInput,
  type NativeQuestionPlan,
  type PlannedWrite,
  type ReadRoot,
} from "../src/index";

const TESTED = "1.2.3";

/** Fake adapter whose roots live under `.fake/`; limits: 2 questions per call, 3 options, single select. */
export const fakeAdapter: HarnessAdapter = {
  id: "claude-code",
  binary: "fake-harness",
  testedVersions: [TESTED],
  nativeActivation: true,
  delegation: { agentName: ANALYST_AGENT_NAME, readOnly: "instructed" },
  async detect(env) {
    const bin = await env.probe.which("fake-harness");
    if (bin === null) {
      return { installed: false, version: null, variant: null, tested: false, warnings: [] };
    }
    const out = await env.probe.run(bin, ["--version"]);
    const version = parseVersion(out.stdout);
    const tested =
      version !== null && TESTED.split(" ").some((v) => compareVersions(v, version) === 0);
    return { installed: true, version, variant: null, tested, warnings: [] };
  },
  async planInstall(env, _detection, opts): Promise<InstallPlan> {
    const project = opts.scope === "project";
    const base = project ? env.projectRoot : env.userHome;
    const within = project ? env.projectRoot : null;
    const common = { within, committable: project };
    const settingsPatch: JsonObject = project
      ? { permissions: { ask: ["Bash(dynamic-skills save:*)"] } }
      : {
          permissions: { allow: ["Bash(dynamic-skills:*)"] },
          sandbox: { network: true },
          env: { DYNAMIC_SKILLS_HOME: env.sessionHome },
        };
    const writes: PlannedWrite[] = [
      {
        ...common,
        kind: "file",
        path: join(base, ".fake/skills/dynamic-skill-bootstrap/SKILL.md"),
        content: opts.bootstrapSkill,
        purpose: "bootstrap skill",
      },
      {
        ...common,
        kind: "file",
        path: join(base, `.fake/agents/${ANALYST_AGENT_NAME}.md`),
        content: Buffer.from(`---\nname: ${ANALYST_AGENT_NAME}\n---\n${ANALYST_INSTRUCTIONS}\n`),
        purpose: "analyst",
      },
      {
        ...common,
        kind: "json-merge",
        path: join(base, ".fake/settings.json"),
        patch: settingsPatch,
        promote: { paths: [["sandbox"]], key: "mode" },
        purpose: "settings",
      },
    ];
    if (project) {
      writes.push({
        within: env.projectRoot,
        committable: false,
        mustBeIgnored: true,
        kind: "json-merge",
        path: join(base, ".fake/settings.local.json"),
        patch: { env: { DYNAMIC_SKILLS_HOME: env.sessionHome } },
        purpose: "session home",
      });
    }
    return {
      harness: "claude-code",
      scope: opts.scope,
      projectRoot: env.projectRoot,
      writes,
      notes: [],
      verify: [],
    };
  },
  skillRoot(env, scope) {
    return join(scope === "project" ? env.projectRoot : env.userHome, ".fake/skills");
  },
  async readRoots(env): Promise<ReadRoot[]> {
    return [
      { dir: join(env.projectRoot, ".fake/skills"), scope: "project", readBy: ["claude-code"] },
      { dir: join(env.userHome, ".fake/skills"), scope: "personal", readBy: ["claude-code"] },
      { dir: join(env.etcDir, "fake/skills"), scope: "personal", readBy: ["claude-code"] },
    ];
  },
  questions(questions: readonly NativeQuestionInput[]): NativeQuestionPlan {
    const textOnly: string[] = [];
    const native: NativeQuestionInput[] = [];
    for (const q of questions) {
      if (q.options === undefined || q.multiSelect === true || q.options.length > 3)
        textOnly.push(q.id);
      else native.push(q);
    }
    const idMap: Record<string, string> = {};
    const calls: JsonObject[] = [];
    for (let i = 0; i < native.length; i += 2) {
      calls.push({
        questions: native.slice(i, i + 2).map((q, j) => {
          const nativeId = `native${i + j}`;
          idMap[nativeId] = q.id;
          return {
            id: nativeId,
            question: q.text,
            options: q.options!.map((o) => ({ label: o.label, description: o.description })),
          };
        }),
      });
    }
    return { tool: "AskFake", calls, textOnly, idMap, notes: [] };
  },
  nativeSessionRoot(env) {
    return env.vars.DYNAMIC_SKILLS_NATIVE === "1" ? join(env.sessionHome, "native/fake") : null;
  },
  saveNotes: () => [],
};

/** Scans the fake roots for directories holding a `SKILL.md`. */
export async function fakeScan(o: { repo: string; home: string; etcDir: string }) {
  const skills: { name: string; path: string }[] = [];
  for (const root of [
    join(o.repo, ".fake/skills"),
    join(o.home, ".fake/skills"),
    join(o.etcDir, "fake/skills"),
  ]) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root, name);
      try {
        await stat(join(path, "SKILL.md"));
        skills.push({ name, path });
      } catch {
        /* not a skill */
      }
    }
  }
  return { skills };
}

/** Writes a fixture home (user config that must survive an install) and returns its path. */
export function makeFakeFixtureHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fake-fixture-")));
  mkdirSync(join(home, ".fake/skills/user-skill"), { recursive: true });
  writeFileSync(
    join(home, ".fake/skills/user-skill/SKILL.md"),
    "---\nname: user-skill\n---\nMine.\n",
  );
  writeFileSync(join(home, ".fake/notes.txt"), "keep me\n");
  symlinkSync("notes.txt", join(home, ".fake/dotfile-link"));
  writeFileSync(
    join(home, ".fake/settings.json"),
    JSON.stringify(
      { permissions: { allow: ["Read"] }, model: "fast", sandbox: "strict", extra: { n: 1 } },
      null,
      2,
    ),
  );
  return home;
}
