/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { bundleManifest } from "../../packages/adapter-sdk/src/index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SLOW, TASK, fixtureJson, hashTree, installGolden, world } from "./harness";
import type { World } from "./harness";

/** A harness variant under test: the fake binary it needs and the harness id the CLI gets. */
interface Target {
  label: string;
  harness: "claude-code" | "codex" | "opencode";
  bin: string;
  version: string;
  /** Tool name `clarify ask` must report. */
  tool: string;
}

const TARGETS: Target[] = [
  {
    label: "claude-code",
    harness: "claude-code",
    bin: "claude",
    version: "2.1.325 (Claude Code)",
    tool: "AskUserQuestion",
  },
  {
    label: "codex",
    harness: "codex",
    bin: "codex",
    version: "codex-cli 0.169.0",
    tool: "request_user_input",
  },
  {
    label: "opencode-v1",
    harness: "opencode",
    bin: "opencode",
    version: "1.19.5",
    tool: "question",
  },
  {
    label: "opencode-v2",
    harness: "opencode",
    bin: "opencode",
    version: "2.3.0",
    tool: "question",
  },
];

const GOLDEN = "valid/order-cache-specialist" as const;
const PASS_OUTPUT = "invalidation plan: updateOrder clears order:<id>";

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(() => w.cleanup());

/** Runs a command that must exit 0 and returns its stdout document. */
async function ok(argv: string[], env?: Record<string, string>): Promise<Record<string, any>> {
  const r = await w.run(argv, env);
  expect(r.exitCode, `${argv.join(" ")}: ${r.stdout}\n${r.stderr}`).toBe(0);
  expect(r.out).toMatchObject({ ok: true, schemaVersion: "1" });
  return r.out;
}

const sid = (id: string) => ["--session", id];

async function setup(t: Target): Promise<void> {
  await w.fakeBins({ [t.bin]: t.version }, { dynamicSkillsShim: true });
}

/** Phase 1 flow up to an activated golden skill; returns the session id and the skill path. */
async function pipeline(
  env: Record<string, string> = {},
): Promise<{ id: string; skillPath: string }> {
  const id = (await ok(["assess", "--task", TASK], env)).sessionId as string;
  await ok(["discover", ...sid(id)], env);
  await ok(
    [
      "context",
      "submit",
      ...sid(id),
      "--file",
      await w.doc("analysis.json", await fixtureJson("analysis/ts-monorepo-caching.json")),
    ],
    env,
  );
  await ok(
    [
      "sufficiency",
      "submit",
      ...sid(id),
      "--file",
      await w.doc("verdict.json", {
        schemaVersion: "1",
        outcome: "insufficient",
        rationale: "No existing skill covers distributed caching",
      }),
    ],
    env,
  );
  const compiled = await ok(["compile", ...sid(id)], env);
  const skillPath = await installGolden(compiled, GOLDEN);
  await ok(["evaluate", ...sid(id)], env);
  await ok(
    [
      "eval",
      "record",
      ...sid(id),
      "--output",
      await w.doc("out.txt", PASS_OUTPUT),
      "--verdict",
      "pass",
    ],
    env,
  );
  return { id, skillPath };
}

describe("init idempotency", () => {
  for (const t of TARGETS) {
    for (const scope of ["personal", "project"] as const) {
      it(
        `${t.label} ${scope}: second init changes nothing`,
        async () => {
          await setup(t);
          const argv = ["init", "--harness", t.harness, "--scope", scope];
          const first = await ok(argv);
          const created = first.harnesses[0].writes.filter((x: any) => x.action === "create");
          expect(created.length).toBeGreaterThan(0);
          const homeBefore = await hashTree(w.userHome);
          const repoBefore = await hashTree(w.repo);
          const second = await ok(argv);
          for (const wr of second.harnesses[0].writes) expect(wr.action).toBe("unchanged");
          expect(await hashTree(w.userHome)).toEqual(homeBefore);
          expect(await hashTree(w.repo)).toEqual(repoBefore);
        },
        SLOW,
      );
    }

    for (const scope of ["personal", "project"] as const) {
      it(
        `${t.label} ${scope}: --dry-run on a fresh world writes nothing and creates no session home`,
        async () => {
          await setup(t);
          const fresh = join(w.tmp, "fresh-home");
          const homeBefore = await hashTree(w.userHome);
          const repoBefore = await hashTree(w.repo);
          const r = await ok(["init", "--harness", t.harness, "--scope", scope, "--dry-run"], {
            DYNAMIC_SKILLS_HOME: fresh,
          });
          expect(r.dryRun).toBe(true);
          expect(r.harnesses[0].writes.some((x: any) => x.action === "create")).toBe(true);
          expect(await w.exists(fresh)).toBe(false);
          expect(await hashTree(w.userHome)).toEqual(homeBefore);
          expect(await hashTree(w.repo)).toEqual(repoBefore);
          expect(await hashTree(w.etcDir)).toEqual({});
        },
        SLOW,
      );
    }
  }
});

