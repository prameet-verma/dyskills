import type { EvidenceCategory } from "@dynamic-skills/core";
import type { EvidenceInput } from "@dynamic-skills/evidence-registry";
import type { RepoFileIndex } from "../file-index";

/** Everything a detector may use; it never touches the filesystem directly. */
export interface DetectorContext {
  /** Absolute repository root. */
  repo: string;
  /** Repository revision stamped on every observation (PRD §7). */
  revision: string;
  /** Bounded, secret-free file listing. */
  files: RepoFileIndex;
  /**
   * Reads a repo-relative text file.
   *
   * @returns The text, or `null` if the file is missing, unreadable, too large, outside the
   * repo or a secret path.
   */
  readText(rel: string): Promise<string | null>;
}

/** A unit of discovery that turns repository files into evidence observations. */
export interface Detector {
  /** Stable identifier used in `detectorsRun`, `durations` and `errors`. */
  id: string;
  /** Evidence categories this detector can produce. */
  categories: EvidenceCategory[];
  /** Run for every task. */
  always?: boolean;
  /** Run only when the task text matches (ignored if `always`). */
  keywords?: RegExp;
  /**
   * Produces observations for `EvidenceRegistry.add`.
   *
   * @throws Any error; the runner records it and continues with other detectors.
   */
  run(ctx: DetectorContext): Promise<EvidenceInput[]>;
}
