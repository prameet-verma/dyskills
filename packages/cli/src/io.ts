import { readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  CONTRACT_VERSION,
  ContextPacketSchema,
  EvidenceDocumentSchema,
  buildDiscoveryReport,
  buildPerformanceReport,
} from "@dynamic-skills/core";
import type { ContextPacket, Evidence, SessionState, SessionStore } from "@dynamic-skills/core";
import { readRealFile, resolveRepoPath } from "@dynamic-skills/discovery";
import type { ZodType, z } from "zod";

/** One problem found in an agent-supplied document: a dotted path and a message. */
interface CliIssue {
  path: string;
  message: string;
}

/**
 * Stable machine-readable error codes (PRD §10.5, §13). `TIMEOUT` exits 3; `BUNDLE_INVALID` and
 * `EVAL_ATTEMPTS_EXHAUSTED` are evaluation-gate failures and exit 2; every other code exits 1.
 */
export type CliErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_LOCKED"
  | "INVALID_STATE"
  | "USAGE"
  | "ANALYSIS_LIMIT"
  | "BASE_CHANGED"
  | "SCHEMA_INVALID"
  | "VERDICT_INVALID"
  | "BUNDLE_INVALID"
  | "EVAL_ATTEMPTS_EXHAUSTED"
  | "TIMEOUT"
  | "INTERNAL";

/**
 * An expected command failure with a machine-readable code. The wrapper turns it into the error
 * JSON on stdout and an exit code, and discards the in-memory session state (nothing is saved).
 */
