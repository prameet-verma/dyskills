import {
  matchBaseSkill,
  requiresApproval,
  validateSufficiency,
} from "@dynamic-skills/bootstrapper";
import {
  CONTRACT_VERSION,
  FALLBACK_MESSAGE,
  REUSE_NOTICE,
  SkillSufficiencyAssessmentSchema,
  SkillsScanSchema,
  SlaClock,
  SufficiencyReportSchema,
} from "@dynamic-skills/core";
import type {
  SessionState,
  SessionStore,
  SkillSufficiencyAssessment,
  SufficiencyReport,
} from "@dynamic-skills/core";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CliError,
  baseFailure,
  parseDocument,
  readBaseInstructionFile,
  readBaseSkillFile,
  readInputFile,
  requireArtifactJson,
  toJson,
} from "../io";
import type { SessionCommandDef } from "./types";

/** Shown to the agent with a reused skill (PRD §5.5: reuse is unchanged, no compile, no evals). */

/** Shown when the user declines synthesis in suggest mode (PRD §5.4). */

/**
 * Builds `reports/sufficiency.json` from the recorded verdict (PRD §5.5). Validates before
 * returning so a contract drift fails loudly instead of writing a bad report.
 */
function buildSufficiencyReport(
  state: SessionState,
  verdict: SkillSufficiencyAssessment,
): SufficiencyReport {
  const s = state.sufficiency;
  if (s === null) throw new CliError("INTERNAL", "No sufficiency verdict is recorded.");
  return SufficiencyReportSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    outcome: s.outcome,
    baseSkill: s.baseSkill,
    baseInstructionFile: s.baseInstructionFile,
    rationale: verdict.rationale,
    missingAspects: verdict.missingAspects,
    coveredAspects: verdict.coveredAspects,
    mode: state.mode,
    explicit: state.explicit,
    approval: s.approval,
  });
}

/** Writes `reports/sufficiency.json` from an already built and validated report. */
async function writeSufficiencyReport(
  store: SessionStore,
  id: string,
  report: SufficiencyReport,
): Promise<void> {
  await store.writeArtifact(id, "reports/sufficiency.json", toJson(report));
}

/**
 * `sufficiency submit`: records the agent's verdict on whether an existing skill suffices
 * (PRD §5.5, FR-40). The verdict is validated against the scan, and the base is pinned by the
 * *scanned* path and its sha256 so later compilation and activation can detect a changed base
 * (Ruling R9). `sufficient` ends the session by reuse. A base is only ever read.
 */
