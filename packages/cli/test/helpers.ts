/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCli } from "../src/run";

/** Repository root of the monorepo under test. */
export const ROOT = resolve(import.meta.dirname, "../../..");
/** The caching task used by most tests. */
export const CACHING_TASK = "Add caching to order reads in the orders service";

/** Parsed result of one in-process CLI call. */
export interface Call {
  exitCode: number;
  out: Record<string, any>;
  stderr: string;
}

/** A throwaway environment: repo copy, session home, user home and a controllable clock. */
export interface Harness {
  repo: string;
  home: string;
  userHome: string;
  tmp: string;
  clock: { t: number };
  run(argv: string[]): Promise<Call>;
  /** Writes a JSON document into the tmp dir and returns its path. */
  doc(name: string, value: unknown): Promise<string>;
  /** Reads a file inside a session directory. */
  read(sessionId: string, rel: string): Promise<string>;
  readJson(sessionId: string, rel: string): Promise<any>;
  exists(sessionId: string, rel: string): Promise<boolean>;
  /** Copies the augmentation base skill into the user's personal skill directory. */
  installBase(): Promise<string>;
  cleanup(): Promise<void>;
}

/** Creates a {@link Harness} with the `ts-monorepo` fixture copied to a tmp repo. */
export async function harness(fixture = "ts-monorepo"): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), "ds-cli-"));
  const repo = join(tmp, "repo");
  const home = join(tmp, "home");
  const userHome = join(tmp, "user");
  await cp(join(ROOT, "fixtures/repos", fixture), repo, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });
  const clock = { t: 1_700_000_000_000 };
  const sessionDir = (id: string, rel: string) => join(home, "sessions", id, rel);
  return {
    repo,
    home,
    userHome,
    tmp,
    clock,
    async run(argv) {
      const r = await runCli(argv, { home, cwd: repo, userHome, now: () => clock.t });
      return { exitCode: r.exitCode, out: JSON.parse(r.stdout), stderr: r.stderr };
    },
    async doc(name, value) {
      const p = join(tmp, name);
      await writeFile(p, typeof value === "string" ? value : JSON.stringify(value));
      return p;
    },
    read: (id, rel) => readFile(sessionDir(id, rel), "utf8"),
    async readJson(id, rel) {
      return JSON.parse(await readFile(sessionDir(id, rel), "utf8"));
    },
    exists: (id, rel) =>
      stat(sessionDir(id, rel)).then(
        () => true,
        () => false,
      ),
    async installBase() {
      const dest = join(userHome, ".agents/skills/order-caching");
      await cp(join(ROOT, "fixtures/skills/augmentation-base/order-caching"), dest, {
        recursive: true,
      });
      return join(dest, "SKILL.md");
    },
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

/**
 * sha256 of every file under `dir`, keyed by relative path (empty for a missing directory).
 * @param exclude - Directories relative to `dir` that are skipped.
 */
export async function hashTree(
  dir: string,
  exclude: string[] = [],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(d, e.name);
      if (exclude.includes(p.slice(dir.length + 1))) continue;
      if (e.isDirectory()) await walk(p);
      else
        out[p.slice(dir.length)] = createHash("sha256")
          .update(await readFile(p))
          .digest("hex");
    }
  };
  await walk(dir);
  return out;
}

/** Runs `assess` and returns the new session id. */
export async function assess(
  h: Harness,
  task = CACHING_TASK,
  extra: string[] = [],
): Promise<string> {
  const r = await h.run(["assess", "--task", task, ...extra]);
  if (r.exitCode !== 0) throw new Error(JSON.stringify(r.out));
  return r.out.sessionId as string;
}

/** Runs `assess` then `discover`. */
export async function discovered(
  h: Harness,
  task = CACHING_TASK,
  extra: string[] = [],
): Promise<string> {
  const id = await assess(h, task, extra);
  const r = await h.run(["discover", "--session", id]);
  if (r.exitCode !== 0) throw new Error(JSON.stringify(r.out));
  return id;
}

/** Reads a fixture analysis document. */
export async function analysisFixture(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(ROOT, "fixtures/analysis", name), "utf8"));
}

/** Runs `assess`, `discover` and `context submit` with the minimal analysis. */
export async function analysed(
  h: Harness,
  task = CACHING_TASK,
  extra: string[] = [],
): Promise<string> {
  const id = await discovered(h, task, extra);
  const file = await h.doc("analysis.json", await analysisFixture("minimal.json"));
  const r = await h.run(["context", "submit", "--session", id, "--file", file]);
  if (r.exitCode !== 0) throw new Error(JSON.stringify(r.out));
  return id;
}

/** Builds a sufficiency verdict document. */
export function verdict(over: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "1",
    outcome: "insufficient",
    rationale: "Test verdict.",
    missingAspects: [],
    coveredAspects: [],
    ...over,
  };
}

/** The fixture analysis that grounds the golden skills. */
export async function groundedAnalysis(h: Harness, id: string): Promise<void> {
  const file = await h.doc("analysis.json", await analysisFixture("ts-monorepo-caching.json"));
  const r = await h.run(["context", "submit", "--session", id, "--file", file]);
  if (r.exitCode !== 0) throw new Error(JSON.stringify(r.out));
}

/**
 * Runs assess, discover, context submit (grounding analysis) and sufficiency submit. With
 * `partial` the base skill is installed first and the verdict names its scanned path.
 */
export async function ready(
  h: Harness,
  kind: "insufficient" | "partial" = "insufficient",
  extra: string[] = [],
): Promise<string> {
  if (kind === "partial") await h.installBase();
  const id = await discovered(h, CACHING_TASK, extra);
  await groundedAnalysis(h, id);
  const doc =
    kind === "partial"
      ? verdict({
          outcome: "partial",
          baseSkill: {
            name: "order-caching",
            path: (await h.readJson(id, "skills-scan.json")).skills[0].path,
          },
          missingAspects: ["Repository read and write paths"],
          coveredAspects: ["Cache keys and TTLs"],
        })
      : verdict({ outcome: "insufficient" });
  const file = await h.doc("verdict.json", doc);
  const r = await h.run(["sufficiency", "submit", "--session", id, "--file", file]);
  if (r.exitCode !== 0) throw new Error(JSON.stringify(r.out));
  return id;
}

/** Copies a golden skill fixture and `smoke.json` into the paths `compile` returned. */
export async function installGolden(
  h: Harness,
  id: string,
  fixture: "valid/order-cache-specialist" | "augmentation/order-caching-augment",
): Promise<string> {
  const name = fixture.split("/")[1] as string;
  const dest = join(h.home, "sessions", id, "skills", name);
  await mkdir(dirname(dest), { recursive: true });
  await cp(join(ROOT, "fixtures/skills", fixture), dest, { recursive: true });
  await mkdir(join(h.home, "sessions", id, "evals"), { recursive: true });
  await cp(
    join(ROOT, "fixtures/skills/smoke.json"),
    join(h.home, "sessions", id, "evals/smoke.json"),
  );
  return join(dest, "SKILL.md");
}

/** Records a passing behavioural result. */
export async function record(
  h: Harness,
  id: string,
  output = "Plan: invalidate the cache on every order write.",
  verdictValue = "pass",
): Promise<Call> {
  const file = await h.doc("output.txt", output);
  return h.run(["eval", "record", "--session", id, "--output", file, "--verdict", verdictValue]);
}
