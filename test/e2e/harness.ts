/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveSkillRoots } from "../../packages/bootstrapper/src/index";

/** Repository root of the monorepo under test. */
export const ROOT = resolve(import.meta.dirname, "../..");
const BIN = join(ROOT, "packages/cli/dist/index.js");
/** Generous per-test timeout for tests that spawn the binary many times (the machine is often loaded). */
export const SLOW = 180_000;
export const TASK = "Add caching to order reads in the orders service";

/** Result of one spawned CLI call. */
export interface Run {
  exitCode: number;
  out: Record<string, any>;
  stdout: string;
  stderr: string;
}

/** A throwaway world: repo copy, session home and user home, none of them the real ones. */
export interface World {
  tmp: string;
  repo: string;
  /** `DYNAMIC_SKILLS_HOME`. */
  dsHome: string;
  /** `HOME` seen by the CLI. */
  userHome: string;
  /** `DYNAMIC_SKILLS_ETC_DIR`: stands in for `/etc` (the admin Codex skill root lives under it). */
  etcDir: string;
  /**
   * Writes executable fake harness binaries (and optionally a `dynamic-skills` shim that runs the
   * built CLI) into `<tmp>/bin` and puts that directory first on the spawned `PATH`. A fake echoes
   * its version for `--version` and exits 0 for anything else; no real harness ever runs.
   */
  fakeBins(versions: Record<string, string>, opts?: { dynamicSkillsShim?: boolean }): Promise<void>;
  /** sha256 trees of every permanent skill root the three harnesses read (not `<dsHome>/native`). */
  hashRoots(): Promise<Record<string, Record<string, string>>>;
  /** Spawns the built CLI with a minimal environment. */
  run(argv: string[], env?: Record<string, string>): Promise<Run>;
  /** Writes a JSON document (or raw string) into the tmp dir and returns its path. */
  doc(name: string, value: unknown): Promise<string>;
  readJson(id: string, rel: string): Promise<any>;
  exists(p: string): Promise<boolean>;
  session(id: string): string;
  cleanup(): Promise<void>;
}

/** Creates a {@link World} with the `ts-monorepo` fixture copied to a tmp repo. */
export async function world(): Promise<World> {
  const tmp = await mkdtemp(join(tmpdir(), "ds-e2e-"));
  const repo = join(tmp, "repo");
  const dsHome = join(tmp, "dshome");
  const userHome = join(tmp, "user");
  const etcDir = join(tmp, "etc");
  const binDir = join(tmp, "bin");
  let binsOn = false;
  await cp(join(ROOT, "fixtures/repos/ts-monorepo"), repo, { recursive: true });
  await mkdir(dsHome, { recursive: true });
  await mkdir(userHome, { recursive: true });
  await mkdir(etcDir, { recursive: true });
  const session = (id: string) => join(dsHome, "sessions", id);
  return {
    tmp,
    repo,
    dsHome,
    userHome,
    etcDir,
    session,
    async fakeBins(versions, opts = {}) {
      await mkdir(binDir, { recursive: true });
      binsOn = true;
      const write = async (name: string, body: string) => {
        const p = join(binDir, name);
        await writeFile(p, `#!/bin/sh\n${body}\n`);
        await chmod(p, 0o755);
      };
      for (const [name, version] of Object.entries(versions)) {
        await write(name, `if [ "$1" = "--version" ]; then echo '${version}'; fi\nexit 0`);
      }
      if (opts.dynamicSkillsShim) {
        await write("dynamic-skills", `exec '${process.execPath}' '${BIN}' "$@"`);
      }
    },
    async hashRoots() {
      const roots = await resolveSkillRoots({ repo, home: userHome, vars: {}, etcDir });
      const out: Record<string, Record<string, string>> = {};
      for (const r of roots) out[r.dir] = await hashTree(r.dir);
      return out;
    },
    run(argv, env = {}) {
      return new Promise((done, fail) => {
        execFile(
          process.execPath,
          [BIN, ...argv],
          {
            cwd: repo,
            // Minimal env: nothing of the real user's environment or home reaches the CLI.
            env: {
              PATH: binsOn ? `${binDir}:${dirname(process.execPath)}` : dirname(process.execPath),
              HOME: userHome,
              TMPDIR: tmp,
              DYNAMIC_SKILLS_HOME: dsHome,
              DYNAMIC_SKILLS_ETC_DIR: etcDir,
              ...env,
            },
            // Generous: spawned binaries are slow on a loaded machine.
            timeout: 90_000,
          },
          (err, stdout, stderr) => {
            const code = err ? ((err as { code?: unknown }).code as number) : 0;
            try {
              done({ exitCode: code, out: JSON.parse(stdout), stdout, stderr });
            } catch {
              fail(new Error(`non-JSON stdout (exit ${code}): ${stdout}\n${stderr}`));
            }
          },
        );
      });
    },
    async doc(name, value) {
      const p = join(tmp, name);
      await writeFile(p, typeof value === "string" ? value : JSON.stringify(value));
      return p;
    },
    async readJson(id, rel) {
      return JSON.parse(await readFile(join(session(id), rel), "utf8"));
    },
    exists: (p) =>
      stat(p).then(
        () => true,
        () => false,
      ),
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

/** sha256 of every file under `dir`, keyed by relative path (empty for a missing directory). */
export async function hashTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
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

/** Reads a fixture file as text. */
export const fixtureText = (rel: string) => readFile(join(ROOT, "fixtures", rel), "utf8");
/** Parses a fixture JSON file. */
export const fixtureJson = async (rel: string): Promise<any> => JSON.parse(await fixtureText(rel));

/**
 * Copies a golden skill and `smoke.json` into a compiled session and returns the skill path. A new
 * skill's name is the agent's choice, so `compile` returns `skillPath: null` and the skill goes in
 * `<skillsDir>/<name>/SKILL.md`; an augmentation's path is fixed and returned as `skillPath`.
 */
export async function installGolden(
  compiled: Record<string, any>,
  fixture: "valid/order-cache-specialist" | "augmentation/order-caching-augment",
): Promise<string> {
  const skillPath: string =
    compiled.skillPath ?? join(compiled.skillsDir, fixture.split("/")[1] as string, "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await cp(join(ROOT, "fixtures/skills", fixture, "SKILL.md"), skillPath);
  await mkdir(dirname(compiled.smokeEvalPath), { recursive: true });
  await cp(join(ROOT, "fixtures/skills/smoke.json"), compiled.smokeEvalPath);
  return skillPath;
}