export class CliError extends Error {
  /**
   * Creates a failure.
   * @param code - Stable error code.
   * @param message - Human-readable text; must never contain repository content or secrets.
   * @param extra - Extra JSON fields merged into the error document (`issues`, `expected`, ...).
   */
  constructor(
    readonly code: CliErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Process-level inputs of one invocation, injectable so tests never touch the real home. */
export interface CliEnv {
  /** Session storage root; defaults to `resolveHome()`. */
  home?: string;
  /** Working directory that relative `--repo` and `--file` values resolve against. */
  cwd?: string;
  /** User home searched for personal skills; defaults to `os.homedir()`. */
  userHome?: string;
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  now?: () => number;
}

/** Largest `--file` document accepted; agent documents are small and bounded by their schemas. */
const MAX_INPUT_BYTES = 1_000_000;

/** Largest base skill or instruction file whose content is returned for reuse (PRD §5.5). */
const MAX_BASE_BYTES = 200_000;

/** Maximum issues reported for one invalid document. */
const MAX_ISSUES = 50;

/** Shown to the agent whenever the pipeline ends without a skill (PRD §10.7). */
export const FALLBACK = "Continue the original task with existing capabilities.";

/**
 * Reads an agent-supplied input file as text.
 * @param cwd - Directory relative paths resolve against.
 * @param file - The option value.
 * @param flag - The option name used in the error message.
 * @throws {CliError} `USAGE` when the file is missing, unreadable, not a file or over 1 MB.
 */
export async function readInputFile(cwd: string, file: string, flag = "--file"): Promise<string> {
  const abs = resolve(cwd, file);
  try {
    const info = await stat(abs);
    if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new Error("bad file");
    return await readFile(abs, "utf8");
  } catch {
    throw new CliError("USAGE", `Cannot read ${flag} ${file} (missing, not a file, or over 1 MB).`);
  }
}

/**
 * Parses and validates an agent document with its strict schema before anything else happens
 * (PRD §6.5: agent output is untrusted).
 * @param schema - The strict zod schema of the document.
 * @param text - Raw file text.
 * @returns The parsed document with defaults applied.
 * @throws {CliError} `SCHEMA_INVALID` with `issues` (unparseable JSON is one issue `invalid JSON`).
 */
export function parseDocument<S extends ZodType>(schema: S, text: string): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError("SCHEMA_INVALID", "The document is not valid JSON.", {
      issues: [{ path: "", message: "invalid JSON" }],
    });
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues: CliIssue[] = parsed.error.issues
    .slice(0, MAX_ISSUES)
    .map((i) => ({ path: i.path.join("."), message: i.message }));
  throw new CliError("SCHEMA_INVALID", "The document does not match its schema.", { issues });
}

/** Serialises a session artifact. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Reads and validates a JSON artifact of the session.
 * @returns The parsed document, or `null` when the artifact does not exist.
 * @throws if the stored artifact is corrupt (written only by this CLI, so a programming or disk error).
 */
export async function readArtifactJson<S extends ZodType>(
  store: SessionStore,
  id: string,
  rel: string,
  schema: S,
): Promise<z.output<S> | null> {
  const text = await store.readArtifact(id, rel);
  return text === null ? null : schema.parse(JSON.parse(text));
}

/** Like {@link readArtifactJson} but a missing artifact is an error (the state machine promised it). */
export async function requireArtifactJson<S extends ZodType>(
  store: SessionStore,
  id: string,
  rel: string,
  schema: S,
): Promise<z.output<S>> {
  const doc = await readArtifactJson(store, id, rel, schema);
  if (doc === null) throw new CliError("INTERNAL", `Session artifact ${rel} is missing.`);
  return doc;
}

/** Writes the session's `evidence.json` document. */
export async function writeEvidence(
  store: SessionStore,
  id: string,
  items: Evidence[],
): Promise<void> {
  await store.writeArtifact(
    id,
    "evidence.json",
    toJson({ schemaVersion: CONTRACT_VERSION, items }),
  );
}

/** Reads the session's evidence items (empty when `evidence.json` does not exist yet). */
export async function readEvidence(store: SessionStore, id: string): Promise<Evidence[]> {
  return (await readArtifactJson(store, id, "evidence.json", EvidenceDocumentSchema))?.items ?? [];
}

/**
 * Writes `reports/performance.json` and `reports/discovery.json` for a session that has ended
 * (PRD §10.8). Safe on any session: a missing packet or evidence file reads as `null` / empty.
 * @param store - Session store.
 * @param state - Final session state (outcome already set).
 * @param now - Epoch ms used for the wall and active durations.
 */
export async function writeTerminalReports(
  store: SessionStore,
  state: SessionState,
  now: number,
): Promise<void> {
  const packet: ContextPacket | null = await readArtifactJson(
    store,
    state.id,
    "context-packet.json",
    ContextPacketSchema,
  );
  const evidence = await readEvidence(store, state.id);
  await store.writeArtifact(
    state.id,
    "reports/performance.json",
    toJson(buildPerformanceReport(state, now)),
  );
  await store.writeArtifact(
    state.id,
    "reports/discovery.json",
    toJson(buildDiscoveryReport(state, packet, evidence)),
  );
}

/** Turns a failed base read into a `VERDICT_INVALID` error on the field that named the base. */
export function baseFailure(path: string, read: Extract<BaseRead, { ok: false }>): CliError {
  return new CliError("VERDICT_INVALID", "The named base could not be used.", {
    issues: [{ path, message: read.message }],
  });
}

/**
 * Removes C0 and C1 control characters, except newline, from text bound for a terminal. Session
 * ids, question ids and option values are agent-controlled and can carry ESC or OSC sequences
 * (title changes, cursor moves) that a terminal would execute. A character-class replace is
 * linear in the input.
 */
export function stripControlChars(text: string): string {
  return text.replace(/[^\P{Cc}\n]/gu, "");
}

/** Result of reading a reusable base file. */
export type BaseRead = { ok: true; content: string } | { ok: false; message: string };

/**
 * Reads a scanned base skill (`SKILL.md`) without modifying it (PRD §5.5, FR-42). A scanned path
 * is not trusted to be a plain file: a symlinked `SKILL.md` is followed only when its real name is
 * still `SKILL.md`, so it cannot point at a secret file such as `.env` or a private key.
 * @param path - Absolute scanned path.
 * @returns The content, or a failure message (missing, not a regular file, redirected, too large).
 */
export async function readBaseSkillFile(path: string): Promise<BaseRead> {
  try {
    const real = await realpath(path);
    if (basename(real) !== "SKILL.md") {
      return { ok: false, message: "base skill file resolves to a file that is not a SKILL.md" };
    }
    const info = await stat(real);
    if (!info.isFile()) return { ok: false, message: "base skill file is not a regular file" };
    if (info.size > MAX_BASE_BYTES) {
      return { ok: false, message: `base skill file exceeds ${MAX_BASE_BYTES} bytes` };
    }
    const content = await readRealFile(real);
    if (content === null) return { ok: false, message: "base skill file could not be read" };
    return { ok: true, content };
  } catch {
    return { ok: false, message: "base skill file could not be read" };
  }
}

/**
 * Reads a scanned repository instruction file (`AGENTS.md`, `CLAUDE.md`) without modifying it,
 * through the sandboxed repo resolver so a symlink cannot reach a secret or leave the repository.
 * @param repo - Absolute repository root.
 * @param rel - Repo-relative path from the scan.
 */
export async function readBaseInstructionFile(repo: string, rel: string): Promise<BaseRead> {
  const resolved = await resolveRepoPath(repo, rel);
  if (!resolved.ok) {
    return { ok: false, message: `base instruction file was rejected (${resolved.reason})` };
  }
  try {
    const info = await stat(resolved.abs);
    if (info.size > MAX_BASE_BYTES) {
      return { ok: false, message: `base instruction file exceeds ${MAX_BASE_BYTES} bytes` };
    }
  } catch {
    return { ok: false, message: "base instruction file could not be read" };
  }
  const content = await readRealFile(resolved.abs);
  if (content === null) return { ok: false, message: "base instruction file could not be read" };
  return { ok: true, content };
}
