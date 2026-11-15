import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CONTRACT_VERSION, DEFAULT_BUDGET_MS } from "./constants";
import { SessionStateSchema } from "./schemas";
import type { InvocationMode, SessionState, StageName } from "./schemas";
import { SlaClock } from "./sla";

/** A lock file older than this is assumed to belong to a crashed process and is reclaimed. */
const STALE_LOCK_MS = 30_000;

/** Mode of every directory the store creates: owner only (session data is private). */
export const PRIVATE_DIR_MODE = 0o700;

/** Mode of every file the store creates: owner read/write only. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Root directory for ephemeral session data: `DYNAMIC_SKILLS_HOME` if set, otherwise
 * `<os tmpdir>/dynamic-skills-<uid>` (`-user` where the platform has no uid). The uid suffix keeps
 * users of a shared temp dir (Linux `/tmp`) from sharing, or squatting on, one home. Phase 1
 * writes only beneath `<home>/sessions/<id>/`, plus the archived metrics in `<home>/reports/`.
 */
export function resolveHome(): string {
  return (
    process.env.DYNAMIC_SKILLS_HOME ??
    join(tmpdir(), `dynamic-skills-${process.getuid?.() ?? "user"}`)
  );
}

/**
 * Thrown when the session home (or a directory the store keeps directly under it) is not a
 * private directory of the current user: a symlink, not a directory, owned by another uid, or
 * impossible to create. Code `HOME_UNSAFE`.
 */
export class UnsafeHomeError extends Error {
  /** Stable machine-readable error code. */
  readonly code = "HOME_UNSAFE";
  /**
   * Creates the error.
   * @param path - The refused directory.
   * @param reason - Why it was refused.
   */
  constructor(path: string, reason: string) {
    super(
      `Unsafe session home ${path}: ${reason}. Remove it or set DYNAMIC_SKILLS_HOME to a private directory.`,
    );
    this.name = "UnsafeHomeError";
  }
}

/**
 * Filesystem operations {@link ensurePrivateDir} uses, injectable so tests can simulate a
 * directory owned by another user (a real `chown` needs root).
 */
export interface DirProbe {
  /** `lstat` of the path (never follows a symlink). */
  lstat(path: string): Promise<{
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    uid: number;
    mode: number;
  }>;
  /** Changes the permission bits. */
  chmod(path: string, mode: number): Promise<void>;
  /** Current uid; absent on platforms without uids (then owner and mode are not checked). */
  getuid?: () => number;
}

const REAL_PROBE: DirProbe = { lstat, chmod, getuid: process.getuid?.bind(process) };

/**
 * Makes sure `path` is a directory of the current user, creating it (mode 0700) when missing.
 * Refuses a symlink, a non-directory and, where uids exist, a directory owned by another uid: on
 * a shared temp dir another user could pre-create the home to read or redirect session data.
 * The path is run through `path.resolve` first, so a trailing slash cannot make the `lstat` follow
 * a symlink.
 *
 * With `tighten` (the default), a directory of ours that grants any group or other access is
 * changed to 0700 (a directory made by an earlier version, or by hand, is fixed instead of
 * refused). Pass `false` for a directory the store did not create, such as a user-provided
 * `DYNAMIC_SKILLS_HOME` that may be `$HOME` itself: it is checked, never chmodded (Ruling R23).
 *
 * @param path - Directory path.
 * @param probe - Injectable filesystem operations; defaults to the real ones.
 * @param tighten - Whether to remove group and other bits; defaults to `true`.
 * @throws {UnsafeHomeError} when the directory is unsafe or cannot be created.
 */
export async function ensurePrivateDir(
  path: string,
  probe: DirProbe = REAL_PROBE,
  tighten = true,
): Promise<void> {
  const dir = resolve(path);
  // A failure here (for example EEXIST on a dangling symlink) is diagnosed by the lstat below.
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE }).catch(() => undefined);
  let info;
  try {
    info = await probe.lstat(dir);
  } catch {
    throw new UnsafeHomeError(path, "it cannot be created");
  }
  if (info.isSymbolicLink()) throw new UnsafeHomeError(path, "it is a symbolic link");
  if (!info.isDirectory()) throw new UnsafeHomeError(path, "it is not a directory");
  if (probe.getuid === undefined) return;
  if (info.uid !== probe.getuid()) {
    throw new UnsafeHomeError(path, "it is owned by another user");
  }
  if (tighten && (info.mode & 0o077) !== 0) await probe.chmod(dir, PRIVATE_DIR_MODE);
}