/** Replaces the volatile parts (session id, timestamps, temp paths) so documents compare across worlds. */
function normalize(text: string, world: World, id: string): string {
  return text
    .split(id)
    .join("<SESSION>")
    .split(world.tmp)
    .join("<TMP>")
    .replace(
      /Remaining processing budget: \d+ seconds/g,
      "Remaining processing budget: <N> seconds",
    )
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<TIME>")
    .replace(/"(?:createdAt|updatedAt|at|timestamp|durationMs|activeMs)":\s*\d+/g, '"<N>": 0');
}

interface Seen {
  label: string;
  sha: string;
  files: unknown;
  packet: string;
  brief: string;
  results: unknown[];
}

describe("AC 20 byte-identical bundle", () => {
  const seen: Seen[] = [];

  for (const t of TARGETS) {
    it(
      `${t.label}: saved bundles equal the session bundle`,
      async () => {
        await setup(t);
        const env = { DYNAMIC_SKILLS_HARNESS: t.harness };
        const { id, skillPath } = await pipeline(env);
        await ok(["activate", ...sid(id)], env);
        const sessionBundle = await bundleManifest(join(skillPath, ".."));
        const saved = await ok(
          ["save", ...sid(id), "--scope", "project", "--harness", t.harness],
          env,
        );
        expect(saved.saved.length).toBeGreaterThan(0);
        const repoReal = await realRepo(w.repo);
        for (const s of saved.saved) {
          // Saved under the fresh repo copy, never the session home.
          expect(s.path.startsWith(repoReal)).toBe(true);
          expect(await bundleManifest(s.path)).toEqual(sessionBundle);
        }
        expect(saved.manifestSha256).toBe(sessionBundle.sha256);
        const evaluation = await w.readJson(id, "reports/evaluation.json");
        const results = (evaluation.results ?? evaluation.checks ?? []).map((r: any) => [
          r.id,
          r.outcome,
        ]);
        expect(results.length).toBeGreaterThan(0);
        seen.push({
          label: t.label,
          sha: sessionBundle.sha256,
          files: sessionBundle.files,
          packet: normalize(
            await readFile(join(w.session(id), "context-packet.json"), "utf8"),
            w,
            id,
          ),
          brief: normalize(await readFile(join(w.session(id), "brief.md"), "utf8"), w, id),
          results,
        });
      },
      SLOW * 2,
    );
  }

  it("bundles, context packets, briefs and evaluation results are equal across targets", () => {
    expect(seen.map((s) => s.label)).toEqual(TARGETS.map((t) => t.label));
    for (const s of seen.slice(1)) {
      expect(s.sha, s.label).toBe(seen[0]?.sha);
      expect(s.files, s.label).toEqual(seen[0]?.files);
      expect(s.packet, s.label).toBe(seen[0]?.packet);
      expect(s.brief, s.label).toBe(seen[0]?.brief);
      expect(s.results, s.label).toEqual(seen[0]?.results);
    }
  });
});

async function realRepo(p: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(p);
}

describe("AC 28 ephemeral isolation", () => {
  for (const t of TARGETS) {
    it(
      `${t.label}: permanent skill roots are untouched by assess, activate and clean`,
      async () => {
        await setup(t);
        const env = { DYNAMIC_SKILLS_HARNESS: t.harness };
        const before = await w.hashRoots();
        const first = await ok(["assess", "--task", TASK], env);
        expect(await w.hashRoots()).toEqual(before);
        const id = first.sessionId as string;
        // Continue the same session through activation.
        await ok(["discover", ...sid(id)], env);
        await ok(
          [
            "context",
            "submit",
            ...sid(id),
            "--file",
            await w.doc("analysis.json", await fixtureJson("analysis/ts-monorepo-caching.json")),
          ],
          env,
        );
        await ok(
          [
            "sufficiency",
            "submit",
            ...sid(id),
            "--file",
            await w.doc("verdict.json", {
              schemaVersion: "1",
              outcome: "insufficient",
              rationale: "Nothing covers it",
            }),
          ],
          env,
        );
        const compiled = await ok(["compile", ...sid(id)], env);
        await installGolden(compiled, GOLDEN);
        await ok(["evaluate", ...sid(id)], env);
        await ok(
          [
            "eval",
            "record",
            ...sid(id),
            "--output",
            await w.doc("out.txt", PASS_OUTPUT),
            "--verdict",
            "pass",
          ],
          env,
        );
        const activated = await ok(["activate", ...sid(id)], env);
        expect(activated.activated).toBe(true);
        expect(await w.hashRoots()).toEqual(before);
        await ok(["clean", ...sid(id)], env);
        expect(await w.hashRoots()).toEqual(before);
        expect(await w.exists(join(w.dsHome, "native"))).toBe(false);
      },
      SLOW,
    );
  }

  it(
    "claude-code with DYNAMIC_SKILLS_NATIVE=1 places under <dsHome>/native and clean removes it",
    async () => {
      const t = TARGETS[0] as Target;
      await setup(t);
      const env = { DYNAMIC_SKILLS_HARNESS: t.harness, DYNAMIC_SKILLS_NATIVE: "1" };
      const nativeDir = join(w.dsHome, "native");
      const before = await hashTree(nativeDir);
      const rootsBefore = await w.hashRoots();
      const { id } = await pipeline(env);
      const activated = await ok(["activate", ...sid(id)], env);
      expect(activated.activated).toBe(true);
      const skills = join(nativeDir, "claude-code", ".claude", "skills");
      const placed = await readdir(skills);
      expect(placed.length).toBe(1);
      expect(await w.exists(join(skills, placed[0] as string, "SKILL.md"))).toBe(true);
      expect(await w.hashRoots()).toEqual(rootsBefore);
      await ok(["clean", ...sid(id)], env);
      // The placed skill (directory and files) is gone. Only the empty `--add-dir` skeleton that
      // placement created stays (mode 0700); nothing else, and nothing that held the skill.
      expect(await hashTree(nativeDir)).toEqual({
        ...before,
        "/claude-code/": "700 dir",
        "/claude-code/.claude/": "700 dir",
        "/claude-code/.claude/skills/": "700 dir",
      });
      expect(await w.hashRoots()).toEqual(rootsBefore);
    },
    SLOW,
  );
});

