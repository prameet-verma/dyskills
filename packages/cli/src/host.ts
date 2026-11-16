import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { realpathEnsured, realpathOfPlanned } from "@dynamic-skills/adapter-sdk";
import type { HostEnv, HostProbe } from "@dynamic-skills/adapter-sdk";
import { findProjectRoot } from "@dynamic-skills/bootstrapper";
import { SessionStore, UnsafeHomeError } from "@dynamic-skills/core";
import { CliError } from "./io";

/** Inputs of {@link buildHostEnv}. */
export interface HostEnvInput {
  /** Directory the task runs in; the project root is its nearest `.git` ancestor. */
  repo: string;
  /** The user's home directory. */
  userHome: string;
  /** The dynamic-skills session home. */
  home: string;
  /** Environment variables visible to the host. */
  vars: Readonly<Record<string, string | undefined>>;
  /** Binary lookup and command execution. */
  probe: HostProbe;
  /** System configuration directory (`/etc` in production). */
  etcDir: string;
  /** Preview only: resolve the session home without creating or checking it. */
  dryRun?: boolean;
}

/**
 * The system configuration directory: the explicit value, else an absolute
 * `DYNAMIC_SKILLS_ETC_DIR` (mainly for tests; empty or relative counts as unset), else `/etc`.
 * @param explicit - Value injected by the caller.
 * @param vars - Environment variables of the invocation.
 */
export function resolveEtcDir(
  explicit: string | undefined,
  vars: Readonly<Record<string, string | undefined>>,
): string {
  if (explicit !== undefined) return explicit;
  const v = vars.DYNAMIC_SKILLS_ETC_DIR;
  return v !== undefined && v !== "" && isAbsolute(v) ? v : "/etc";
}

/** Realpath that turns a missing or unreadable path into a `USAGE` error. */
async function realOrUsage(path: string, what: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new CliError("USAGE", `${what} cannot be resolved to a real directory.`);
  }
}

/**
 * Builds the {@link HostEnv} adapters plan against; every directory in it is a realpath.
 *
 * Without `dryRun` the session home is checked (`SessionStore.prepare`) and created. With
 * `dryRun` nothing is created: the home is resolved with `realpathOfPlanned`, whose `ENOENT`
 * (dangling link), `ELOOP` and `ENOTDIR` failures become a `HOME_UNSAFE` error rather than a crash.
 *
 * @param input - Paths, environment and probe of this invocation.
 * @returns The host environment.
 * @throws {UnsafeHomeError} for a session home that is a symlink or not a directory.
 * @throws {CliError} `HOME_UNSAFE` for an unresolvable session home, `USAGE` for an unresolvable
 * repository or user home.
 */
export async function buildHostEnv(input: HostEnvInput): Promise<HostEnv> {
  // A relative home (DYNAMIC_SKILLS_HOME is passed through unresolved) means the same thing in
  // dry-run and for real.
  const home = resolve(input.home);
  let sessionHome: string;
  if (input.dryRun === true) {
    try {
      sessionHome = await realpathOfPlanned(home);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "unknown";
      throw new CliError("HOME_UNSAFE", `The session home cannot be resolved (${code}).`);
    }
    // Read-only version of the real run's safety check: an existing home must be a real
    // directory, never a symlink or a file.
    const info = await lstat(home).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw new UnsafeHomeError(home, `cannot be inspected (${e.code ?? "unknown"})`);
    });
    if (info !== null && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new UnsafeHomeError(
        home,
        info.isSymbolicLink() ? "is a symlink" : "is not a directory",
      );
    }
  } else {
    await new SessionStore(home).prepare();
    sessionHome = await realpathEnsured(home);
  }
  const projectRoot = await realOrUsage(await findProjectRoot(input.repo), "The repository");
  const userHome = await realOrUsage(input.userHome, "The user home");
  return {
    projectRoot,
    userHome,
    sessionHome,
    etcDir: input.etcDir,
    vars: input.vars,
    probe: input.probe,
  };
}
