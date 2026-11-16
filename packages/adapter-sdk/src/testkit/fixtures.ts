import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessAdapter, HostEnv, HostProbe } from "../types";

/** Repository root, found from this file's location (`packages/adapter-sdk/src/testkit`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The bundle used by the save cases. */
export const SAVE_FIXTURE = join(REPO_ROOT, "fixtures/skills/valid/order-cache-specialist");

/** Name of {@link SAVE_FIXTURE}. */
export const SAVE_FIXTURE_NAME = "order-cache-specialist";

/** Reads the bootstrap skill bytes the installers must place. */
export function readBootstrap(): Promise<Buffer> {
  return readFile(join(REPO_ROOT, "skills/dynamic-skill-bootstrap/SKILL.md"));
}

/** A temporary world for one case. */
export interface World {
  /** Realpath of the temp root. */
  root: string;
  /** Realpath of the home copy. */
  home: string;
  /** Realpath of the project (has `.git`). */
  project: string;
  /** Session home through the alias (not created). */
  sessionAlias: string;
  /** Session home as a real path (not created). */
  sessionReal: string;
  /** Parent of the session home; hashed to prove a dry run creates nothing. */
  sessionParent: string;
  /** Realpath of the system configuration directory. */
  etcDir: string;
  /** Environment variables the adapter sees. */
  vars: Record<string, string | undefined>;
  /** Host environment. */
  env: HostEnv;
  /** Removes the world. */
  cleanup(): Promise<void>;
}

/** What a world needs from its target. */
export interface WorldInput {
  /** Fixture home directory to copy. */
  fixtureHome: string;
  /** Extra variables; `{home}` and `{session}` are replaced. */
  vars?: Record<string, string>;
  /** Fake `--version` stdout. */
  versionOutput: string;
  /** The adapter under test. */
  adapter: HarnessAdapter;
  /** The binary is on `PATH` (default true). */
  withBinary?: boolean;
  /** Extra variables applied last (not placeholder-expanded). */
  extraVars?: Record<string, string | undefined>;
}

/** A probe that knows only the adapter's binary. */
export function fakeProbe(
  adapter: HarnessAdapter,
  versionOutput: string,
  present: boolean,
): HostProbe {
  const known = (bin: string): boolean => present && bin.split("/").pop() === adapter.binary;
  return {
    async which(bin) {
      return known(bin) ? `/fake/bin/${adapter.binary}` : null;
    },
    async run(bin, args) {
      if (known(bin) && args.length === 1 && args[0] === "--version") {
        return { code: 0, stdout: versionOutput, stderr: "" };
      }
      return { code: -1, stdout: "", stderr: "unknown command" };
    },
  };
}

/** Builds a tmp world: home copy, project with `.git`, aliased session home, etc dir. */
export async function makeWorld(input: WorldInput): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "compat-")));
  const home = join(root, "home");
  const project = join(root, "project");
  const etcDir = join(root, "etc");
  await cp(input.fixtureHome, home, { recursive: true, verbatimSymlinks: true });
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(etcDir);
  await mkdir(join(root, "real"));
  await symlink(join(root, "real"), join(root, "alias"));
  const sessionAlias = join(root, "alias", "session");
  const sessionReal = join(root, "real", "session");
  const expand = (v: string): string =>
    v.split("{home}").join(home).split("{session}").join(sessionAlias);
  const vars: Record<string, string | undefined> = {
    HOME: home,
    PATH: "/fake/bin",
    DYNAMIC_SKILLS_HOME: sessionAlias,
  };
  for (const [k, v] of Object.entries(input.vars ?? {})) vars[k] = expand(v);
  Object.assign(vars, input.extraVars ?? {});
  const env: HostEnv = {
    projectRoot: project,
    userHome: home,
    sessionHome: sessionReal,
    etcDir,
    vars,
    probe: fakeProbe(input.adapter, input.versionOutput, input.withBinary !== false),
  };
  return {
    root,
    home,
    project,
    sessionAlias,
    sessionReal,
    sessionParent: join(root, "real"),
    etcDir,
    vars,
    env,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Hash of a tree: paths, types, modes, file bytes and symlink targets. Missing path hashes as "absent". */
export async function treeHash(dir: string): Promise<string> {
  const h = createHash("sha256");
  async function visit(p: string, rel: string): Promise<void> {
    const st = await lstat(p);
    h.update(`${rel}\0${(st.mode & 0o7777).toString(8)}\0`);
    if (st.isSymbolicLink()) h.update(`L${await readlink(p)}\n`);
    else if (st.isDirectory()) {
      h.update("D\n");
      for (const n of (await readdir(p)).sort()) await visit(join(p, n), `${rel}/${n}`);
    } else
      h.update(
        `F${createHash("sha256")
          .update(await readFile(p))
          .digest("hex")}\n`,
      );
  }
  try {
    await visit(dir, "");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
  return h.digest("hex");
}

/** Reads every regular file under `dir` into a map of relative path to bytes. */
export async function readTree(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  async function visit(p: string, rel: string): Promise<void> {
    const st = await lstat(p);
    if (st.isDirectory()) {
      for (const n of await readdir(p)) await visit(join(p, n), rel === "" ? n : `${rel}/${n}`);
    } else if (st.isFile()) out.set(rel, await readFile(p));
  }
  await visit(dir, "");
  return out;
}
