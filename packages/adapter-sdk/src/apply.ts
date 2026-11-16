import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { jsonEqual, mergeJson } from "./json-merge";
import { isInside, realpathOfPlanned } from "./paths";
import type { AppliedWrite, InstallPlan, JsonObject, JsonValue, PlannedWrite } from "./types";

const MAX_TARGET_BYTES = 8 * 1024 * 1024;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
const PRIVATE_DIR_MODE = 0o700;

/** Thrown when an I/O error interrupts {@link applyPlan}; `applied` lists the writes already made. */
export class PlanApplyError extends Error {
  /** Writes that were already applied (and not rolled back) when the failure happened. */
  readonly applied: AppliedWrite[];
  /** The underlying error. */
  override readonly cause: unknown;
  /** Creates the error. */
  constructor(applied: AppliedWrite[], cause: unknown) {
    super(
      `apply failed after ${applied.length} write(s): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "PlanApplyError";
    this.applied = applied;
    this.cause = cause;
  }
}

/** Options for {@link applyPlan}. */
export interface ApplyOptions {
  /** Preview only; nothing is created. */
  dryRun: boolean;
  /** Overwrite a differing `file` write. Never applies to merges, symlinks or invalid JSON. */
  force: boolean;
  /** Test seam: runs just before each create/update is written. */
  beforeWrite?: (write: PlannedWrite) => void | Promise<void>;
}

interface Entry {
  write: PlannedWrite;
  action: "create" | "update" | "unchanged" | "conflict";
  reason?: string;
  /** sha256 of the target's bytes at preview time, null when absent (dirs: "dir"). */
  hash: string | null;
  /** New bytes for file and merge writes. */
  next?: Buffer;
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function jsonBytes(v: JsonValue): Buffer {
  return Buffer.from(JSON.stringify(v, null, 2) + "\n", "utf8");
}

function conflict(write: PlannedWrite, reason: string, hash: string | null = null): Entry {
  return { write, action: "conflict", reason, hash };
}

/** Paths whose value differs between `cur` and `merged`, outermost-first, for text edits. */
function diffPaths(
  cur: JsonValue,
  merged: JsonValue,
  path: (string | number)[],
  out: { path: (string | number)[]; value: JsonValue }[],
): void {
  if (jsonEqual(cur, merged)) return;
  const isObj = (v: JsonValue): v is JsonObject =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObj(cur) && isObj(merged)) {
    for (const [k, v] of Object.entries(merged)) {
      if (!Object.hasOwn(cur, k)) out.push({ path: [...path, k], value: v });
      else diffPaths(cur[k] as JsonValue, v, [...path, k], out);
    }
    return;
  }
  out.push({ path, value: merged });
}

function planMerge(
  write: PlannedWrite & { kind: "json-merge" | "jsonc-merge" },
  existing: Buffer | null,
): Entry {
  const strict = write.kind === "json-merge";
  const hash = existing === null ? null : sha(existing);
  if (existing === null) return { write, action: "create", hash, next: jsonBytes(write.patch) };
  const text = existing.toString("utf8");
  let current: JsonValue | undefined;
  if (strict) {
    try {
      current = JSON.parse(text) as JsonValue;
    } catch {
      return conflict(write, "invalid JSON", hash);
    }
  } else {
    const errors: ParseError[] = [];
    current = parse(text, errors, { allowTrailingComma: true }) as JsonValue | undefined;
    if (errors.length > 0 || current === undefined) return conflict(write, "invalid JSONC", hash);
  }
  const { value, conflicts } = mergeJson(
    current,
    write.patch,
    write.promote ? { promote: write.promote } : {},
  );
  if (conflicts.length > 0) {
    return conflict(
      write,
      `conflicts at: ${conflicts.map((c) => (c === "" ? "(root)" : c)).join(", ")}`,
      hash,
    );
  }
  if (jsonEqual(current, value)) return { write, action: "unchanged", hash };
  if (strict) return { write, action: "update", hash, next: jsonBytes(value) };
  const edits: { path: (string | number)[]; value: JsonValue }[] = [];
  diffPaths(current as JsonValue, value, [], edits);
  let out = text;
  for (const e of edits) {
    out = applyEdits(
      out,
      modify(out, e.path, e.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    );
  }
  return { write, action: "update", hash, next: Buffer.from(out, "utf8") };
}

async function readExisting(path: string): Promise<{ bytes: Buffer | null; problem?: string }> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null };
    if ((e as NodeJS.ErrnoException).code === "ENOTDIR")
      return { bytes: null, problem: "parent is not a directory" };
    throw e;
  }
  if (st.isSymbolicLink()) return { bytes: null, problem: "symlink" };
  if (!st.isFile()) return { bytes: null, problem: "not a regular file" };
  if (st.size > MAX_TARGET_BYTES) return { bytes: null, problem: "too large" };
  return { bytes: await readFile(path) };
}

async function containment(write: PlannedWrite, plan: InstallPlan): Promise<string | null> {
  if (write.within === null) return null;
  const outside = write.within === plan.projectRoot ? "outside project" : "outside session home";
  try {
    const root = await realpathOfPlanned(write.within);
    const parent = await realpathOfPlanned(dirname(write.path));
    return isInside(parent, root) ? null : outside;
  } catch {
    return outside;
  }
}

async function evaluate(
  write: PlannedWrite,
  plan: InstallPlan,
  force: boolean,
  seen: Set<string>,
): Promise<Entry> {
  if (!isAbsolute(write.path) || resolve(write.path) !== write.path)
    return conflict(write, "path is not absolute and normalised");
  if (seen.has(write.path)) return conflict(write, "path planned twice");
  seen.add(write.path);
  const outside = await containment(write, plan);
  if (outside !== null) return conflict(write, outside);

  if (write.kind === "dir") {
    try {
      const st = await lstat(write.path);
      if (st.isSymbolicLink()) return conflict(write, "symlink", "dir");
      return st.isDirectory()
        ? { write, action: "unchanged", hash: "dir" }
        : conflict(write, "not a directory", "dir");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { write, action: "create", hash: null };
      return conflict(write, "not readable");
    }
  }

  let existing: { bytes: Buffer | null; problem?: string };
  try {
    existing = await readExisting(write.path);
  } catch {
    return conflict(write, "not readable");
  }
  if (existing.problem !== undefined) return conflict(write, existing.problem);

  if (write.kind === "file") {
    if (existing.bytes === null)
      return { write, action: "create", hash: null, next: write.content };
    const hash = sha(existing.bytes);
    if (existing.bytes.equals(write.content)) return { write, action: "unchanged", hash };
    return force
      ? { write, action: "update", hash, next: write.content }
      : conflict(write, "differs", hash);
  }
  return planMerge(write, existing.bytes);
}

function toApplied(e: Entry): AppliedWrite {
  return {
    path: e.write.path,
    action: e.action,
    purpose: e.write.purpose,
    committable: e.write.committable,
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
  };
}

async function evaluateAll(plan: InstallPlan, force: boolean): Promise<Entry[]> {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const w of plan.writes) out.push(await evaluate(w, plan, force, seen));
  return out;
}

/**
 * Computes each write's action without writing or creating anything. `file`: absent creates, equal
 * bytes are unchanged, different bytes conflict ("differs"; `force` updates). Merges use strict
 * JSON or JSONC parsing; invalid input or any merge conflict is a conflict. A symlink at the final
 * path, or a parent whose realpath leaves `within`, is a conflict. `force` affects only the `file`
 * "differs" case.
 */
export async function previewPlan(
  plan: InstallPlan,
  opts: { force: boolean },
): Promise<AppliedWrite[]> {
  return (await evaluateAll(plan, opts.force)).map(toApplied);
}

async function writeAtomic(path: string, bytes: Buffer, mode: number): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomBytes(6).toString("hex")}`);
  try {
    const fh = await open(tmp, "wx", mode);
    try {
      await fh.writeFile(bytes);
      await fh.chmod(mode);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Applies a plan all-or-nothing with respect to conflicts: previews first, and writes nothing when
 * any conflict remains or on `dryRun`. Each create/update re-reads its target and treats any change
 * since the preview as a conflict ("changed since preview"), stopping there. Files are written via a
 * temp file and `rename`, keeping an existing file's mode (new files 0644, new directories 0755,
 * `dir` writes 0700). An I/O error throws {@link PlanApplyError} listing what was already written.
 */
export async function applyPlan(plan: InstallPlan, opts: ApplyOptions): Promise<AppliedWrite[]> {
  const entries = await evaluateAll(plan, opts.force);
  if (opts.dryRun || entries.some((e) => e.action === "conflict")) return entries.map(toApplied);

  const done: AppliedWrite[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as Entry;
    if (entry.action === "unchanged") {
      done.push(toApplied(entry));
      continue;
    }
    const write = entry.write;
    try {
      await opts.beforeWrite?.(write);
      const stale = await recheck(entry, plan);
      if (stale !== null) {
        done.push({ ...toApplied(entry), action: "conflict", reason: stale });
        for (const rest of entries.slice(i + 1)) {
          done.push(
            rest.action === "unchanged"
              ? toApplied(rest)
              : { ...toApplied(rest), action: "conflict", reason: "not applied" },
          );
        }
        return done;
      }
      await mkdir(dirname(write.path), { recursive: true, mode: DIR_MODE });
      const again = await containment(write, plan);
      if (again !== null) throw new Error(`${again}: ${write.path}`);
      if (write.kind === "dir") {
        await mkdir(write.path, { mode: PRIVATE_DIR_MODE });
        await chmod(write.path, PRIVATE_DIR_MODE);
      } else {
        const mode =
          entry.action === "update" ? (await lstat(write.path)).mode & 0o7777 : FILE_MODE;
        await writeAtomic(write.path, entry.next as Buffer, mode);
      }
      done.push(toApplied(entry));
    } catch (e) {
      throw new PlanApplyError(done, e);
    }
  }
  return done;
}

/** Re-reads the target; returns a conflict reason when it changed since the preview. */
async function recheck(entry: Entry, plan: InstallPlan): Promise<string | null> {
  const write = entry.write;
  const outside = await containment(write, plan);
  if (outside !== null) return outside;
  if (write.kind === "dir") {
    try {
      await lstat(write.path);
      return "changed since preview";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "changed since preview";
    }
  }
  const now = await readExisting(write.path);
  if (now.problem !== undefined)
    return now.problem === "symlink" ? "symlink" : "changed since preview";
  const hash = now.bytes === null ? null : sha(now.bytes);
  return hash === entry.hash ? null : "changed since preview";
}
