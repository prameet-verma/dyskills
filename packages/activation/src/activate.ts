import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AssumptionsReportSchema,
  CONTRACT_VERSION,
  FALLBACK_MESSAGE,
  MAX_BASE_FILE_BYTES,
  NOTICE_AUGMENTED,
  NOTICE_GENERATED,
  buildDiscoveryReport,
  buildPerformanceReport,
  enforceDeadline,
  readSafeFile,
  stopClock,
  writeSessionFile,
  type ContextPacket,
  type EvalResult,
  type EvaluationReport,
  type Evidence,
  type GeneratedSkill,
  type SessionState,
} from "@dynamic-skills/core";
import { isActivatable } from "@dynamic-skills/eval-engine";

/** Why activation was refused; the original task continues with existing capabilities. */
export type RefusalReason =
  | "timeout"
  | "blocked-by-clarification"
  | "base-changed"
  | "evaluation-failed"
  | "behavioural-missing";

/**
 * Outcome of {@link activate}. On success `skillPath`/`content` are always the session skill (new
 * skill or augmentation); `base` is non-null only for `augmented`, and `loadOrder` lists the files
 * to load, base first (PRD §5.5: the augmentation is activated together with the unchanged base).
 */
export type ActivationResult =
  | {
      activated: true;
      kind: "generated" | "augmented";
      skillPath: string;
      content: string;
      base: { name: string; path: string; content: string } | null;
      loadOrder: string[];
      limitations: string[];
      notice: string;
    }
  | { activated: false; reason: RefusalReason; fallback: string };

/** Input to {@link activate}. */
export interface ActivationInput {
  /** Session state; mutated in place (status, outcome, `metrics.activationMs`). The caller saves it. */
  state: SessionState;
  /** Absolute session directory; the only place this function writes or deletes. */
  sessionDir: string;
  /** The parsed session skill, or `null` when none exists. */
  skill: GeneratedSkill | null;
  /** The generation evaluation report, or `null` when none was produced. */
  report: EvaluationReport | null;
  /** The recorded behavioural result, if any. */
  behavioural: EvalResult | undefined;
  /** The Context Packet, for the discovery report. */
  packet: ContextPacket | null;
  /** All session evidence, for the discovery report. */
  evidence: Evidence[];
  /** Epoch ms used for the deadline check and the performance report. */
  now: number;
}

function refuse(reason: RefusalReason): ActivationResult {
  return { activated: false, reason, fallback: FALLBACK_MESSAGE };
}

/**
 * Reads the base skill and checks it against the sha256 pinned at the verdict. The base is only
 * ever read (PRD §5.5, FR-42), through the shared safe reader: one non-blocking handle, a regular
 * file named `SKILL.md` after symlink resolution, within the size cap. The hash is of the exact
 * bytes returned, so a change between the verdict and the read cannot slip through.
 *
 * @returns The base, or `null` when it is missing, unreadable, unsafe, too large or changed.
 */
async function readUnchangedBase(
  baseSkill: { name: string; path: string; sha256: string } | null,
): Promise<{ name: string; path: string; content: string } | null> {
  if (baseSkill === null) return null;
  const read = await readSafeFile(baseSkill.path, {
    maxBytes: MAX_BASE_FILE_BYTES,
    realBasename: "SKILL.md",
  });
  if (!read.ok || read.sha256 !== baseSkill.sha256) return null;
  return { name: baseSkill.name, path: baseSkill.path, content: read.text };
}

/** Writes `reports/*.json`, all carrying `schemaVersion` (PRD §10.8, §13.2). */
async function writeReports(input: ActivationInput): Promise<void> {
  const { state, sessionDir, report, behavioural, packet, evidence, now } = input;
  // Session data is private and the write must not follow a symlink: every file goes through
  // writeSessionFile (atomic, 0600, parents 0700, HOME_UNSAFE on a symlinked component).
  const put = (name: string, doc: unknown): Promise<string> =>
    writeSessionFile(sessionDir, `reports/${name}`, `${JSON.stringify(doc, null, 2)}\n`);
  await Promise.all([
    put("discovery.json", buildDiscoveryReport(state, packet, evidence)),
    put(
      "assumptions.json",
      AssumptionsReportSchema.parse({ schemaVersion: CONTRACT_VERSION, items: state.assumptions }),
    ),
    // Keep the recorded behavioural result inside the evaluation report.
    ...(report ? [put("evaluation.json", { ...report, behavioural })] : []),
  ]);
  // `performance.json` goes last: it is the only file `report perf` reads, so a failed write
  // above never leaves a counted report behind for a session whose state is discarded.
  await put("performance.json", buildPerformanceReport(state, now));
}