/** Thrown by {@link SessionStore.load} when no session exists for an id. Code `SESSION_NOT_FOUND`. */
export class SessionNotFoundError extends Error {
  /** Stable machine-readable error code. */
  readonly code = "SESSION_NOT_FOUND";
  /**
   * Creates the error for an unknown session id.
   * @param id - The session id that was not found.
   */
  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

/**
 * Thrown by {@link SessionStore.withLock} when another live operation holds the session lock.
 * Code `SESSION_LOCKED`.
 */
export class SessionLockedError extends Error {
  /** Stable machine-readable error code. */
  readonly code = "SESSION_LOCKED";
  /**
   * Creates the error for a locked session id.
   * @param id - The locked session id.
   */
  constructor(id: string) {
    super(`Session is locked by another operation: ${id}`);
    this.name = "SessionLockedError";
  }
}

/** Shape of every id produced by {@link SessionStore.create}. */
const SESSION_ID_PATTERN = /^ds-\d{14}-[0-9a-f]{6}$/;

/** Formats epoch ms as `YYYYMMDDHHmmss` in UTC for use in session ids. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * File-backed store for ephemeral sessions (PRD §10.5, §10.8). Layout per session:
 * `sessions/<id>/{session.json,evidence.json,brief.md,skills/,evals/,reports/}`. Each CLI
 * invocation is a separate process, so state lives on disk and mutation is guarded by a lock file.
 */
export class SessionStore {
  /** Storage root: `sessions/<id>/` holds live sessions, `reports/` the archived metrics. */
  readonly home: string;
  private prepared: Promise<void> | undefined;

  /**
   * Creates a store rooted at `home`.
   * @param home - Storage root; defaults to {@link resolveHome}.
   */
  constructor(home: string = resolveHome()) {
    this.home = home;
  }

  /**
   * Absolute path of a session's directory. This is the single choke point for path building:
   * ids come from agent-controlled CLI arguments, so anything not shaped like a generated id
   * (which also rules out `..` and separators) is reported as an unknown session.
   *
   * @throws {SessionNotFoundError} if `id` is malformed.
   */
  dir(id: string): string {
    if (!SESSION_ID_PATTERN.test(id)) throw new SessionNotFoundError(id);
    return join(this.home, "sessions", id);
  }

  /**
   * Ensures the home and `<home>/sessions` are directories of the current user (see
   * {@link ensurePrivateDir}); only `sessions` is tightened to 0700, the home is left as it is. Runs once per store; {@link SessionStore.create} and
   * {@link SessionStore.withLock} call it first, so no session data is written into an unsafe home.
   *
   * @throws {UnsafeHomeError} when either directory is unsafe.
   */
  prepare(): Promise<void> {
    this.prepared ??= (async () => {
      // The home may be user-provided (even `$HOME`): check it, never chmod it (Ruling R23).
      await ensurePrivateDir(this.home, REAL_PROBE, false);
      await ensurePrivateDir(join(this.home, "sessions"));
    })();
    return this.prepared;
  }

  /**
   * Creates a session directory (mode 0700, inside a checked private home) and persists its
   * initial state (status `assessing`, running SLA clock started at `now`, zeroed metrics).
   *
   * @throws {UnsafeHomeError} if the home is unsafe.
   *
   * @param init.budgetMs - Active budget; defaults to {@link DEFAULT_BUDGET_MS}.
   * @param init.now - Epoch ms used for the id, clock and metrics; defaults to `Date.now()`.
   */
  async create(init: {
    task: string;
    mode: InvocationMode;
    explicit: boolean;
    repo: string;
    revision: string;
    budgetMs?: number;
    now?: number;
  }): Promise<SessionState> {
    const now = init.now ?? Date.now();
    const id = `ds-${stamp(now)}-${randomBytes(3).toString("hex")}`;
    const state: SessionState = {
      schemaVersion: CONTRACT_VERSION,
      id,
      task: init.task,
      mode: init.mode,
      explicit: init.explicit,
      repo: init.repo,
      revision: init.revision,
      status: "assessing",
      createdAt: new Date(now).toISOString(),
      sla: SlaClock.start(init.budgetMs ?? DEFAULT_BUDGET_MS, now).snapshot(now),
      completedSteps: [],
      clarification: { round: 0, asked: [], pending: [], answers: [] },
      assumptions: [],
      gaps: [],
      blockedBy: [],
      evalAttempts: 0,
      requirements: [],
      sufficiency: null,
      metrics: {
        wallStartedAt: now,
        stageMs: {},
        humanWaitMs: 0,
        llmInteractions: 0,
        parallelOps: 0,
        cacheHits: 0,
        cacheLookups: 0,
        evaluationMs: 0,
        activationMs: 0,
        contextRequests: 0,
        contextRequestRounds: 0,
        analysisSubmissions: 0,
        packetTokens: 0,
        analysisStartedAtActiveMs: null,
      },
    };
    await this.prepare();
    await mkdir(this.dir(id), { mode: PRIVATE_DIR_MODE });
    await this.save(state);
    return state;
  }

