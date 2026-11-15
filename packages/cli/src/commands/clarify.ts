import { ClarificationManager } from "@dynamic-skills/clarification-manager";
import { recomputeGaps } from "@dynamic-skills/context-analyzer";
import { ClarificationRequestSchema, ClarificationResponseSchema } from "@dynamic-skills/core";
import { EvidenceRegistry } from "@dynamic-skills/evidence-registry";
import {
  CliError,
  FALLBACK,
  parseDocument,
  readEvidence,
  readInputFile,
  writeEvidence,
} from "../io";
import type { SessionCommandDef } from "./types";

/**
 * `clarify ask`: proposes a round of questions for the user (PRD §10.4). The manager filters out
 * what discovery can answer and pauses the SLA when at least one question is accepted. A call that
 * accepts nothing records no step, so the agent can still compile or ask a better question.
 */
export const clarifyAskCommand: SessionCommandDef = {
  name: "clarify ask",
  kind: "session",
  description: "Ask the user clarification questions (pauses the SLA).",
  options: [{ flags: "--file <path>", description: "Clarification request JSON.", required: true }],
  step: "clarify-ask",
  stage: "clarification",
  async run({ store, state, opts, cwd, now }) {
    const request = parseDocument(
      ClarificationRequestSchema,
      await readInputFile(cwd, String(opts.file)),
    );
    const registry = EvidenceRegistry.fromJSON(await readEvidence(store, state.id));
    const result = new ClarificationManager(state, registry).ask(request.questions, now());
    return {
      recordStep: result.accepted.length > 0,
      data: { round: result.round, accepted: result.accepted, rejected: result.rejected },
    };
  },
};

/**
 * `clarify answer`: applies the user's replies (PRD §10.3, §10.6). When a blocking question is
 * left unresolved (declined, skipped or unanswered), `state.blockedBy` can never clear and
 * activation would be refused, so the session ends here (Ruling R20): status `completed`, outcome
 * `skipped`, terminal reports written, and stdout carries the `fallback`, as for a declined
 * approval. An answered question whose
 * requirement is human-only also yields `user.<requirement>` evidence (Ruling R7), the key gap
 * analysis looks for; that alias shares a namespace with `user.<questionId>`, so it is added only
 * when it differs from the question id and never overrides an existing different value.
 */
export const clarifyAnswerCommand: SessionCommandDef = {
  name: "clarify answer",
  kind: "session",
  description: "Record the user's answers (resumes the SLA).",
  options: [
    { flags: "--file <path>", description: "Clarification response JSON.", required: true },
  ],
  step: "clarify-answer",
  stage: "clarification",
  async run({ store, state, opts, cwd, now }) {
    const response = parseDocument(
      ClarificationResponseSchema,
      await readInputFile(cwd, String(opts.file)),
    );
    const registry = EvidenceRegistry.fromJSON(await readEvidence(store, state.id));
    const asked = new Map(state.clarification.asked.map((q) => [q.id, q]));
    let result;
    try {
      result = new ClarificationManager(state, registry).answer(response.answers, now());
    } catch (e) {
      // The manager validates before mutating: unknown or blank answers are the caller's mistake.
      throw new CliError("USAGE", e instanceof Error ? e.message : "Invalid answers.");
    }

    const evidenceAdded = [...result.evidenceAdded];
    const warnings: string[] = [];
    for (const key of result.evidenceAdded) {
      const question = asked.get(key.slice("user.".length));
      if (!question || question.requirement === question.id) continue;
      const requirement = state.requirements.find((r) => r.id === question.requirement);
      if (!requirement?.humanOnly) continue;
      const alias = `user.${question.requirement}`;
      const value = registry.get(key)?.value;
      const existing = registry.get(alias);
      if (existing !== undefined && existing.value !== value) {
        warnings.push(`${alias} already holds a different value; the new answer was not aliased`);
        continue;
      }
      registry.add({
        key: alias,
        value: value ?? "",
        category: "user",
        source: "user",
        confidence: "verified",
        revision: state.revision,
        origin: "user",
      });
      if (!evidenceAdded.includes(alias)) evidenceAdded.push(alias);
    }

    state.gaps = recomputeGaps(state.requirements, registry.toJSON(), true);
    await writeEvidence(store, state.id, registry.toJSON());
    const blocked = state.blockedBy.length > 0;
    if (blocked) {
      state.status = "completed";
      state.metrics.outcome = "skipped";
    }
    return {
      writeReports: blocked,
      data: {
        evidenceAdded,
        assumptions: result.assumptions,
        blockingUnresolved: result.blockingUnresolved,
        warnings,
        ...(blocked ? { fallback: FALLBACK } : {}),
      },
    };
  },
};
