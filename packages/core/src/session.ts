import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CONTRACT_VERSION, DEFAULT_BUDGET_MS } from "./constants";
import { SessionStateSchema } from "./schemas";
import type { InvocationMode, SessionState, StageName } from "./schemas";
import { SlaClock } from "./sla";

/** A lock file older than this is assumed to belong to a crashed process and is reclaimed. */
const STALE_LOCK_MS = 30_000;

/**
 * Root directory for ephemeral session data: `DYNAMIC_SKILLS_HOME` if set, otherwise
 * `<os tmpdir>/dynamic-skills`. Phase 1 writes only beneath `<home>/sessions/<id>/`.
 */
export function resolveHome(): string {
  return process.env.DYNAMIC_SKILLS_HOME ?? join(tmpdir(), "dynamic-skills");
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
  private readonly home: string;

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
   * Creates a session directory and persists its initial state (status `assessing`, running SLA
   * clock started at `now`, zeroed metrics).
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
    await mkdir(this.dir(id), { recursive: true });
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
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(s, null, 2));
    await rename(`${file}.tmp`, file);
  }

  /**
   * Runs `fn` while holding the session lock (`session.lock`, created exclusively). A lock older
   * than 30 s is treated as abandoned and reclaimed. The lock is always released.
   *
   * @throws {SessionLockedError} if a fresh lock is held by someone else.
   */
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const lock = join(this.dir(id), "session.lock");
    await mkdir(this.dir(id), { recursive: true });
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
        await (await open(lock, "wx")).close();
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
   * Writes a UTF-8 artifact at `rel` inside the session directory, creating parents.
   *
   * @returns The absolute path written.
   * @throws if `rel` would escape the session directory.
   */
  async writeArtifact(id: string, rel: string, content: string): Promise<string> {
    const abs = this.resolveInside(id, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
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

/**
 * Enforces the active-time budget (PRD §10.1). If the session's clock is expired at `now`, marks
 * `status` and `metrics.outcome` as `timeout`.
 *
 * @returns `true` if the deadline has passed.
 */
export function enforceDeadline(s: SessionState, now: number): boolean {
  if (!SlaClock.from(s.sla).isExpired(now)) return false;
  s.status = "timeout";
  s.metrics.outcome = "timeout";
  return true;
}
