import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AssumptionsReportSchema,
  CONTRACT_VERSION,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  buildDiscoveryReport,
  buildPerformanceReport,
  enforceDeadline,
  type ContextPacket,
  type EvalResult,
  type EvaluationReport,
  type Evidence,
  type GeneratedSkill,
  type SessionState,
} from "@dynamic-skills/core";
import { isActivatable } from "@dynamic-skills/eval-engine";
import { fingerprintFile } from "@dynamic-skills/evidence-registry";

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

const FALLBACK = "Continue the original task with existing capabilities.";
const NOTICE_GENERATED =
  "Apply the skill below to the current task. It is ephemeral and lives only in this session.";
const NOTICE_AUGMENTED =
  "Load the unchanged base skill first, then this augmentation, and apply both to the current task. The augmentation is ephemeral and lives only in this session.";

function refuse(reason: RefusalReason): ActivationResult {
  return { activated: false, reason, fallback: FALLBACK };
}

/**
 * Reads the base skill and checks it against the sha256 pinned at the verdict. The base is only
 * ever read (PRD §5.5, FR-42). The content is hashed again after reading so a change between the
 * fingerprint and the read cannot slip through.
 *
 * @returns The base, or `null` when it is missing, unreadable or changed.
 */
async function readUnchangedBase(
  baseSkill: { name: string; path: string; sha256: string } | null,
): Promise<{ name: string; path: string; content: string } | null> {
  if (baseSkill === null) return null;
  try {
    if ((await fingerprintFile(baseSkill.path)) !== baseSkill.sha256) return null;
    const bytes = await readFile(baseSkill.path);
    if (createHash("sha256").update(bytes).digest("hex") !== baseSkill.sha256) return null;
    return { name: baseSkill.name, path: baseSkill.path, content: bytes.toString("utf8") };
  } catch {
    return null;
  }
}

/** Writes `reports/*.json`, all carrying `schemaVersion` (PRD §10.8, §13.2). */
async function writeReports(input: ActivationInput): Promise<void> {
  const { state, sessionDir, report, behavioural, packet, evidence, now } = input;
  const reports = join(sessionDir, "reports");
  // Session data is private: owner-only directory and files, like every SessionStore write.
  await mkdir(reports, { recursive: true, mode: PRIVATE_DIR_MODE });
  const put = (name: string, doc: unknown): Promise<void> =>
    writeFile(join(reports, name), `${JSON.stringify(doc, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
    });
  await Promise.all([
    put("performance.json", buildPerformanceReport(state, now)),
    put("discovery.json", buildDiscoveryReport(state, packet, evidence)),
    put(
      "assumptions.json",
      AssumptionsReportSchema.parse({ schemaVersion: CONTRACT_VERSION, items: state.assumptions }),
    ),
    // Keep the recorded behavioural result inside the evaluation report.
    ...(report ? [put("evaluation.json", { ...report, behavioural })] : []),
  ]);
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
 * @throws If a report file cannot be written.
 */
export async function activate(input: ActivationInput): Promise<ActivationResult> {
  const started = Date.now();
  const { state, sessionDir, skill, report, behavioural, now } = input;
  const sufficiency = state.sufficiency;
  const augmenting = sufficiency?.outcome === "partial";
  let result: ActivationResult | undefined;
  let base: { name: string; path: string; content: string } | null = null;

  if (enforceDeadline(state, now)) {
    await rm(join(sessionDir, "skills"), { recursive: true, force: true });
    result = refuse("timeout");
  } else if (state.blockedBy.length > 0) {
    result = refuse("blocked-by-clarification");
  } else if (augmenting && !(base = await readUnchangedBase(sufficiency.baseSkill))) {
    result = refuse("base-changed");
  } else if (report === null || skill === null || !report.activatable) {
    result = refuse("evaluation-failed");
  } else if (behavioural === undefined) {
    result = refuse("behavioural-missing");
  } else if (!isActivatable(report, behavioural)) {
    result = refuse("evaluation-failed");
  }

  if (result === undefined && report && skill) {
    const limitations = [
      ...report.limitations,
      ...(behavioural?.outcome === "warning" ? behavioural.messages : []),
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
  } else if (state.status !== "timeout") {
    // enforceDeadline already marked a timeout; every other refusal is a failure.
    state.status = "failed";
    state.metrics.outcome = "failed";
  }

  state.metrics.activationMs = Date.now() - started;
  await writeReports(input);
  return result ?? refuse("evaluation-failed");
}