/**
 * Gated, ephemeral activation with a timeout fallback (PRD §5.5, §10.7, §11.1, §11.3).
 *
 * Checks, in order: deadline, pending clarifications, base integrity (augmentation only), the
 * evaluation report, then the behavioural result. Every outcome sets `metrics.activationMs`,
 * `status`, `metrics.outcome` and writes the reports. A timeout also deletes `<sessionDir>/skills/`
 * (an unvalidated skill is never kept) while keeping the evidence, packet and analysis files
 * ("preserve verified context"). Nothing outside `sessionDir` is written, and the base skill is
 * never modified. The `sufficient` outcome never reaches here; it is returned by the sufficiency
 * step.
 *
 * @param input - See {@link ActivationInput}.
 * @returns The activation payload, or a refusal with a fallback message.
 * @throws {UnsafeHomeError} (`HOME_UNSAFE`) when `reports` or its path is a symbolic link.
 * @throws If a report file cannot be written.
 */
export async function activate(input: ActivationInput): Promise<ActivationResult> {
  const started = Date.now();
  const { state, now } = input;
  const gate = await checkGates(input);
  let result: ActivationResult;

  if ("refusal" in gate) {
    result = refuse(gate.refusal);
    // enforceDeadline already marked a timeout; every other refusal is a failure.
    if (gate.refusal !== "timeout") {
      state.status = "failed";
      state.metrics.outcome = "failed";
    }
  } else {
    const { skill, report, behavioural, base } = gate;
    const limitations = [
      ...report.limitations,
      ...(behavioural.outcome === "warning" ? behavioural.messages : []),
    ];
    state.status = limitations.length > 0 ? "warning" : "completed";
    state.metrics.outcome = base ? "augmented" : "activated";
    result = {
      activated: true,
      kind: base ? "augmented" : "generated",
      skillPath: skill.skillMdPath,
      content: skill.raw,
      base,
      loadOrder: base ? [base.path, skill.skillMdPath] : [skill.skillMdPath],
      limitations,
      notice: base ? NOTICE_AUGMENTED : NOTICE_GENERATED,
    };
  }

  state.metrics.activationMs = Date.now() - started;
  // Every outcome ends the session: freeze the clock so the report's active time is final.
  stopClock(state, now);
  await writeReports(input);
  return result;
}

/** Result of {@link checkGates}: the first refusal, or everything the success branch needs. */
type GateOutcome =
  | { refusal: RefusalReason }
  | {
      skill: GeneratedSkill;
      report: EvaluationReport;
      behavioural: EvalResult;
      base: { name: string; path: string; content: string } | null;
    };

/**
 * Runs the activation gates in order (deadline, pending clarifications, base integrity, evaluation
 * report, behavioural result) and returns the first refusal, or the validated inputs. A timeout
 * also deletes `<sessionDir>/skills/`.
 */
async function checkGates(input: ActivationInput): Promise<GateOutcome> {
  const { state, sessionDir, skill, report, behavioural, now } = input;
  const sufficiency = state.sufficiency;
  if (enforceDeadline(state, now)) {
    await rm(join(sessionDir, "skills"), { recursive: true, force: true });
    return { refusal: "timeout" };
  }
  if (state.blockedBy.length > 0) return { refusal: "blocked-by-clarification" };
  let base: { name: string; path: string; content: string } | null = null;
  if (sufficiency?.outcome === "partial") {
    base = await readUnchangedBase(sufficiency.baseSkill);
    if (base === null) return { refusal: "base-changed" };
  }
  if (report === null || skill === null || !report.activatable) {
    return { refusal: "evaluation-failed" };
  }
  if (behavioural === undefined) return { refusal: "behavioural-missing" };
  if (!isActivatable(report, behavioural)) return { refusal: "evaluation-failed" };
  return { skill, report, behavioural, base };
}
