import { lstat, readFile, readdir, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  BundleLayoutError,
  bundleManifest,
  findSaveConflicts,
  placeBundle,
  planSaveTargets,
  removePlacedBundle,
} from "@dynamic-skills/adapter-sdk";
import type { BundleManifest, ReadRoot } from "@dynamic-skills/adapter-sdk";
import type { Harness } from "@dynamic-skills/core";
import { ADAPTERS, currentHarness, harnessOptionSpec, parseHarnessList } from "../adapters";
import { buildHostEnv } from "../host";
import { CliError } from "../io";
import { assertCanSave } from "../state-machine";
import { assertBundlePinned, bundleChanged, sessionPaths } from "./bundle";
import { discardSession, endAbandonedSession } from "./clean";
import type { SessionCommandDef } from "./types";

/** Shown for every denied write; the cause (permissions, a sandbox, a read-only mount) is the host's. */
const DENIED_MESSAGE =
  "The host or file system denied the write; see the install guide for your host.";

/** errno codes that mean the host or file system refused the write. */
const DENIED_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EROFS"]);

/** File names the OS drops into `skills/`; ignored when looking for the bundle directory. */
const OS_JUNK: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** One bundle this call placed (and may have to take back). */
interface Created {
  root: string;
  path: string;
  /** Manifest of what was actually placed (it may differ from the evaluated one if the source changed). */
  sha256: string;
  /** The root did not exist before this call, so an empty root is removed again on rollback. */
  rootWasNew: boolean;
  /** Topmost directory `placeBundle` created for this bundle, when the SDK reports it. */
  createdRoot?: string;
}

/** The single skill directory under the session's `skills/`; anything else is an invalid bundle. */
async function sourceDir(sessionDir: string): Promise<string> {
  const { skillsDir } = sessionPaths(sessionDir);
  const names = (await readdir(skillsDir).catch(() => [] as string[])).filter(
    (n) => !OS_JUNK.has(n),
  );
  if (names.length !== 1) {
    throw new CliError("BUNDLE_INVALID", "skills/ must hold exactly one skill directory");
  }
  const dir = join(skillsDir, names[0] as string);
  if (!(await lstat(dir)).isDirectory()) {
    throw new CliError("BUNDLE_INVALID", "skills/ must hold exactly one skill directory");
  }
  return dir;
}

/** True when `chunk` holds `needle` as a whole path prefix (not followed by a name character). */
function mentionsPath(chunk: Buffer, needle: string): boolean {
  const bytes = Buffer.from(needle);
  let from = 0;
  for (;;) {
    const at = chunk.indexOf(bytes, from);
    if (at < 0) return false;
    const next = chunk[at + bytes.length];
    // `/home/u` inside `/home/user2` is not a mention of `/home/u`.
    if (next === undefined || !/[A-Za-z0-9._-]/.test(String.fromCharCode(next))) return true;
    from = at + 1;
  }
}

/** The first bundle file that names the session home or the user home (in any spelling). */
async function findMachinePath(
  src: string,
  manifest: BundleManifest,
  spellings: (string | undefined)[],
): Promise<string | null> {
  const needles = new Set<string>();
  for (const s of spellings) {
    const trimmed = s?.replace(/\/+$/, "") ?? "";
    // "" and "/" would match every absolute path.
    if (trimmed.length > 1) needles.add(trimmed);
  }
  for (const f of manifest.files) {
    const bytes = await readFile(join(src, f.path));
    for (const n of needles) if (mentionsPath(bytes, n)) return f.path;
  }
  return null;
}

/** Takes back every bundle this call created, newest first; never throws. */
async function rollback(created: Created[]): Promise<void> {
  for (const c of [...created].reverse()) {
    await removePlacedBundle(c.path, c.sha256, c.root);
    if (c.createdRoot !== undefined) {
      // Empty parents the placement created, deepest first, never `rm -r`: stop at the first
      // directory that is not empty (or not ours) and at `createdRoot` itself.
      let dir = dirname(c.path);
      while (dir === c.createdRoot || dir.startsWith(`${c.createdRoot}${sep}`)) {
        if (
          !(await rmdir(dir).then(
            () => true,
            () => false,
          ))
        )
          break;
        if (dir === c.createdRoot) break;
        dir = dirname(dir);
      }
    } else if (c.rootWasNew) await rmdir(c.root).catch(() => undefined);
  }
}

/** Whether `path` exists (lstat). */
const present = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

/**
 * `save`: the explicit way a generated skill outlives its session (PRD §11.1, D6, D8). Saving asks
 * for consent; that is the host's job through the rules `init` writes, so the CLI saves only when
 * this command is run. `project` and `personal` copy the evaluated bundle byte-identically to the
 * skill root of each selected harness (the fewest roots that cover them all), `ephemeral` writes
 * nothing, `discard` removes the session like `clean`. A saved skill carries no freshness
 * fingerprint, and an augmentation cannot be saved yet (`SAVE_UNSUPPORTED`). A failed save removes
 * every bundle this call created.
 */