describe("explicit invocation", () => {
  for (const t of TARGETS) {
    it(
      `${t.label}: manual mode needs --explicit to discover`,
      async () => {
        await setup(t);
        const env = { DYNAMIC_SKILLS_HARNESS: t.harness };
        const plain = await ok(["assess", "--task", TASK, "--mode", "manual"], env);
        expect(plain.recommendation).toBe("none");
        const explicit = await ok(
          ["assess", "--task", TASK, "--mode", "manual", "--explicit"],
          env,
        );
        expect(explicit.recommendation).toBe("discover");
      },
      SLOW,
    );
  }
});

describe("headless questions", () => {
  for (const t of TARGETS) {
    it(
      `${t.label}: options question maps to ${t.tool}; a skipped answer records the assumption`,
      async () => {
        await setup(t);
        const id = (await ok(["assess", "--task", TASK])).sessionId as string;
        await ok(["discover", ...sid(id)]);
        await ok([
          "context",
          "submit",
          ...sid(id),
          "--file",
          await w.doc("analysis.json", await fixtureJson("analysis/ts-monorepo-caching.json")),
        ]);
        await ok([
          "sufficiency",
          "submit",
          ...sid(id),
          "--file",
          await w.doc("verdict.json", {
            schemaVersion: "1",
            outcome: "insufficient",
            rationale: "Nothing covers it",
          }),
        ]);
        const asked = await ok([
          "clarify",
          "ask",
          ...sid(id),
          "--harness",
          t.harness,
          "--file",
          await w.doc("ask.json", {
            schemaVersion: "1",
            questions: [
              {
                id: "q1",
                text: "Which cache backend is available in production?",
                requirement: "unknown.which-cache-backend-is-available-in-prod",
                material: true,
                blocking: false,
                options: [
                  { label: "Redis", description: "Shared network cache" },
                  { label: "In-process", description: "Per-process memory cache" },
                ],
              },
            ],
          }),
        ]);
        expect(asked.native.tool).toBe(t.tool);
        await ok([
          "clarify",
          "answer",
          ...sid(id),
          "--file",
          await w.doc("answer.json", {
            schemaVersion: "1",
            answers: [
              {
                questionId: "q1",
                status: "skipped",
                assumption: {
                  assumption: "Use an in-process cache behind an interface",
                  basis: "Non-interactive run, no backend named",
                  impact: "Backend swap needed later",
                },
              },
            ],
          }),
        ]);
        const compiled = await ok(["compile", ...sid(id)]);
        await installGolden(compiled, GOLDEN);
        await ok(["evaluate", ...sid(id)]);
        await ok([
          "eval",
          "record",
          ...sid(id),
          "--output",
          await w.doc("out.txt", PASS_OUTPUT),
          "--verdict",
          "pass",
        ]);
        await ok(["activate", ...sid(id)]);
        const assumptions = await w.readJson(id, "reports/assumptions.json");
        expect(JSON.stringify(assumptions)).toContain("in-process cache behind an interface");
      },
      SLOW,
    );
  }
});

describe("R31 program-level options before a subcommand", () => {
  const cases = [
    ["-V", "save", "--session", "x", "--scope", "project"],
    ["--version", "init", "--harness", "codex"],
    ["--help", "save"],
  ];
  for (const argv of cases) {
    it(
      `${argv.join(" ")} exits USAGE and writes nothing`,
      async () => {
        const homeBefore = await hashTree(w.userHome);
        const repoBefore = await hashTree(w.repo);
        const r = await w.run(argv);
        expect(r.exitCode).toBe(1);
        expect(r.out).toMatchObject({ ok: false, error: "USAGE" });
        expect(await hashTree(w.userHome)).toEqual(homeBefore);
        expect(await hashTree(w.repo)).toEqual(repoBefore);
        expect(await readdir(w.dsHome)).toEqual([]);
      },
      SLOW,
    );
  }
});
