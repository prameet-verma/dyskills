import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_PLACEMENT_TTL_MS } from "./constants";
import { readSafeFile } from "./safe-read";
import { SessionStateSchema, type SessionMetrics } from "./schemas";

/** One session's claim on a native placement directory. */
export interface NativeReference {
  /** Id of the referencing session. */
  sessionId: string;
  /** Epoch ms the placement was made. */
  placedAt: number;
  /** The session's recorded outcome; `undefined` while it is still running. */
  outcome: SessionMetrics["outcome"];
}

/**
 * Reads every `<home>/sessions/<id>/session.json` and groups the native placements they record.
 *
 * @param home - Session home.
 * @param opts.exclude - Session id to skip (the caller's own session).
 * @returns References by placement `dir`, and how many session files could not be read or parsed
 *   (such a session may reference any placement, so callers must fail safe).
 */
export async function readNativeReferences(
  home: string,
  opts: { exclude?: string } = {},
): Promise<{ byDir: Map<string, NativeReference[]>; unparsable: number }> {
  const byDir = new Map<string, NativeReference[]>();
  let unparsable = 0;
  const root = join(home, "sessions");
  const ids = await readdir(root).catch(() => [] as string[]);
  for (const id of ids) {
    if (id === opts.exclude) continue;
    const read = await readSafeFile(join(root, id, "session.json"), { maxBytes: 1_000_000 });
    if (!read.ok) {
      unparsable++;
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(read.text);
    } catch {
      unparsable++;
      continue;
    }
    const parsed = SessionStateSchema.safeParse(json);
    if (!parsed.success) {
      unparsable++;
      continue;
    }
    const native = parsed.data.native;
    if (native === undefined) continue;
    const list = byDir.get(native.dir) ?? [];
    list.push({
      sessionId: parsed.data.id,
      placedAt: Date.parse(native.placedAt),
      outcome: parsed.data.metrics.outcome,
    });
    byDir.set(native.dir, list);
  }
  return { byDir, unparsable };
}

/**
 * Pure sweep policy for native placements. A placement's age starts at the newest `placedAt`
 * among its references, else its `mtimeMs`. It is expired when older than the TTL. Otherwise,
 * only when every session file parsed, it is expired when nothing references it or when every
 * referencing session ended without a successful activation (`activated` or `augmented`).
 *
 * @returns The `dir` of every expired placement.
 */
export function selectExpiredPlacements(input: {
  placements: { dir: string; mtimeMs: number }[];
  refs: Map<string, NativeReference[]>;
  unparsable: number;
  now: number;
  ttlMs?: number;
}): string[] {
  const ttl = input.ttlMs ?? NATIVE_PLACEMENT_TTL_MS;
  const expired: string[] = [];
  for (const p of input.placements) {
    const refs = input.refs.get(p.dir) ?? [];
    const start = refs.length > 0 ? Math.max(...refs.map((r) => r.placedAt)) : p.mtimeMs;
    if (input.now - start > ttl) {
      expired.push(p.dir);
      continue;
    }
    if (input.unparsable !== 0) continue;
    const live = refs.some(
      (r) => r.outcome === undefined || r.outcome === "activated" || r.outcome === "augmented",
    );
    if (!live) expired.push(p.dir);
  }
  return expired;
}