export const saveCommand: SessionCommandDef = {
  name: "save",
  kind: "session",
  description: "Save the activated skill to a project or personal skill root, or discard it.",
  options: [
    {
      flags: "--scope <scope>",
      description: "Where the skill goes.",
      required: true,
      choices: ["project", "personal", "ephemeral", "discard"],
    },
    harnessOptionSpec("Harnesses the saved skill must be visible to (project and personal)."),
    { flags: "--dry-run", description: "Report what would be saved and write nothing." },
  ],
  step: null,
  stage: null,
  bypassDeadline: true,
  async run({ store, state, opts, userHome, vars, probe, etcDir, now }) {
    const scope = opts.scope as "project" | "personal" | "ephemeral" | "discard";
    assertCanSave(state, scope);
    const sessionDir = store.dir(state.id);

    if (scope === "ephemeral") {
      return {
        data: {
          scope,
          saved: [],
          sessionDir,
          dryRun: opts.dryRun === true,
          notes: ["The skill stays in the session directory until clean."],
        },
        save: false,
        recordStep: false,
      };
    }
    if (scope === "discard") {
      // Ruling R45: a dry run reports and changes nothing (the session is not even ended).
      if (opts.dryRun === true) {
        return {
          data: {
            scope,
            removed: false,
            archived: null,
            dryRun: true,
            notes: ["Dry run: the session would be discarded; nothing was changed."],
          },
          save: false,
          recordStep: false,
        };
      }
      await endAbandonedSession(store, state, now());
      const { archived, notes } = await discardSession(store, state);
      return { data: { scope, removed: true, archived, notes }, save: false, recordStep: false };
    }

    let harnesses: Harness[];
    if (typeof opts.harness === "string") harnesses = parseHarnessList(opts.harness);
    else {
      const current = currentHarness(undefined, vars);
      if (current === null) {
        throw new CliError(
          "USAGE",
          "save needs --harness <list> (or DYNAMIC_SKILLS_HARNESS) to know which harnesses must see the skill.",
        );
      }
      harnesses = [current];
    }
    const dryRun = opts.dryRun === true;

    // Ruling R14: only the evaluated bundle is saved.
    await assertBundlePinned(state, sessionDir);
    const src = await sourceDir(sessionDir);
    const name = basename(src);
    let manifest: BundleManifest;
    try {
      manifest = await bundleManifest(src);
    } catch (e) {
      if (e instanceof BundleLayoutError) throw new CliError("BUNDLE_INVALID", e.message);
      throw e;
    }

    const env = await buildHostEnv({
      repo: state.repo,
      userHome,
      home: store.home,
      vars,
      probe,
      etcDir,
    });

    if (scope === "project") {
      const hit = await findMachinePath(src, manifest, [
        env.sessionHome,
        resolve(store.home),
        env.userHome,
        userHome,
        vars.HOME,
      ]);
      if (hit !== null) {
        throw new CliError(
          "SAVE_CONFLICT",
          `${hit} names a path on this machine (the session home or the user home); a committed skill must not. Remove it and run evaluate again.`,
          { reason: "machine path", conflicts: [hit] },
        );
      }
    }

    const readRoots: Partial<Record<Harness, ReadRoot[]>> = {};
    const primary: Partial<Record<Harness, string>> = {};
    const roots = new Set<string>();
    for (const id of harnesses) {
      const adapter = ADAPTERS[id];
      readRoots[id] = await adapter.readRoots(env);
      primary[id] = adapter.skillRoot(env, scope);
      for (const r of readRoots[id] ?? []) roots.add(r.dir);
    }
    const conflicts = await findSaveConflicts({
      name,
      manifestSha256: manifest.sha256,
      roots: [...roots],
    });
    if (conflicts.length > 0) {
      throw new CliError(
        "SAVE_CONFLICT",
        `A different skill named ${name} already exists where a selected harness reads skills; nothing was written.`,
        { reason: "name in use", conflicts },
      );
    }
    const targets = planSaveTargets({ harnesses, primary, readRoots });

    const created: Created[] = [];
    const saved: { root: string; path: string; covers: Harness[]; action: string }[] = [];
    try {
      for (const t of targets) {
        const rootWasNew = !dryRun && !(await present(t.root));
        const placed = await placeBundle({
          srcDir: src,
          destRoot: t.root,
          name,
          mode: "save",
          within: scope === "project" ? env.projectRoot : null,
          dryRun,
        });
        if (placed.action === "conflict") {
          throw new CliError(
            "SAVE_CONFLICT",
            `${placed.path} cannot be written (${placed.reason ?? "conflict"}); nothing was kept.`,
            {
              reason: placed.reason ?? "conflict",
              path: placed.path,
              ...(placed.detail !== undefined ? { detail: placed.detail } : {}),
            },
          );
        }
        if (placed.action === "create" && !dryRun) {
          created.push({
            root: t.root,
            path: placed.path,
            sha256: placed.manifest.sha256,
            rootWasNew,
            // FW1's SDK reports the topmost directory it created; older SDKs do not.
            ...(typeof (placed as { createdRoot?: unknown }).createdRoot === "string"
              ? { createdRoot: (placed as unknown as { createdRoot: string }).createdRoot }
              : {}),
          });
        }
        // AC 20: what was written is what was evaluated.
        if (placed.manifest.sha256 !== manifest.sha256) throw bundleChanged();
        saved.push({ root: t.root, path: placed.path, covers: t.covers, action: placed.action });
      }
      // The bundle may have been edited while it was being copied.
      if (!dryRun) await assertBundlePinned(state, sessionDir);
    } catch (e) {
      await rollback(created);
      if (e instanceof BundleLayoutError) throw new CliError("BUNDLE_INVALID", e.message);
      const code = (e as NodeJS.ErrnoException).code;
      if (typeof code === "string" && DENIED_CODES.has(code)) {
        const path = (e as { path?: unknown }).path;
        throw new CliError("SAVE_DENIED", DENIED_MESSAGE, {
          path: typeof path === "string" ? path : (targets[saved.length]?.root ?? ""),
        });
      }
      throw e;
    }

    const notes: string[] = [];
    for (const id of harnesses) {
      const adapter = ADAPTERS[id];
      for (const n of adapter.saveNotes(await adapter.detect(env))) {
        if (!notes.includes(n)) notes.push(n);
      }
    }
    return {
      data: { scope, skill: name, manifestSha256: manifest.sha256, dryRun, saved, notes },
      save: false,
      recordStep: false,
    };
  },
};