export const sufficiencySubmitCommand: SessionCommandDef = {
  name: "sufficiency submit",
  kind: "session",
  description: "Submit the skill sufficiency verdict.",
  options: [
    { flags: "--file <path>", description: "Sufficiency assessment JSON.", required: true },
  ],
  step: "sufficiency-submit",
  stage: "assessment",
  async run({ store, state, opts, cwd, now }) {
    const verdict = parseDocument(
      SkillSufficiencyAssessmentSchema,
      await readInputFile(cwd, String(opts.file)),
    );
    const scan = await requireArtifactJson(store, state.id, "skills-scan.json", SkillsScanSchema);
    const issues = validateSufficiency(verdict, {
      skills: scan.skills,
      instructionFiles: scan.instructionFiles,
      mode: state.mode,
      explicit: state.explicit,
    });
    if (issues.length > 0) {
      throw new CliError("VERDICT_INVALID", "The verdict failed validation.", { issues });
    }

    let baseSkill: NonNullable<SessionState["sufficiency"]>["baseSkill"] = null;
    let reused: { path: string; content: string; notice: string } | null = null;
    if (verdict.baseSkill) {
      // Persist the scanned skill's path, never the verdict's string (Ruling R9, carry 3).
      const matched = matchBaseSkill(verdict.baseSkill, scan.skills);
      if (matched === null) throw new CliError("INTERNAL", "Validated base skill vanished.");
      const read = await readBaseSkillFile(matched.path);
      if (!read.ok) throw baseFailure("baseSkill", read);
      baseSkill = {
        name: matched.name,
        path: matched.path,
        sha256: read.sha256,
      };
      if (verdict.outcome === "sufficient") {
        reused = { path: matched.path, content: read.content, notice: REUSE_NOTICE };
      }
    }
    if (verdict.baseInstructionFile !== undefined) {
      const read = await readBaseInstructionFile(state.repo, verdict.baseInstructionFile);
      if (!read.ok) throw baseFailure("baseInstructionFile", read);
      if (verdict.outcome === "sufficient") {
        reused = {
          path: join(state.repo, verdict.baseInstructionFile),
          content: read.content,
          notice: REUSE_NOTICE,
        };
      }
    }

    const pending = requiresApproval(verdict.outcome, state.mode, state.explicit);
    state.sufficiency = {
      outcome: verdict.outcome,
      baseSkill,
      baseInstructionFile: verdict.baseInstructionFile ?? null,
      approval: pending ? "pending" : "not-required",
    };
    state.metrics.llmInteractions += 1;
    // Validate the report before the first write; session artifacts are written last so that a
    // failure leaves nothing behind (the wrapper saves nothing either).
    const report = buildSufficiencyReport(state, verdict);

    let next: "done" | "approve" | "clarify-or-compile" = "clarify-or-compile";
    if (verdict.outcome === "sufficient") {
      state.status = "completed";
      state.metrics.outcome = "reused";
      next = "done";
    } else if (pending) {
      // PRD §10.3: the SLA is paused while the human decides.
      const clock = SlaClock.from(state.sla);
      const at = now();
      clock.pause(at);
      state.sla = clock.snapshot(at);
      state.status = "waiting-for-approval";
      next = "approve";
    }
    try {
      await store.writeArtifact(state.id, "sufficiency.json", toJson(verdict));
      await writeSufficiencyReport(store, state.id, report);
    } catch (e) {
      const dir = store.dir(state.id);
      await rm(join(dir, "sufficiency.json"), { force: true }).catch(() => undefined);
      await rm(join(dir, "reports", "sufficiency.json"), { force: true }).catch(() => undefined);
      throw e;
    }
    return {
      writeReports: verdict.outcome === "sufficient",
      cleanup: async () => {
        const dir = store.dir(state.id);
        await rm(join(dir, "sufficiency.json"), { force: true });
        await rm(join(dir, "reports", "sufficiency.json"), { force: true });
      },
      data: {
        outcome: verdict.outcome,
        baseSkill,
        approval: state.sufficiency.approval,
        reused,
        next,
      },
    };
  },
};

/**
 * `sufficiency approve`: the user's decision in suggest mode (PRD §5.4, §10.3). Resumes the SLA
 * and books the wait as human time. Declining ends the session as `skipped`.
 */
export const sufficiencyApproveCommand: SessionCommandDef = {
  name: "sufficiency approve",
  kind: "session",
  description: "Record the user's approval decision (suggest mode).",
  options: [
    {
      flags: "--decision <decision>",
      description: "approve or decline.",
      required: true,
      choices: ["approve", "decline"],
    },
  ],
  step: "sufficiency-approve",
  stage: "assessment",
  async run({ store, state, opts, now }) {
    const decision = opts.decision;
    if (decision !== "approve" && decision !== "decline") {
      throw new CliError("USAGE", "--decision must be approve or decline.");
    }
    const verdict = await requireArtifactJson(
      store,
      state.id,
      "sufficiency.json",
      SkillSufficiencyAssessmentSchema,
    );
    const sufficiency = state.sufficiency;
    if (sufficiency === null) throw new CliError("INTERNAL", "No sufficiency verdict is recorded.");

    const clock = SlaClock.from(state.sla);
    const at = now();
    state.metrics.humanWaitMs += clock.resume(at);
    state.sla = clock.snapshot(at);
    if (decision === "approve") {
      sufficiency.approval = "approved";
      state.status = "resuming";
    } else {
      sufficiency.approval = "declined";
      state.status = "completed";
      state.metrics.outcome = "skipped";
    }
    await writeSufficiencyReport(store, state.id, buildSufficiencyReport(state, verdict));
    return {
      writeReports: decision === "decline",
      data: {
        approval: sufficiency.approval,
        fallback: decision === "decline" ? FALLBACK_MESSAGE : null,
      },
    };
  },
};
