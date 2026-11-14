import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DISCOVERY_CONCURRENCY, mapConcurrent } from "@dynamic-skills/core";
import { EvidenceRegistry, getRepoRevision } from "@dynamic-skills/evidence-registry";
import { ALL_DETECTORS } from "./detectors/index";
import type { Detector, DetectorContext } from "./detectors/types";
import { buildFileIndex, type RepoFileIndex } from "./file-index";
import { isSecretPath } from "./secrets";

/** Largest file a detector may read; bigger files are treated as unreadable. */
const MAX_READ_BYTES = 1_000_000;

/**
 * Picks the detectors relevant to a task (PRD §10.2 task-directed discovery).
 *
 * @param task - Free-text task description.
 * @param detectors - Candidates.
 * @returns Detectors that are `always` or whose `keywords` match the task, in input order.
 */
export function selectDetectors(task: string, detectors: Detector[]): Detector[] {
  return detectors.filter((d) => d.always || (d.keywords?.test(task) ?? false));
}

/** True when `rel` (from `relative(root, target)`) stays inside `root`. */
function isInside(rel: string): boolean {
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Creates the sandboxed reader handed to detectors. Symlinks are resolved first: the real
 * target must lie inside the real repo root and must not itself be a secret path, so a link
 * named `package.json` cannot expose `.env` or files outside the repository.
 */
function makeReader(repo: string): DetectorContext["readText"] {
  return async (rel) => {
    if (isSecretPath(rel)) return null;
    const abs = resolve(repo, rel);
    if (!isInside(relative(repo, abs))) return null;
    try {
      const realRoot = await realpath(repo);
      const real = await realpath(abs);
      const back = relative(realRoot, real);
      if (!isInside(back) || isSecretPath(back.split(sep).join("/"))) return null;
      if ((await stat(real)).size > MAX_READ_BYTES) return null;
      return await readFile(real, "utf8");
    } catch {
      return null;
    }
  };
}

/** Result of {@link runDiscovery}. */
export interface DiscoveryResult {
  /** Merged evidence from all detectors that succeeded. */
  registry: EvidenceRegistry;
  /** The file index detectors saw. */
  files: RepoFileIndex;
  /** Ids of detectors that were selected and started, in order. */
  detectorsRun: string[];
  /** Wall-clock milliseconds per detector id. */
  durations: Record<string, number>;
  /** Detectors that threw; their evidence is absent but others are unaffected. */
  errors: { detector: string; message: string }[];
}

/**
 * Runs task-selected detectors in parallel (bounded) and merges their evidence.
 *
 * A throwing detector is recorded in `errors` and never aborts the others. Evidence is added
 * to the registry in detector order after all finish, so conflict ordering is deterministic.
 *
 * @param opts - Repo root, task text, optional detectors (default {@link ALL_DETECTORS}),
 * concurrency (default {@link DISCOVERY_CONCURRENCY}) and abort signal.
 * @returns The registry plus run diagnostics.
 * @throws An `AbortError` if the signal aborts.
 */
export async function runDiscovery(opts: {
  repo: string;
  task: string;
  detectors?: Detector[];
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<DiscoveryResult> {
  const repo = resolve(opts.repo);
  const [files, revision] = await Promise.all([buildFileIndex(repo), getRepoRevision(repo)]);
  const ctx: DetectorContext = { repo, revision, files, readText: makeReader(repo) };
  const selected = selectDetectors(opts.task, opts.detectors ?? ALL_DETECTORS);

  const durations: Record<string, number> = {};
  const errors: DiscoveryResult["errors"] = [];
  const results = await mapConcurrent(
    selected,
    opts.concurrency ?? DISCOVERY_CONCURRENCY,
    async (d) => {
      const start = performance.now();
      try {
        return await d.run(ctx);
      } catch (err) {
        errors.push({ detector: d.id, message: err instanceof Error ? err.message : String(err) });
        return [];
      } finally {
        durations[d.id] = performance.now() - start;
      }
    },
    { signal: opts.signal },
  );

  const registry = new EvidenceRegistry();
  for (const batch of results) for (const e of batch) registry.add(e);
  return { registry, files, detectorsRun: selected.map((d) => d.id), durations, errors };
}
