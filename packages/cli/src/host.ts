import { realpath } from "node:fs/promises";
import { realpathEnsured, realpathOfPlanned } from "@dynamic-skills/adapter-sdk";
import type { HostEnv, HostProbe } from "@dynamic-skills/adapter-sdk";
import { findProjectRoot } from "@dynamic-skills/bootstrapper";
import { SessionStore } from "@dynamic-skills/core";
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
 * @throws {CliError} `HOME_UNSAFE` for an unusable session home, `USAGE` for an unresolvable
 * repository or user home.
 */
export async function buildHostEnv(input: HostEnvInput): Promise<HostEnv> {
  let sessionHome: string;
  if (input.dryRun === true) {
    try {
      sessionHome = await realpathOfPlanned(input.home);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "unknown";
      throw new CliError("HOME_UNSAFE", `The session home cannot be resolved (${code}).`);
    }
  } else {
    await new SessionStore(input.home).prepare();
    sessionHome = await realpathEnsured(input.home);
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