  /**
   * Loads and validates a session.
   *
   * @throws {SessionNotFoundError} if `session.json` does not exist.
   * @throws ZodError / SyntaxError if the file is corrupt; corrupt state must never be trusted.
   */
  async load(id: string): Promise<SessionState> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir(id), "session.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new SessionNotFoundError(id);
      throw e;
    }
    return SessionStateSchema.parse(JSON.parse(raw));
  }

  /** Persists state atomically: write `session.json.tmp`, then rename over `session.json`. */
  async save(s: SessionState): Promise<void> {
    const file = join(this.dir(s.id), "session.json");
    await mkdir(dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
    await writeFile(`${file}.tmp`, JSON.stringify(s, null, 2), { mode: PRIVATE_FILE_MODE });
    await rename(`${file}.tmp`, file);
  }

  /**
   * Runs `fn` while holding the session lock (`session.lock`, created exclusively). A lock older
   * than 30 s is treated as abandoned and reclaimed. The lock is always released. The home is
   * checked ({@link SessionStore.prepare}) before the lock is written.
   *
   * @throws {SessionLockedError} if a fresh lock is held by someone else.
   * @throws {UnsafeHomeError} if the home is unsafe.
   */
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const lock = join(this.dir(id), "session.lock");
    await this.prepare();
    await mkdir(this.dir(id), { recursive: true, mode: PRIVATE_DIR_MODE });
    await this.acquire(id, lock);
    try {
      return await fn();
    } finally {
      await unlink(lock).catch(() => undefined);
    }
  }

  private async acquire(id: string, lock: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await (await open(lock, "wx", PRIVATE_FILE_MODE)).close();
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const age = await stat(lock).then(
          (st) => Date.now() - st.mtimeMs,
          () => 0,
        );
        if (age <= STALE_LOCK_MS) throw new SessionLockedError(id);
        await unlink(lock).catch(() => undefined);
      }
    }
    throw new SessionLockedError(id);
  }

  /** Resolves `rel` inside the session dir, rejecting paths that escape it. */
  private resolveInside(id: string, rel: string): string {
    const base = resolve(this.dir(id));
    const abs = resolve(base, rel);
    const r = relative(base, abs);
    if (r === "" || r.startsWith("..") || r.split(sep).includes("..")) {
      throw new Error(`Artifact path escapes the session directory: ${rel}`);
    }
    return abs;
  }

  /**
   * Writes a UTF-8 artifact at `rel` inside the session directory (file mode 0600), creating
   * parents (mode 0700).
   *
   * @returns The absolute path written.
   * @throws if `rel` would escape the session directory.
   */
  async writeArtifact(id: string, rel: string, content: string): Promise<string> {
    const abs = this.resolveInside(id, rel);
    await mkdir(dirname(abs), { recursive: true, mode: PRIVATE_DIR_MODE });
    await writeFile(abs, content, { mode: PRIVATE_FILE_MODE });
    return abs;
  }

  /** Reads an artifact, or returns `null` if it does not exist. */
  async readArtifact(id: string, rel: string): Promise<string | null> {
    try {
      return await readFile(this.resolveInside(id, rel), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  /** Deletes the whole session directory; a missing session is not an error. */
  async remove(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }
}

/** Adds `ms` to the accumulated duration of `stage` in the session metrics (PRD §10.8). */
export function recordStage(s: SessionState, stage: StageName, ms: number): void {
  s.metrics.stageMs[stage] = (s.metrics.stageMs[stage] ?? 0) + ms;
}

/** Statuses that end a session; the SLA clock of such a session is stopped. */
const ENDED: ReadonlySet<SessionState["status"]> = new Set([
  "completed",
  "warning",
  "failed",
  "timeout",
]);

/** True when the session has ended: `completed`, `warning`, `failed` or `timeout`. */
export function hasEnded(s: SessionState): boolean {
  return ENDED.has(s.status);
}

/**
 * Stops the SLA clock of a session that has ended, so its active time no longer grows: the clock
 * is paused at `now` and stays paused, because no command can resume an ended session. Idempotent
 * (a clock that is already paused keeps its time).
 *
 * @param s - The session; `s.sla` is replaced by the frozen snapshot.
 * @param now - Epoch ms at which the session ended.
 */
export function stopClock(s: SessionState, now: number): void {
  const clock = SlaClock.from(s.sla);
  clock.pause(now);
  s.sla = clock.snapshot(now);
}

/**
 * Enforces the active-time budget (PRD §10.1). If the session's clock is expired at `now`, marks
 * `status` and `metrics.outcome` as `timeout` and stops the clock.
 *
 * @returns `true` if the deadline has passed.
 */
export function enforceDeadline(s: SessionState, now: number): boolean {
  if (!SlaClock.from(s.sla).isExpired(now)) return false;
  s.status = "timeout";
  s.metrics.outcome = "timeout";
  stopClock(s, now);
  return true;
}
